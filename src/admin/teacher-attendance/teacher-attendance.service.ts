import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from '../../database/database.service';
import { Role } from '@prisma/client';
import { AdminCalendarService } from '../calendar/calendar.service';
import { getTodayIstDateOnly } from '../../common/utils/date.util';
import { resolveWorkingDaysForDate } from '../../common/utils/working-days-history.util';

@Injectable()
export class AdminTeacherAttendanceService {
  private readonly logger = new Logger(AdminTeacherAttendanceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly schoolCalendar: AdminCalendarService,
  ) {}

  /**
   * Monday–Saturday in UTC — Sunday is the only automatic weekly off.
   * Schools here run six days a week; Saturday is a normal school day
   * unless a specific Saturday is declared Holiday/Break in the calendar.
   * (Aligned with the weekend skip in markMissing/markAbsentForToday below.)
   */
  private isRegularSchoolDay(isoDateStr: string): boolean {
    const d = new Date(`${isoDateStr}T12:00:00.000Z`);
    return d.getUTCDay() !== 0;
  }

  /**
   * A school's actual working-day calendar for a month: every weekday minus
   * declared Holiday/Break dates, plus CompensatoryWork dates worked on a
   * normal off-day. This is the single source of truth for "total working
   * days" — previously it was inferred from whichever Attendance rows
   * happened to exist, so a festival or a same-day bandh that nobody had
   * marked attendance for still got counted as a working day (and any
   * "Mark Missing" run over that range created bogus Unreported/Absent
   * rows for it). Deriving it from SchoolCalendar means an admin adding a
   * holiday entry — even after the fact, e.g. an announced bandh —
   * immediately and retroactively corrects the denominator with no manual
   * cleanup of Attendance rows required.
   */
  private async getWorkingDaySet(
    schoolId: string,
    year: number,
    month: number,
  ): Promise<Set<string>> {
    const [holidayEntries, compDates] = await Promise.all([
      this.schoolCalendar.getHolidayDatesForMonth(schoolId, year, month),
      this.schoolCalendar.getCompensatoryDatesForMonth(schoolId, year, month),
    ]);
    // HalfDay is still a working day (just shorter hours) — only Holiday
    // and Break actually remove a date from the working calendar.
    const offDates = new Set(
      holidayEntries
        .filter((e) => e.type === 'Holiday' || e.type === 'Break')
        .map((e) => e.date),
    );
    const compSet = new Set(compDates);

    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0));
    // For the CURRENT month, never walk past today — a not-yet-happened
    // working day has no Attendance row yet and would otherwise sit in the
    // denominator as an automatic miss, deflating attendance_percentage
    // (mirrors the same fix in teacher/attendance/attendance.service.ts's
    // getScheduledWorkingDates, which this admin-side calendar-set builder
    // independently duplicates).
    const now = new Date();
    const walkEnd =
      year === now.getUTCFullYear() && month === now.getUTCMonth() + 1
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
        : end;
    const workingDays = new Set<string>();
    for (
      const d = new Date(start);
      d <= end && d <= walkEnd;
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      const dateStr = d.toISOString().split('T')[0];
      const isRegularDay = this.isRegularSchoolDay(dateStr);
      if ((isRegularDay && !offDates.has(dateStr)) || compSet.has(dateStr)) {
        workingDays.add(dateStr);
      }
    }
    return workingDays;
  }

  /**
   * Call-scoped cache so N teachers at the same school (within one
   * `monthly()`/`markMissing()` call) share a single calendar lookup instead
   * of re-querying per teacher. Passed in explicitly rather than stored on
   * `this` — the service is a singleton, so an instance-level cache would
   * leak across requests and never see calendar edits made mid-lifetime.
   */
  private getWorkingDaySetCached(
    cache: Map<string, Promise<Set<string>>>,
    schoolId: string,
    year: number,
    month: number,
  ): Promise<Set<string>> {
    const key = `${schoolId}:${year}-${month}`;
    let cached = cache.get(key);
    if (!cached) {
      cached = this.getWorkingDaySet(schoolId, year, month);
      cache.set(key, cached);
    }
    return cached;
  }

  /**
   * Narrows a school's calendar-derived working-day set down to just the
   * dates a specific teacher was actually assigned to work at that school —
   * resolved per DAY against TeacherWorkingDaysHistory (0=Sun..6=Sat), not a
   * single static array. This is what makes a mid-month change (e.g.
   * Mon-Thu -> Mon-Fri effective the 16th) apply only from its effective
   * date forward: days 1-15 resolve against the old pattern, 16-end against
   * the new one, instead of one flat array retroactively covering the month.
   */
  private intersectByHistory(
    workingSet: Set<string>,
    history: Array<{ effectiveFrom: Date; workingDays: number[] }>,
  ): Set<string> {
    const result = new Set<string>();
    for (const dateStr of workingSet) {
      const date = new Date(`${dateStr}T12:00:00.000Z`);
      const days = resolveWorkingDaysForDate(history, date);
      if (days.includes(date.getUTCDay())) result.add(dateStr);
    }
    return result;
  }

  /** Fetches TeacherWorkingDaysHistory for one teacher+school, up to (and including) `uptoDate`. */
  private async getWorkingDaysHistory(
    teacherId: number,
    schoolId: string,
    uptoDate: Date,
  ): Promise<Array<{ effectiveFrom: Date; workingDays: number[] }>> {
    const rows = await this.db.teacherWorkingDaysHistory.findMany({
      where: { teacherId, schoolId, effectiveFrom: { lte: uptoDate } },
      select: { effectiveFrom: true, workingDays: true },
      orderBy: { effectiveFrom: 'asc' },
    });
    return rows;
  }

  private attendanceStatusPriority(status: string): number {
    switch (status) {
      case 'Present':
        return 5;
      case 'Leave-Approved':
        return 4;
      case 'Absent':
        return 3;
      case 'Unreported':
        return 2;
      default:
        return 1;
    }
  }

  /** When a teacher has multiple schools, pick the strongest status for today. */
  private pickTodayAttendanceStatus(rows: { status: string }[]): string | null {
    if (!rows.length) return null;
    let best = rows[0].status;
    let p = this.attendanceStatusPriority(best);
    for (const r of rows) {
      const pr = this.attendanceStatusPriority(r.status);
      if (pr > p) {
        p = pr;
        best = r.status;
      }
    }
    return best;
  }

  private toDateOnly(dateStr: string): Date {
    const d = new Date(dateStr + 'T12:00:00.000Z');
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  /**
   * List all teachers with today's attendance summary and per-teacher status.
   * If teacherId is provided, returns attendance records for that teacher only.
   */
  async list(schoolId?: string, teacherId?: string, from?: string, to?: string) {
    if (teacherId) {
      const tid = parseInt(teacherId, 10);
      if (isNaN(tid))
        return { summary: null, teacherTodayStatus: {}, teacherTodaySchoolStatuses: {}, attendance: [] };
      const dateFilter: { gte?: Date; lte?: Date } = {};
      if (from) dateFilter.gte = new Date(`${from}T00:00:00.000Z`);
      if (to) dateFilter.lte = new Date(`${to}T23:59:59.999Z`);
      const records = await this.db.attendance.findMany({
        where: {
          teacherId: tid,
          ...(from || to ? { date: dateFilter } : {}),
        },
        orderBy: { date: 'desc' },
        take: 365,
      });
      return {
        summary: null,
        teacherTodayStatus: {},
        teacherTodaySchoolStatuses: {},
        attendance: records.map((r) => ({
          id: r.id,
          teacher_id: r.teacherId,
          school_id: r.schoolId,
          date: r.date.toISOString().split('T')[0],
          status: r.status,
        })),
      };
    }
    const users = await this.db.user.findMany({
      where: { role: Role.teacher },
      include: { profile: true, teacherSchools: { include: { school: true } } },
    });
    const filtered = schoolId
      ? users.filter((u) =>
          u.teacherSchools.some((ts) => ts.schoolId === schoolId),
        )
      : users;
    const today = getTodayIstDateOnly();
    const todayEnd = new Date(today);
    todayEnd.setUTCHours(23, 59, 59, 999);

    const activeTeachers = filtered.filter((u) => u.isActive);
    const teacherIds = activeTeachers.map((u) => u.id);
    const attendances = await this.db.attendance.findMany({
      where: {
        teacherId: { in: teacherIds },
        date: { gte: today, lte: todayEnd },
      },
    });
    const attendanceRowsByTeacher = new Map<number, typeof attendances>();
    for (const a of attendances) {
      if (!attendanceRowsByTeacher.has(a.teacherId))
        attendanceRowsByTeacher.set(a.teacherId, []);
      attendanceRowsByTeacher.get(a.teacherId)!.push(a);
    }
    const leaves = await this.db.teacherLeave.findMany({
      where: {
        teacherId: { in: teacherIds },
        startDate: { lte: todayEnd },
        endDate: { gte: today },
        status: 'approved',
      },
    });

    // Today's date-in-words per distinct school, so a teacher isn't marked
    // "Absent / Not marked" on a declared holiday (festival, break, or a
    // same-day bandh entered by the admin this morning). Fetches
    // one month's calendar per school and keeps only today's date.
    const todayStr = today.toISOString().split('T')[0];
    const schoolIdsForToday = [
      ...new Set(filtered.flatMap((u) => u.teacherSchools.map((ts) => ts.schoolId))),
    ];
    const holidaySchoolIdsToday = new Set<string>();
    await Promise.all(
      schoolIdsForToday.map(async (sid) => {
        const entries = await this.schoolCalendar.getHolidayDatesForMonth(
          sid,
          today.getUTCFullYear(),
          today.getUTCMonth() + 1,
        );
        const isHolidayToday = entries.some(
          (e) => e.date === todayStr && (e.type === 'Holiday' || e.type === 'Break'),
        );
        if (isHolidayToday) holidaySchoolIdsToday.add(sid);
      }),
    );
    const isTeacherOnHolidayToday = (u: (typeof filtered)[number]) =>
      u.teacherSchools.length > 0 &&
      u.teacherSchools.every((ts) => holidaySchoolIdsToday.has(ts.schoolId));

    // A teacher isn't expected today if today's weekday isn't in whichever
    // working-days pattern is currently in effect at the relevant school(s)
    // — resolved from TeacherWorkingDaysHistory (not the static "current"
    // TeacherSchool.workingDays) so a same-day effective change is honored
    // immediately. Scoped to just the filtered school when one is passed,
    // otherwise "not scheduled at ANY of their schools today."
    const todayHistoryPairs = filtered.flatMap((u) =>
      u.teacherSchools.map((ts) => ({ teacherId: u.id, schoolId: ts.schoolId })),
    );
    const todayHistoryByPair = new Map(
      await Promise.all(
        todayHistoryPairs.map(
          async ({ teacherId, schoolId }) =>
            [
              `${teacherId}-${schoolId}`,
              await this.getWorkingDaysHistory(teacherId, schoolId, today),
            ] as const,
        ),
      ),
    );
    const isTeacherOffToday = (u: (typeof filtered)[number]) => {
      const relevantSchools = schoolId
        ? u.teacherSchools.filter((ts) => ts.schoolId === schoolId)
        : u.teacherSchools;
      if (relevantSchools.length === 0) return false;
      return relevantSchools.every((ts) => {
        const history = todayHistoryByPair.get(`${u.id}-${ts.schoolId}`) ?? [];
        const days = resolveWorkingDaysForDate(history, today);
        return !days.includes(todayDayOfWeek);
      });
    };

    // Which of a teacher's schools they're actually scheduled at *today* —
    // a teacher covering 2-3 schools across the week only has one (or
    // occasionally two, same-day) school expecting them on any given day.
    // Used below to show a per-school status only for the rare case where
    // a teacher has 2+ schools scheduled the same day (otherwise a single
    // merged badge, unchanged from before, since there's nothing to merge).
    const [y, m, d] = todayStr.split('-').map(Number);
    const todayDayOfWeek = new Date(y, m - 1, d).getDay();
    const todaySchedules = await this.db.classSchedule.findMany({
      where: { dayOfWeek: todayDayOfWeek, isActive: true, schoolId: { in: schoolIdsForToday } },
      select: { teacherId: true, schoolId: true },
    });
    const scheduledSchoolIdsByTeacher = new Map<number, Set<string>>();
    for (const s of todaySchedules) {
      if (!s.teacherId) continue;
      if (!scheduledSchoolIdsByTeacher.has(s.teacherId)) {
        scheduledSchoolIdsByTeacher.set(s.teacherId, new Set());
      }
      scheduledSchoolIdsByTeacher.get(s.teacherId)!.add(s.schoolId);
    }

    const onLeaveTeacherIds = new Set(leaves.map((l) => l.teacherId));
    let presentToday = 0;
    let absentToday = 0;
    let onLeaveToday = 0;
    let onHolidayToday = 0;
    let offToday = 0;
    const teacherTodayStatus: Record<
      string,
      {
        status: string;
        isOnLeave: boolean;
        leaveType?: string;
        attendanceRate?: number;
      }
    > = {};
    // Only populated for teachers scheduled at 2+ schools on the same day —
    // the single-school case (the vast majority) has nothing to distinguish,
    // so the existing merged `teacherTodayStatus` badge covers it unchanged.
    const teacherTodaySchoolStatuses: Record<
      string,
      Array<{ school_id: string; school_name: string; status: string }>
    > = {};

    const perSchoolStatus = (
      u: (typeof filtered)[number],
      schoolId: string,
      isOnLeave: boolean,
    ): string => {
      const row = (attendanceRowsByTeacher.get(u.id) ?? []).find(
        (r) => r.schoolId === schoolId,
      );
      if (row?.status === 'Present') return 'Present';
      if (holidaySchoolIdsToday.has(schoolId)) return 'Holiday';
      if (isOnLeave || row?.status === 'Leave-Approved') return 'On Leave';
      if (row?.status === 'Absent') return 'Absent';
      return 'Not Marked';
    };

    for (const u of filtered) {
      if (!u.isActive) {
        teacherTodayStatus[String(u.id)] = {
          status: 'Inactive',
          isOnLeave: false,
        };
        continue;
      }
      const rows = attendanceRowsByTeacher.get(u.id) ?? [];
      const picked = this.pickTodayAttendanceStatus(rows);
      const isOnLeave = onLeaveTeacherIds.has(u.id);
      let status = 'Not Marked';
      // Present from attendance overrides holiday/leave (teacher marked in
      // e.g. compensatory work), same as it already overrides leave below.
      if (picked === 'Present') {
        status = 'Present';
        presentToday++;
      } else if (isTeacherOnHolidayToday(u)) {
        status = 'Holiday';
        onHolidayToday++;
      } else if (isTeacherOffToday(u)) {
        status = 'Off Today';
        offToday++;
      } else if (isOnLeave) {
        status = 'On Leave';
        onLeaveToday++;
      } else if (picked === 'Leave-Approved') {
        status = 'On Leave';
        onLeaveToday++;
      } else if (picked === 'Unreported' || !picked) {
        status = 'Not Marked';
        absentToday++;
      } else {
        status = picked;
        absentToday++;
      }
      teacherTodayStatus[String(u.id)] = {
        status,
        isOnLeave: status === 'On Leave',
      };

      const scheduledToday = scheduledSchoolIdsByTeacher.get(u.id);
      if (scheduledToday && scheduledToday.size > 1) {
        teacherTodaySchoolStatuses[String(u.id)] = u.teacherSchools
          .filter((ts) => scheduledToday.has(ts.schoolId))
          .map((ts) => ({
            school_id: ts.schoolId,
            school_name: ts.school?.name ?? 'School',
            status: perSchoolStatus(u, ts.schoolId, isOnLeave),
          }));
      }
    }

    const totalTeachers = filtered.length;
    const activeCount = activeTeachers.length;
    // Teachers on holiday, or simply not scheduled today per their assigned
    // weekdays, aren't expected to be present — excluded from the rate's
    // denominator rather than counted as absent.
    const expectedTodayCount = Math.max(0, activeCount - onHolidayToday - offToday);
    const attendanceRate =
      expectedTodayCount > 0
        ? Math.round((presentToday / expectedTodayCount) * 100)
        : 0;

    // `attendanceRate` above is a same-day snapshot (today's present/expected
    // ratio) — it reads 0% on any day nobody's checked in yet, regardless of
    // a teacher's actual attendance history, which is misleading as an "Avg
    // Attendance" figure. Reuse the same month-to-date percentage that backs
    // the Attendance tab (computeAttendanceMetrics via monthly()) so the
    // dashboard's "Avg Attendance" card reflects a real average instead.
    const { monthlyData: monthToDateData } = await this.monthly(undefined, schoolId);
    const ratedMonthEntries = monthToDateData.filter((m) => m.total_working_days > 0);
    const averageAttendanceRate =
      ratedMonthEntries.length > 0
        ? Math.round(
            ratedMonthEntries.reduce((sum, m) => sum + m.attendance_percentage, 0) /
              ratedMonthEntries.length,
          )
        : 0;

    return {
      summary: {
        totalTeachers,
        presentToday,
        absentToday,
        onLeaveToday,
        onHolidayToday,
        offToday,
        attendanceRate,
        averageAttendanceRate,
      },
      teacherTodayStatus,
      teacherTodaySchoolStatuses,
      attendance: attendances.map((a) => ({
        id: a.id,
        teacher_id: a.teacherId,
        school_id: a.schoolId,
        date: a.date.toISOString().split('T')[0],
        status: a.status,
      })),
    };
  }

  /**
   * Get monthly attendance data (per teacher or aggregated) for a given month.
   */
  /**
   * Reduces raw Attendance/TeacherLeave rows (already scoped to one or more
   * schools) into the standard present/absent/leave/unreported/total-working
   * summary, entirely against `workingSet` — the school-calendar-derived
   * working-day set — rather than against whichever dates happen to have a
   * record. This is what makes a same-day holiday declaration retroactively
   * correct: nothing needs to be deleted, the read side just stops counting
   * that date once it's calendar-known.
   */
  private computeAttendanceMetrics(
    attendanceRecords: Array<{ status: string; date: Date }>,
    leaveRecords: Array<{ startDate: Date; endDate: Date }>,
    start: Date,
    end: Date,
    workingSet: Set<string>,
  ): {
    present_days: number;
    absent_days: number;
    leave_days: number;
    unreported_days: number;
    total_working_days: number;
    attendance_percentage: number;
  } {
    const isWorkingDay = (d: string) => workingSet.has(d);

    const presentDayDates = new Set(
      attendanceRecords
        .filter((a) => a.status === 'Present' && isWorkingDay(a.date.toISOString().split('T')[0]))
        .map((a) => a.date.toISOString().split('T')[0]),
    );
    const absentDayDates = new Set(
      attendanceRecords
        .filter((a) => a.status === 'Absent' && isWorkingDay(a.date.toISOString().split('T')[0]))
        .map((a) => a.date.toISOString().split('T')[0]),
    );
    const leaveDayDates = new Set<string>();
    leaveRecords.forEach((l) => {
      const overlapStart = l.startDate > start ? l.startDate : start;
      const overlapEnd = l.endDate < end ? l.endDate : end;
      const current = new Date(overlapStart);
      while (current <= overlapEnd) {
        const dateStr = current.toISOString().split('T')[0];
        if (isWorkingDay(dateStr) && !presentDayDates.has(dateStr) && !leaveDayDates.has(dateStr)) {
          leaveDayDates.add(dateStr);
        }
        current.setUTCDate(current.getUTCDate() + 1);
      }
    });

    for (const d of presentDayDates) absentDayDates.delete(d);
    for (const d of leaveDayDates) absentDayDates.delete(d);

    // Every working day not covered by present/absent/leave counts as
    // unreported — including days with NO Attendance row at all (e.g. a
    // historical date the daily marking cron never ran for). Deriving this
    // as the working-set complement, rather than only counting existing
    // rows literally stamped `status: 'Unreported'`, is what makes the
    // denominator (present+absent+leave+unreported) always equal
    // total_working_days.
    const unreportedDayDates = new Set<string>();
    for (const d of workingSet) {
      if (
        !presentDayDates.has(d) &&
        !absentDayDates.has(d) &&
        !leaveDayDates.has(d)
      ) {
        unreportedDayDates.add(d);
      }
    }

    const totalWorkingDays = workingSet.size;
    const presentDays = presentDayDates.size;

    return {
      present_days: presentDays,
      absent_days: absentDayDates.size,
      leave_days: leaveDayDates.size,
      unreported_days: unreportedDayDates.size,
      total_working_days: totalWorkingDays,
      attendance_percentage:
        totalWorkingDays > 0 ? Math.round((presentDays / totalWorkingDays) * 100) : 0,
    };
  }

  /**
   * Get monthly attendance data (per teacher or aggregated) for a given
   * month. A teacher who works at multiple schools in the same week (a
   * common real-world pattern — 1, 2, or 3 schools) gets:
   *  - combined figures across every school they're assigned to, by default
   *  - figures scoped to exactly one school, when `schoolId` is passed
   *  - a `by_school` breakdown array on each combined row (multi-school
   *    teachers only), so the UI can show "which school were they actually
   *    at" without a second request per school.
   */
  async monthly(month?: string, schoolId?: string) {
    const now = new Date();
    const year = month ? parseInt(month.slice(0, 4), 10) : now.getFullYear();
    const monthNum = month
      ? parseInt(month.slice(5, 7), 10)
      : now.getMonth() + 1;
    const start = new Date(Date.UTC(year, monthNum - 1, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(year, monthNum, 0, 23, 59, 59, 999));
    const monthKey = `${year}-${String(monthNum).padStart(2, '0')}`;

    const teachers = await this.db.user.findMany({
      where: {
        role: Role.teacher,
        isActive: true,
        ...(schoolId
          ? { teacherSchools: { some: { schoolId } } }
          : {}),
      },
      include: {
        profile: true,
        teacherSchools: { include: { school: true } },
      },
    });

    type SchoolMetrics = ReturnType<AdminTeacherAttendanceService['computeAttendanceMetrics']>;
    const monthlyData: Array<
      {
        id: string;
        teacher_id: string;
        month: string;
        profiles: { full_name: string; email: string };
        schools: { name: string; school_code: string };
        by_school?: Array<{ school_id: string; school_name: string; working_days: number[] } & SchoolMetrics>;
      } & SchoolMetrics
    > = [];

    // Shared across every teacher in this call so N teachers at the same
    // school reuse one SchoolCalendar lookup instead of querying per teacher.
    const calendarCache = new Map<string, Promise<Set<string>>>();

    for (const t of teachers) {
      const allSchoolIds = (t.teacherSchools ?? []).map((ts) => ts.schoolId);
      if (allSchoolIds.length === 0) continue;

      // When a schoolId filter is passed, every query and the working-day
      // calendar are scoped to just that school — previously the filter only
      // narrowed which teachers were listed, but still mixed in every other
      // school they belonged to when computing the numbers, so "filter to
      // this school" silently didn't work.
      const effectiveSchoolIds = schoolId ? [schoolId] : allSchoolIds;

      const displaySchool = schoolId
        ? t.teacherSchools.find((ts) => ts.schoolId === schoolId)
        : t.teacherSchools[0];
      const schoolName = displaySchool?.school?.name ?? '';
      const schoolCode = displaySchool?.school?.schoolCode ?? '';

      const [attendanceRecords, leaveRecords, workingSetEntries, historyEntries] = await Promise.all([
        this.db.attendance.findMany({
          where: {
            teacherId: t.id,
            schoolId: { in: effectiveSchoolIds },
            date: { gte: start, lte: end },
          },
        }),
        this.db.teacherLeave.findMany({
          where: {
            teacherId: t.id,
            schoolId: { in: effectiveSchoolIds },
            startDate: { lte: end },
            endDate: { gte: start },
            status: 'approved',
          },
        }),
        Promise.all(
          effectiveSchoolIds.map(async (sid) => [
            sid,
            await this.getWorkingDaySetCached(calendarCache, sid, year, monthNum),
          ] as const),
        ),
        Promise.all(
          effectiveSchoolIds.map(async (sid) => [
            sid,
            await this.getWorkingDaysHistory(t.id, sid, end),
          ] as const),
        ),
      ]);
      const historyBySchool = new Map(historyEntries);
      // Per-school working-day calendar (a school's declared holidays never
      // apply to a different school a co-teacher happens to also work at),
      // narrowed day-by-day to whichever working-days pattern was actually
      // in effect for this teacher at that school on each specific date —
      // see intersectByHistory for why this must be per-day, not one static
      // array covering the whole month.
      const workingSetBySchool = new Map(
        workingSetEntries.map(([sid, set]) => {
          const history = historyBySchool.get(sid) ?? [];
          return [sid, this.intersectByHistory(set, history)] as const;
        }),
      );

      // Combined figure: a date counts if it's a working day (for this
      // teacher) at ANY of the (effective) schools — replaces the old
      // "whatever dates happen to have an Attendance row" denominator with
      // the calendar itself, so festivals/breaks/sudden closures (declared
      // any time, even after the fact) are excluded automatically, and a
      // teacher's assigned weekdays per school now shape the total too.
      const combinedWorkingSet = new Set<string>();
      for (const set of workingSetBySchool.values()) {
        for (const d of set) combinedWorkingSet.add(d);
      }
      const combinedMetrics = this.computeAttendanceMetrics(
        attendanceRecords,
        leaveRecords,
        start,
        end,
        combinedWorkingSet,
      );

      // Per-school breakdown so "filter to check the working days for that
      // specific school" is answerable without a second request — only
      // computed when unfiltered and the teacher actually has >1 school
      // (the overwhelmingly common single-school case skips this for free).
      let bySchool: Array<{ school_id: string; school_name: string; working_days: number[] } & SchoolMetrics> | undefined;
      if (!schoolId && allSchoolIds.length > 1) {
        bySchool = allSchoolIds.map((sid) => {
          const set = workingSetBySchool.get(sid) ?? new Set<string>();
          const metrics = this.computeAttendanceMetrics(
            attendanceRecords.filter((a) => a.schoolId === sid),
            leaveRecords.filter((l) => l.schoolId === sid),
            start,
            end,
            set,
          );
          const ts = t.teacherSchools.find((x) => x.schoolId === sid);
          return {
            school_id: sid,
            school_name: ts?.school?.name ?? '',
            working_days: ts?.workingDays?.length ? ts.workingDays : [1, 2, 3, 4, 5],
            ...metrics,
          };
        });
      }

      monthlyData.push({
        id: `${t.id}-${monthKey}`,
        teacher_id: String(t.id),
        month: monthKey,
        ...combinedMetrics,
        profiles: {
          full_name: t.profile?.fullName ?? '',
          email: t.email,
        },
        schools: { name: schoolName, school_code: schoolCode },
        ...(bySchool ? { by_school: bySchool } : {}),
      });
    }

    return {
      monthlyData,
      month: monthKey,
    };
  }

  /**
   * Mark missing attendance: create Absent/Unreported records for teachers who had no report and no attendance on dates in range.
   */
  /**
   * Every Holiday/Break date for a school across a (possibly multi-month)
   * range, stitched from the month-scoped calendar lookup. Used to make
   * "Mark Missing" skip declared closures the same way weekends are already
   * skipped — otherwise clicking it over a range that includes a festival
   * or a same-day bandh entry creates bogus Unreported rows that permanently
   * (until this fix) drag that month's attendance percentage down.
   */
  private async getHolidayOffDatesForRange(
    schoolId: string,
    start: Date,
    end: Date,
  ): Promise<Set<string>> {
    const offDates = new Set<string>();
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    while (cursor <= endMonth) {
      const entries = await this.schoolCalendar.getHolidayDatesForMonth(
        schoolId,
        cursor.getUTCFullYear(),
        cursor.getUTCMonth() + 1,
      );
      for (const e of entries) {
        if (e.type === 'Holiday' || e.type === 'Break') offDates.add(e.date);
      }
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return offDates;
  }

  async markMissing(body: { start_date: string; end_date: string }) {
    const start = this.toDateOnly(body.start_date);
    const requestedEnd = this.toDateOnly(body.end_date);
    // Never pre-create "Unreported" rows for a day that hasn't happened yet
    // — e.g. running this for "the whole month" on the 26th used to also
    // sweep the 27th-31st, stamping them Unreported before the teacher had
    // any chance to submit a report for them (and, since every row in that
    // sweep landed in the same request, they all shared one identical
    // createdAt timestamp — the "Recorded At" values a teacher sees are
    // meant to reflect when each day was actually processed).
    const today = getTodayIstDateOnly();
    const end = requestedEnd < today ? requestedEnd : today;
    end.setUTCHours(23, 59, 59, 999);
    if (start > end) {
      return {
        summary: {
          records_created: 0,
          holidays_skipped: 0,
          teachers_affected: 0,
          dates_affected: 0,
        },
      };
    }

    const teachers = await this.db.teacherSchool.findMany({
      select: { teacherId: true, schoolId: true },
    });
    // Per (teacherId, schoolId) pair working-days history, resolved per-day
    // below — a mid-range change (e.g. Mon-Thu -> Mon-Fri effective halfway
    // through) must only create Unreported rows per the pattern that was
    // actually in effect on each specific date.
    const historyByPair = new Map(
      await Promise.all(
        teachers.map(
          async ({ teacherId, schoolId }) =>
            [
              `${teacherId}-${schoolId}`,
              await this.getWorkingDaysHistory(teacherId, schoolId, end),
            ] as const,
        ),
      ),
    );
    const existing = await this.db.attendance.findMany({
      where: { date: { gte: start, lte: end } },
    });
    const existingSet = new Set(
      existing.map(
        (e) =>
          `${e.teacherId}-${e.schoolId}-${e.date.toISOString().split('T')[0]}`,
      ),
    );

    // One holiday lookup per distinct school, reused across all its teachers.
    const distinctSchoolIds = [...new Set(teachers.map((t) => t.schoolId))];
    const offDatesBySchool = new Map(
      await Promise.all(
        distinctSchoolIds.map(
          async (sid) =>
            [sid, await this.getHolidayOffDatesForRange(sid, start, end)] as const,
        ),
      ),
    );

    let recordsCreated = 0;
    let holidaysSkipped = 0;
    const datesAffected = new Set<string>();
    const teachersAffected = new Set<number>();

    for (const { teacherId, schoolId } of teachers) {
      const offDates = offDatesBySchool.get(schoolId) ?? new Set<string>();
      const history = historyByPair.get(`${teacherId}-${schoolId}`) ?? [];
      for (
        let d = new Date(start);
        d <= end;
        d.setUTCDate(d.getUTCDate() + 1)
      ) {
        // Only Sunday is an automatic weekly off — Saturday is a regular
        // school day here unless explicitly declared Holiday/Break. Beyond
        // that, this teacher isn't expected at this school on a day outside
        // whichever working-days pattern was in effect on THIS date, so no
        // Unreported row should be created.
        const assignedDaysToday = resolveWorkingDaysForDate(history, d);
        if (d.getUTCDay() === 0 || !assignedDaysToday.includes(d.getUTCDay())) continue;
        const dateStr = d.toISOString().split('T')[0];
        if (offDates.has(dateStr)) {
          holidaysSkipped++;
          continue;
        }
        const key = `${teacherId}-${schoolId}-${dateStr}`;
        if (existingSet.has(key)) continue;
        const dateOnly = new Date(dateStr + 'T00:00:00.000Z');
        await this.db.attendance.create({
          data: { teacherId, schoolId, date: dateOnly, status: 'Unreported' },
        });
        recordsCreated++;
        datesAffected.add(dateStr);
        teachersAffected.add(teacherId);
      }
    }

    return {
      summary: {
        records_created: recordsCreated,
        holidays_skipped: holidaysSkipped,
        teachers_affected: teachersAffected.size,
        dates_affected: datesAffected.size,
      },
    };
  }

  /**
   * Marks a teacher Absent for today (IST) if they had scheduled periods and
   * didn't cover all of them with reports — the converse of the "submit all
   * scheduled periods' reports → Present" rule in
   * TeacherReportsService.create() (reports.service.ts), so a teacher is
   * Present/Absent for the same reason in both directions. Batched (not a
   * per-teacher loop like markMissing) since this runs unattended every day
   * at production scale. Skips: weekends, school holidays, teachers who
   * already have an Attendance row today (any status), teachers on approved
   * leave, and teachers with zero scheduled periods today (nothing was
   * expected of them, so no absence is recorded — deliberately more
   * conservative than the Present-side rule to avoid false absences for
   * schools that haven't configured a class schedule yet). `forDateOnly` is
   * an optional override (UTC-midnight-anchored) for re-running a specific
   * past date; the cron itself always calls this with no argument.
   */
  async markAbsentForToday(forDateOnly?: Date) {
    const dateOnly = forDateOnly ?? getTodayIstDateOnly();
    const dateEnd = new Date(dateOnly);
    dateEnd.setUTCHours(23, 59, 59, 999);
    // Only Sunday is an automatic weekly off — Saturday is a regular
    // school day here unless explicitly declared Holiday/Break.
    if (dateOnly.getUTCDay() === 0) {
      return { summary: { skipped: 'sunday', records_created: 0 } };
    }

    const teacherSchools = await this.db.teacherSchool.findMany({
      select: { teacherId: true, schoolId: true },
    });
    if (teacherSchools.length === 0) {
      return { summary: { skipped: 'no_teachers', records_created: 0 } };
    }
    const distinctSchoolIds = [...new Set(teacherSchools.map((t) => t.schoolId))];
    const allTeacherIds = [...new Set(teacherSchools.map((t) => t.teacherId))];

    // Schools closed today (holiday/break) — every teacher there is skipped.
    const closedSchoolIds = new Set<string>();
    let holidaySchoolsSkipped = 0;
    await Promise.all(
      distinctSchoolIds.map(async (sid) => {
        const offDates = await this.getHolidayOffDatesForRange(sid, dateOnly, dateOnly);
        const dateStr = dateOnly.toISOString().split('T')[0];
        if (offDates.has(dateStr)) {
          closedSchoolIds.add(sid);
          holidaySchoolsSkipped++;
        }
      }),
    );

    // Teacher/school pairs that already have any Attendance row today.
    const existingRows = await this.db.attendance.findMany({
      where: { date: dateOnly },
      select: { teacherId: true, schoolId: true },
    });
    const existingSet = new Set(existingRows.map((r) => `${r.teacherId}-${r.schoolId}`));

    // Teachers on approved leave covering today.
    const leaves = await this.db.teacherLeave.findMany({
      where: {
        teacherId: { in: allTeacherIds },
        startDate: { lte: dateEnd },
        endDate: { gte: dateOnly },
        status: 'approved',
      },
      select: { teacherId: true },
    });
    const onLeaveSet = new Set(leaves.map((l) => l.teacherId));

    // Today's weekday computed the same way reports.service.ts derives it
    // (local Date components from the IST date string), so it agrees with
    // how ClassSchedule.dayOfWeek is interpreted at report-submission time.
    const [y, m, d] = dateOnly.toISOString().split('T')[0].split('-').map(Number);
    const dayOfWeek = new Date(y, m - 1, d).getDay();

    // Working-days history, resolved for today, per teacher+school pair —
    // ClassSchedule rows can go stale (a teacher reassigned off a weekday
    // whose old period rows never got cleaned up) so without this check a
    // teacher would still get auto-marked Absent on a day they're no longer
    // actually assigned to that school. History is the authoritative "is
    // this teacher even supposed to be here today" signal; ClassSchedule
    // only decides which periods they're absent *from* once that's true.
    const historyByPair = new Map<
      string,
      Array<{ effectiveFrom: Date; workingDays: number[] }>
    >(
      await Promise.all(
        teacherSchools.map(
          async ({ teacherId, schoolId }) =>
            [
              `${teacherId}-${schoolId}`,
              await this.getWorkingDaysHistory(teacherId, schoolId, dateOnly),
            ] as [string, Array<{ effectiveFrom: Date; workingDays: number[] }>],
        ),
      ),
    );

    const schedules = await this.db.classSchedule.findMany({
      where: { dayOfWeek, isActive: true, schoolId: { in: distinctSchoolIds } },
      select: { teacherId: true, schoolId: true, periodId: true },
    });
    const scheduledByPair = new Map<string, Set<string>>();
    for (const s of schedules) {
      if (!s.teacherId || !s.periodId) continue;
      const key = `${s.teacherId}-${s.schoolId}`;
      if (!scheduledByPair.has(key)) scheduledByPair.set(key, new Set());
      scheduledByPair.get(key)!.add(s.periodId);
    }

    const reports = await this.db.teacherReport.findMany({
      where: {
        reportDate: { gte: dateOnly, lte: dateEnd },
        schoolId: { in: distinctSchoolIds },
      },
      select: { teacherId: true, schoolId: true, periodId: true },
    });
    const reportedByPair = new Map<string, Set<string>>();
    for (const r of reports) {
      if (!r.periodId) continue;
      const key = `${r.teacherId}-${r.schoolId}`;
      if (!reportedByPair.has(key)) reportedByPair.set(key, new Set());
      reportedByPair.get(key)!.add(r.periodId);
    }

    let recordsCreated = 0;
    let noScheduleSkipped = 0;
    let notWorkingDaySkipped = 0;
    const teachersMarkedAbsent = new Set<number>();

    for (const { teacherId, schoolId } of teacherSchools) {
      if (closedSchoolIds.has(schoolId)) continue;
      const pairKey = `${teacherId}-${schoolId}`;
      if (existingSet.has(pairKey)) continue;
      if (onLeaveSet.has(teacherId)) continue;

      const history = historyByPair.get(pairKey) ?? [];
      const workingDaysToday = resolveWorkingDaysForDate(history, dateOnly);
      if (!workingDaysToday.includes(dayOfWeek)) {
        notWorkingDaySkipped++;
        continue;
      }

      const scheduledPeriodIds = scheduledByPair.get(pairKey);
      if (!scheduledPeriodIds || scheduledPeriodIds.size === 0) {
        noScheduleSkipped++;
        continue;
      }
      const reportedPeriodIds = reportedByPair.get(pairKey) ?? new Set<string>();
      const allCovered = [...scheduledPeriodIds].every((p) => reportedPeriodIds.has(p));
      if (allCovered) continue;

      await this.db.attendance.create({
        data: { teacherId, schoolId, date: dateOnly, status: 'Absent' },
      });
      recordsCreated++;
      teachersMarkedAbsent.add(teacherId);
    }

    return {
      summary: {
        records_created: recordsCreated,
        teachers_marked_absent: teachersMarkedAbsent.size,
        holiday_schools_skipped: holidaySchoolsSkipped,
        no_schedule_skipped: noScheduleSkipped,
        not_working_day_skipped: notWorkingDaySkipped,
      },
    };
  }

  @Cron('0 20 * * *', { timeZone: 'Asia/Kolkata' })
  async dailyAbsentMarkingCron(): Promise<void> {
    try {
      const result = await this.markAbsentForToday();
      this.logger.log(`Daily absence marking: ${JSON.stringify(result.summary)}`);
    } catch (err) {
      this.logger.error(`Daily absence marking failed: ${(err as Error)?.message}`);
    }
  }
}
