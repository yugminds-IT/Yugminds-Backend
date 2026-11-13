import { ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import {
  getTodayIstDateOnly,
  getTodayIstDateStr,
  isBeforeAttendanceCutoff,
} from '../../common/utils/date.util';
import {
  resolveSlotsForDate,
  resolveWorkingDaysForDate,
} from '../../common/utils/working-days-history.util';
import { slotWeight } from '../../common/utils/day-slots.util';
import {
  combineWeights,
  presentCreditByDate,
  weightedMetrics,
} from '../../common/utils/attendance-credit.util';
import { TeacherScheduleService } from '../schedule/teacher-schedule.service';

@Injectable()
export class TeacherAttendanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly teacherSchedule: TeacherScheduleService,
  ) {}

  private async assertSchoolAssigned(teacherId: number, schoolId?: string) {
    if (!schoolId) return;
    const assigned = await this.db.teacherSchool.findFirst({
      where: { teacherId, schoolId },
      select: { schoolId: true },
    });
    if (!assigned) throw new ForbiddenException('Not assigned to this school');
  }

  private toDateOnly(dateStr: string): Date {
    const d = new Date(dateStr + 'T12:00:00.000Z');
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  /**
   * Get today's attendance status and report progress for the teacher.
   */
  async getToday(teacherId: number, schoolId?: string, dateStr?: string) {
    const date = dateStr ? this.toDateOnly(dateStr) : getTodayIstDateOnly();
    const dateStart = new Date(date);
    dateStart.setUTCHours(0, 0, 0, 0);
    const dateEnd = new Date(date);
    dateEnd.setUTCHours(23, 59, 59, 999);

    const assignedSchoolIds = (
      await this.db.teacherSchool.findMany({
        where: { teacherId },
        select: { schoolId: true },
      })
    ).map((s) => s.schoolId);
    await this.assertSchoolAssigned(teacherId, schoolId);
    const schoolIds = schoolId ? [schoolId] : assignedSchoolIds;

    const result: any = {
      date: dateStr || date.toISOString().split('T')[0],
      dayOfWeek: new Date(dateStart).toLocaleDateString('en-US', {
        weekday: 'long',
      }),
      attendance: null,
      periodsWithReports: 0,
      totalPeriods: 0,
      submittedReports: 0,
      progress: 0,
      submittedPeriods: [],
      pendingPeriods: [],
      workingSchoolIds: [],
      holidaySchoolIds: [],
      offScheduleSchoolIds: [],
      daySlots: {} as Record<string, unknown>,
      notScheduledToday: true,
      // Server clock: is it still before the 8pm IST attendance cutoff?
      before_cutoff: isBeforeAttendanceCutoff(),
    };

    if (schoolIds.length === 0) return result;

    // Resolve which of the (possibly several) assigned schools the teacher
    // is actually on duty at today, combining TeacherWorkingDaysHistory
    // (the weekly pattern) with SchoolCalendar (holidays/comp-work) —
    // instead of trusting ClassSchedule.dayOfWeek alone, which can go
    // stale after a reassignment or not reflect a declared holiday.
    const workStatus = await this.teacherSchedule.getWorkStatusForDate(
      teacherId,
      schoolIds,
      dateStart,
    );
    result.workingSchoolIds = workStatus.workingSchoolIds;
    result.holidaySchoolIds = workStatus.holidaySchoolIds;
    result.offScheduleSchoolIds = workStatus.offScheduleSchoolIds;
    result.daySlots = workStatus.slots;
    result.notScheduledToday = workStatus.workingSchoolIds.length === 0;

    const workingSchoolIds = workStatus.workingSchoolIds;
    if (workingSchoolIds.length === 0) {
      result.attendance = {
        status:
          workStatus.holidaySchoolIds.length > 0 ? 'Holiday' : 'Not-Scheduled',
        date: result.date,
      };
      return result;
    }

    // 1. Compute scheduled periods
    // Derive dayOfWeek from the calendar date string (not UTC epoch) so that IST and other
    // UTC+ timezones at midnight don't flip to the previous day's schedule.
    const [dYear, dMonth, dDay] = (
      dateStr ?? dateStart.toISOString().split('T')[0]
    )
      .split('-')
      .map(Number);
    const dayOfWeek = new Date(dYear, dMonth - 1, dDay).getDay(); // 0=Sun..6=Sat
    const schedules = await this.db.classSchedule.findMany({
      where: {
        teacherId,
        schoolId: { in: workingSchoolIds },
        dayOfWeek,
        isActive: true,
      },
      orderBy: [{ periodId: 'asc' }],
    });

    const scheduledPeriodIds = Array.from(
      new Set(schedules.map((s) => s.periodId).filter(Boolean)),
    );
    const periods =
      scheduledPeriodIds.length > 0
        ? await this.db.period.findMany({
            where: { id: { in: scheduledPeriodIds } },
            select: { id: true, startTime: true, endTime: true },
          })
        : [];

    const periodById = new Map<
      string,
      { startTime: string; endTime: string }
    >();
    periods.forEach((p) =>
      periodById.set(p.id, { startTime: p.startTime, endTime: p.endTime }),
    );

    const scheduled = schedules
      .map((s) => {
        const p = periodById.get(s.periodId);
        return {
          period_id: s.periodId,
          grade: (s as { grade?: string | null }).grade ?? undefined,
          section: (s as { section?: string | null }).section ?? undefined,
          subject: (s as { subject?: string | null }).subject ?? undefined,
          start_time:
            (s as { startTime?: string | null }).startTime ??
            p?.startTime ??
            undefined,
          end_time:
            (s as { endTime?: string | null }).endTime ??
            p?.endTime ??
            undefined,
        };
      })
      // periodId is a UUID — orderBy periodId is random vs clock time.
      // Sort by start_time so Pending/Submitted lists read chronologically.
      .sort((a, b) =>
        String(a.start_time ?? '').localeCompare(String(b.start_time ?? '')),
      );

    const uniquePeriodIds = Array.from(
      new Set(scheduled.map((p) => p.period_id).filter(Boolean)),
    );

    // 2. Check for submitted reports
    const reports =
      uniquePeriodIds.length > 0
        ? await this.db.teacherReport.findMany({
            where: {
              teacherId,
              schoolId: { in: workingSchoolIds },
              reportDate: { gte: dateStart, lte: dateEnd },
              periodId: { in: uniquePeriodIds },
            },
            select: { periodId: true, status: true },
          })
        : [];

    const reportedPeriodIds = new Set(
      reports.map((r) => r.periodId).filter(Boolean) as string[],
    );

    result.submittedPeriods = scheduled.filter((p) =>
      reportedPeriodIds.has(p.period_id ?? ''),
    );
    result.pendingPeriods = scheduled.filter(
      (p) => !reportedPeriodIds.has(p.period_id ?? ''),
    );
    result.totalPeriods = uniquePeriodIds.length;
    result.periodsWithReports = result.submittedPeriods.length;
    result.submittedReports = result.periodsWithReports;
    result.progress =
      result.totalPeriods > 0
        ? Math.round((result.periodsWithReports / result.totalPeriods) * 100)
        : 0;

    // 3. Check attendance record first (explicitly marked, e.g. by report submission)
    const attendance = await this.db.attendance.findFirst({
      where: { teacherId, schoolId: { in: workingSchoolIds }, date: dateStart },
    });

    // 4. Check for leave
    const leave = await this.db.teacherLeave.findFirst({
      where: {
        teacherId,
        schoolId: { in: workingSchoolIds },
        startDate: { lte: dateEnd },
        endDate: { gte: dateStart },
        status: { not: 'cancelled' }, // a cancelled request is not a leave
      },
    });

    // Determine final status
    let status: string | null = null;
    if (attendance) {
      status = attendance.status;
    } else if (leave) {
      status =
        leave.status === 'approved'
          ? 'Leave-Approved'
          : leave.status === 'rejected'
            ? 'Leave-Rejected'
            : 'Pending';
    } else {
      // Inferred status (no attendance row yet). Once the day is settled
      // (a past date, or after the 8pm cutoff) a missing row means the
      // teacher didn't report in time — Absent, matching the monthly view;
      // a report that arrives after the cutoff never makes the day Present.
      const daySettled =
        result.date < getTodayIstDateStr() || !isBeforeAttendanceCutoff();
      status = daySettled
        ? 'Absent'
        : result.totalPeriods > 0 &&
            result.periodsWithReports >= result.totalPeriods
          ? 'Present'
          : 'Unreported';
    }
    // Absent although a report exists = the report came in after the 8pm cutoff.
    result.attendance = {
      status,
      date: result.date,
      ...(status === 'Absent' &&
        reportedPeriodIds.size > 0 && { late_report: true }),
    };
    return result;
  }

  /**
   * Calculate actual working days for a teacher in a given month.
   * Uses TeacherSchool.workingDays (the admin-assigned weekly pattern for
   * this specific teacher+school — 0=Sun..6=Sat) to find scheduled days,
   * then subtracts school holidays/breaks from SchoolCalendar, and adds
   * CompensatoryWork days. (Previously this read ClassSchedule, which
   * requires a full period-by-period timetable to exist and returned 0 for
   * any teacher without one — the common case.)
   */
  /** dateStr -> weight (1 = full day, 0.5 = half day) for this one school. */
  private async getScheduledWorkingDates(
    teacherId: number,
    schoolId: string,
    year: number,
    month: number,
  ): Promise<Map<string, number>> {
    const monthEndForHistory = new Date(
      Date.UTC(year, month, 0, 23, 59, 59, 999),
    );
    const history = await this.db.teacherWorkingDaysHistory.findMany({
      where: {
        teacherId,
        schoolId,
        effectiveFrom: { lte: monthEndForHistory },
      },
      select: { effectiveFrom: true, workingDays: true, workingDaySlots: true },
      orderBy: { effectiveFrom: 'asc' },
    });
    if (history.length === 0) return new Map();

    // Get all holiday/break dates for the month from SchoolCalendar
    const holidayEntries = await this.db.schoolCalendar.findMany({
      where: {
        schoolId,
        isActive: true,
        type: { in: ['Holiday', 'Break', 'HalfDay'] },
        date: { lte: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)) },
        OR: [
          {
            endDate: null,
            date: { gte: new Date(Date.UTC(year, month - 1, 1)) },
          },
          { endDate: { gte: new Date(Date.UTC(year, month - 1, 1)) } },
        ],
      },
    });

    const holidayDates = new Set<string>();
    const halfDayDates = new Set<string>();
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(Date.UTC(year, month, 0));

    for (const entry of holidayEntries) {
      const rangeEnd = entry.endDate ?? entry.date;
      const cur = new Date(entry.date);
      while (cur <= rangeEnd && cur <= monthEnd) {
        if (cur >= monthStart) {
          const dateStr = cur.toISOString().split('T')[0];
          if (entry.type === 'HalfDay') {
            halfDayDates.add(dateStr);
          } else {
            holidayDates.add(dateStr);
          }
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }

    // Get compensatory working days (weekends that are treated as working)
    const compensatoryEntries = await this.db.schoolCalendar.findMany({
      where: {
        schoolId,
        isActive: true,
        type: 'CompensatoryWork',
        date: { gte: monthStart, lte: monthEnd },
      },
    });

    const compensatoryDates = new Set<string>();
    for (const entry of compensatoryEntries) {
      const rangeEnd = entry.endDate ?? entry.date;
      const cur = new Date(entry.date);
      while (cur <= rangeEnd && cur <= monthEnd) {
        if (cur >= monthStart) {
          compensatoryDates.add(cur.toISOString().split('T')[0]);
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }

    // Walk through every day in the month, but never past today for the
    // CURRENT month — a not-yet-happened working day has no Attendance row
    // yet and would otherwise sit in the denominator as an automatic miss,
    // artificially deflating attendance_percentage (e.g. present every day
    // so far this month would still show <100% because tomorrow's
    // not-yet-scheduled-to-happen working day is counted as a 0). Past
    // months are unaffected since monthEnd is already in the past for them.
    const todayUTC = new Date();
    const walkEnd =
      year === todayUTC.getUTCFullYear() && month === todayUTC.getUTCMonth() + 1
        ? new Date(
            Date.UTC(
              todayUTC.getUTCFullYear(),
              todayUTC.getUTCMonth(),
              todayUTC.getUTCDate(),
            ),
          )
        : monthEnd;

    const workingDates = new Map<string, number>();
    const cur = new Date(monthStart);
    while (cur <= monthEnd && cur <= walkEnd) {
      const dateStr = cur.toISOString().split('T')[0];
      const dow = cur.getUTCDay();

      if (compensatoryDates.has(dateStr)) {
        // Compensatory working days always count (even if weekend)
        const weight = holidayDates.has(dateStr)
          ? 0
          : halfDayDates.has(dateStr)
            ? 0.5
            : 1;
        if (weight > 0) workingDates.set(dateStr, weight);
      } else if (
        resolveWorkingDaysForDate(history, cur).includes(dow) &&
        !holidayDates.has(dateStr)
      ) {
        // A teacher's own half-day slot and a school-wide HalfDay both cap
        // the day at 0.5 (they don't multiply to 0.25).
        const slotW = slotWeight(resolveSlotsForDate(history, cur), dow);
        workingDates.set(
          dateStr,
          Math.min(slotW, halfDayDates.has(dateStr) ? 0.5 : 1),
        );
      }

      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    return workingDates;
  }

  /**
   * Get monthly attendance summary (present_days, absent_days, leave_days, unreported_days, total_working_days, attendance_percentage).
   * total_working_days is derived from ClassSchedule + SchoolCalendar for accuracy.
   * If yearMonth (YYYY-MM) is provided, include that month in the result (in addition to last `limit` months).
   */
  async getMonthly(
    teacherId: number,
    schoolId?: string,
    limit = 6,
    yearMonth?: string,
  ) {
    await this.assertSchoolAssigned(teacherId, schoolId);
    const schoolIds = schoolId
      ? [schoolId]
      : (
          await this.db.teacherSchool.findMany({
            where: { teacherId },
            select: { schoolId: true },
          })
        ).map((s) => s.schoolId);
    if (schoolIds.length === 0) {
      return { monthlyData: [] };
    }

    const months: { year: number; month: number }[] = [];
    const now = new Date();
    for (let i = 0; i < limit; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
    }
    if (yearMonth) {
      const [y, m] = yearMonth.split('-').map(Number);
      if (y && m && !months.some((mm) => mm.year === y && mm.month === m)) {
        months.push({ year: y, month: m });
      }
    }

    const monthlyData = await Promise.all(
      months.map(async ({ year, month }) => {
        const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
        const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
        const monthKey = `${year}-${String(month).padStart(2, '0')}`;

        const [attendanceRecords, leaveRecords, scheduleMapsPerSchool] =
          await Promise.all([
            this.db.attendance.findMany({
              where: {
                teacherId,
                schoolId: { in: schoolIds },
                date: { gte: start, lte: end },
              },
            }),
            this.db.teacherLeave.findMany({
              where: {
                teacherId,
                schoolId: { in: schoolIds },
                startDate: { lte: end },
                endDate: { gte: start },
                status: 'approved',
              },
            }),
            // One map per school, then unioned below (taking the higher
            // weight per date) — previously this only looked at the
            // teacher's FIRST school, silently ignoring the rest for
            // multi-school teachers.
            Promise.all(
              schoolIds.map((sid) =>
                this.getScheduledWorkingDates(teacherId, sid, year, month),
              ),
            ),
          ]);

        const dayStr = (d: Date) => d.toISOString().split('T')[0];
        // Metrics for a subset of the teacher's schools: one school, or all of them.
        const metricsFor = (ids: string[]) => {
          const attRecs = attendanceRecords.filter((x) =>
            ids.includes(x.schoolId),
          );
          // Per-school scheduled weights; a day split across two schools
          // (MORNING + AFTERNOON) sums to one full day.
          const weightsBySchool = new Map(
            schoolIds
              .map((sid, i) => [sid, scheduleMapsPerSchool[i]] as const)
              .filter(([sid]) => ids.includes(sid)),
          );
          const weights = combineWeights(weightsBySchool.values());

          const leaveDates = new Set<string>();
          for (const l of leaveRecords.filter((x) =>
            ids.includes(x.schoolId),
          )) {
            const cur = new Date(l.startDate > start ? l.startDate : start);
            const last = l.endDate < end ? l.endDate : end;
            for (; cur <= last; cur.setUTCDate(cur.getUTCDate() + 1))
              leaveDates.add(dayStr(cur));
          }
          const explicitAbsent = new Set(
            attRecs
              .filter((a) => a.status === 'Absent')
              .map((a) => dayStr(a.date)),
          );
          // No schedule at all (no history): fall back to whatever was recorded.
          if (weights.size === 0) {
            for (const a of attRecs)
              if (a.status === 'Present' || a.status === 'Absent')
                weights.set(dayStr(a.date), 1);
            for (const d of leaveDates) weights.set(d, 1);
          }

          // Rule: no report = Absent. Each school's half only earns credit
          // when THAT school's report landed; past uncovered time is Absent,
          // today / unsettled stays Unreported (same as the admin view).
          const m = weightedMetrics({
            weights,
            presentCredit: presentCreditByDate(attRecs, weightsBySchool),
            explicitAbsent,
            leaveDates,
            reportedDates: new Set(),
            todayStr: getTodayIstDateStr(),
          });
          return m;
        };
        const m = metricsFor(schoolIds);
        // Overall mode only: the same numbers per school, so the UI can show the split.
        const by_school = schoolId
          ? undefined
          : schoolIds.map((sid) => {
              const x = metricsFor([sid]);
              return {
                school_id: sid,
                present_days: x.present_days,
                absent_days: x.absent_days,
                leave_days: x.leave_days,
                unreported_days: x.unreported_days,
                total_working_days: x.total_working_days,
                attendance_percentage: x.attendance_percentage,
              };
            });

        return {
          month: monthKey,
          // Display-only label (the filtered school, else the first one); the
          // totals are for `schoolId` when given, otherwise ALL schools combined.
          school_id: schoolId ?? schoolIds[0],
          present_days: m.present_days,
          absent_days: m.absent_days,
          leave_days: m.leave_days,
          unreported_days: m.unreported_days,
          total_working_days: m.total_working_days,
          attendance_percentage: m.attendance_percentage,
          ...(by_school && { by_school }),
        };
      }),
    );
    return { monthlyData };
  }

  /**
   * List daily attendance records for a date range.
   */
  async list(teacherId: number, schoolId?: string, from?: string, to?: string) {
    await this.assertSchoolAssigned(teacherId, schoolId);
    const schoolIds = schoolId
      ? [schoolId]
      : (
          await this.db.teacherSchool.findMany({
            where: { teacherId },
            select: { schoolId: true },
          })
        ).map((s) => s.schoolId);
    if (schoolIds.length === 0) return { attendance: [] };

    const fromDate = from
      ? this.toDateOnly(from)
      : new Date(new Date().setMonth(new Date().getMonth() - 1));
    const toDate = to ? this.toDateOnly(to) : new Date();

    const records = await this.db.attendance.findMany({
      where: {
        teacherId,
        schoolId: { in: schoolIds },
        date: { gte: fromDate, lte: toDate },
      },
      orderBy: { date: 'desc' },
    });
    // An Absent day that still has a submitted report means the report came in
    // after the 8pm cutoff — flag it so the UI can say "Absent (late report)".
    const absent = records.filter((r) => r.status === 'Absent');
    const lateDays = new Set<string>();
    if (absent.length > 0) {
      const reports = await this.db.teacherReport.findMany({
        where: {
          teacherId,
          schoolId: { in: schoolIds },
          reportDate: {
            gte: fromDate,
            lte: new Date(toDate.getTime() + 24 * 3600 * 1000),
          },
        },
        select: { schoolId: true, reportDate: true },
      });
      const reported = new Set(
        reports.map(
          (r) => `${r.schoolId}|${r.reportDate.toISOString().split('T')[0]}`,
        ),
      );
      for (const r of absent) {
        const day = r.date.toISOString().split('T')[0];
        if (reported.has(`${r.schoolId}|${day}`))
          lateDays.add(`${r.schoolId}|${day}`);
      }
    }
    const rows = records.map((r) => {
      const day = r.date.toISOString().split('T')[0];
      return {
        id: r.id,
        school_id: r.schoolId,
        date: day,
        status: r.status,
        recorded_at: r.createdAt.toISOString() as string | null,
        ...(lateDays.has(`${r.schoolId}|${day}`) && { late_report: true }),
      };
    });

    // Past scheduled working days with no stored row are Absent (or Leave) —
    // the same rule getMonthly counts — so list them too, otherwise the
    // totals show absences the day-by-day list can't explain.
    const have = new Set(rows.map((r) => r.date));
    const todayStr = getTodayIstDateStr();
    const fromStr = fromDate.toISOString().split('T')[0];
    const toStr = toDate.toISOString().split('T')[0];
    const leaves = await this.db.teacherLeave.findMany({
      where: {
        teacherId,
        schoolId: { in: schoolIds },
        startDate: { lte: toDate },
        endDate: { gte: fromDate },
        status: 'approved',
      },
    });
    const leaveDates = new Set<string>();
    for (const l of leaves) {
      const cur = new Date(l.startDate > fromDate ? l.startDate : fromDate);
      const last = l.endDate < toDate ? l.endDate : toDate;
      for (; cur <= last; cur.setUTCDate(cur.getUTCDate() + 1))
        leaveDates.add(cur.toISOString().split('T')[0]);
    }
    const monthsInRange = new Set<string>();
    for (
      const c = new Date(
        Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1),
      );
      c <= toDate;
      c.setUTCMonth(c.getUTCMonth() + 1)
    )
      monthsInRange.add(`${c.getUTCFullYear()}-${c.getUTCMonth() + 1}`);
    for (const ym of monthsInRange) {
      const [y, m] = ym.split('-').map(Number);
      const weights = combineWeights(
        await Promise.all(
          schoolIds.map((sid) =>
            this.getScheduledWorkingDates(teacherId, sid, y, m),
          ),
        ),
      );
      for (const d of weights.keys()) {
        if (d < fromStr || d > toStr || d >= todayStr || have.has(d)) continue;
        rows.push({
          id: `missing-${d}`,
          school_id: schoolIds[0],
          date: d,
          status: leaveDates.has(d) ? 'Leave-Approved' : 'Absent',
          recorded_at: null,
        });
      }
    }
    rows.sort((a, b) => b.date.localeCompare(a.date));
    return { attendance: rows };
  }
}
