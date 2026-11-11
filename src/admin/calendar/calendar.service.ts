import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { getTodayIstDateStr } from '../../common/utils/date.util';
import { resolveWorkingDaysForDate } from '../../common/utils/working-days-history.util';
import { WEEKDAY_NAMES } from '../../common/utils/weekdays.util';

const VALID_TYPES = ['Holiday', 'Break', 'HalfDay', 'CompensatoryWork'];

export interface CalendarEntryDto {
  id: string;
  school_id: string;
  school_name: string;
  date: string;
  end_date: string | null;
  name: string;
  type: string;
  academic_year: string;
  description: string | null;
  batch_id: string | null;
  created_at: string;
}

/**
 * Admin-only platform calendar: holidays, breaks, half-days, and
 * compensatory working days, per school. This is the single source of
 * truth the attendance system reads to know which dates a school was
 * actually open — see AdminTeacherAttendanceService.
 *
 * School admins do NOT have write access here (moved out entirely, see
 * project history 2026-07-25) — only the platform admin can declare a
 * holiday, and can do so for one school or every school at once.
 */
@Injectable()
export class AdminCalendarService {
  constructor(private readonly db: DatabaseService) {}

  private assertValidType(type: string) {
    if (!VALID_TYPES.includes(type)) {
      throw new BadRequestException(
        `type must be one of: ${VALID_TYPES.join(', ')}`,
      );
    }
  }

  /**
   * Per school, the union of every teacher's working-days pattern *as it
   * stood on `date`* (0=Sun..6=Sat) — "who was actually expected to work at
   * this school on this specific date." Resolved from
   * TeacherWorkingDaysHistory (not the "current" TeacherSchool.workingDays)
   * so this stays correct for past dates even after a teacher's schedule has
   * since changed — otherwise a holiday entry for a date before a mid-month
   * schedule change could be wrongly accepted or rejected based on today's
   * pattern instead of the one that applied back then.
   *
   * A school absent from the result has no working-days history at all
   * (brand new / not staffed) — callers treat that as having NO working
   * days until a teacher is assigned, not as unrestricted.
   */
  async getActiveWeekdaysBySchool(
    date: Date,
  ): Promise<Record<string, number[]>> {
    const rows = await this.db.teacherWorkingDaysHistory.findMany({
      where: { effectiveFrom: { lte: date } },
      select: {
        teacherId: true,
        schoolId: true,
        workingDays: true,
        effectiveFrom: true,
      },
      orderBy: { effectiveFrom: 'asc' },
    });

    // Latest entry per (teacher, school) pair with effectiveFrom <= date.
    const latestByPair = new Map<
      string,
      { schoolId: string; workingDays: number[]; effectiveFrom: Date }
    >();
    for (const r of rows) {
      const key = `${r.teacherId}:${r.schoolId}`;
      const existing = latestByPair.get(key);
      if (!existing || r.effectiveFrom > existing.effectiveFrom) {
        latestByPair.set(key, {
          schoolId: r.schoolId,
          workingDays: r.workingDays,
          effectiveFrom: r.effectiveFrom,
        });
      }
    }

    const bySchool = new Map<string, Set<number>>();
    for (const { schoolId, workingDays } of latestByPair.values()) {
      if (!bySchool.has(schoolId)) bySchool.set(schoolId, new Set());
      for (const d of workingDays) bySchool.get(schoolId)!.add(d);
    }
    const result: Record<string, number[]> = {};
    for (const [schoolId, days] of bySchool) {
      result[schoolId] = [...days].sort((a, b) => a - b);
    }
    return result;
  }

  /**
   * Who a calendar entry affects: the schools it covers, and the teachers who have classes scheduled
   * on those dates (their timetable slots on the matching weekdays, counted for every date in the
   * entry's range). Teachers assigned to these schools with no class in that window are listed apart.
   * All entries of one declaration (a batch) share the same dates and type.
   */
  async impact(entryIds: string[]) {
    const ids = [
      ...new Set((entryIds ?? []).filter((x) => typeof x === 'string' && x)),
    ].slice(0, 200);
    if (ids.length === 0)
      throw new BadRequestException('Provide at least one entry id');

    const entries = await this.db.schoolCalendar.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        schoolId: true,
        date: true,
        endDate: true,
        type: true,
        name: true,
        school: { select: { id: true, name: true } },
      },
    });
    if (entries.length === 0)
      throw new NotFoundException('Calendar entry not found');

    const schoolIds = [...new Set(entries.map((e) => e.schoolId))];
    const [assignments, schedules] = await Promise.all([
      this.db.teacherSchool.findMany({
        where: {
          schoolId: { in: schoolIds },
          teacher: { isActive: true, deletedAt: null },
        },
        select: {
          teacherId: true,
          schoolId: true,
          assignedFrom: true,
          assignedUntil: true,
          teacher: {
            select: { email: true, profile: { select: { fullName: true } } },
          },
        },
      }),
      this.db.classSchedule.findMany({
        where: {
          schoolId: { in: schoolIds },
          isActive: true,
          teacherId: { not: null },
        },
        select: { schoolId: true, teacherId: true, dayOfWeek: true },
      }),
    ]);

    // Classes per teacher and school: each timetable slot counts once for every date in the entry's range
    // that falls on its weekday (a break runs over several dates).
    const MAX_DAYS = 62;
    const key = (teacherId: number, schoolId: string) =>
      `${teacherId}:${schoolId}`;
    const classCount = new Map<string, number>();
    for (const e of entries) {
      const weekdays: number[] = [];
      const end = new Date(e.endDate ?? e.date);
      for (
        let d = new Date(e.date), n = 0;
        d <= end && n < MAX_DAYS;
        d.setUTCDate(d.getUTCDate() + 1), n++
      ) {
        weekdays.push(d.getUTCDay());
      }
      for (const sc of schedules) {
        if (sc.schoolId !== e.schoolId || sc.teacherId == null) continue;
        const hits = weekdays.filter((w) => w === sc.dayOfWeek).length;
        if (hits > 0)
          classCount.set(
            key(sc.teacherId, sc.schoolId),
            (classCount.get(key(sc.teacherId, sc.schoolId)) ?? 0) + hits,
          );
      }
    }

    // A teacher assigned to the school only from a later date (or until an earlier one) is not working on these dates.
    const windowOf = new Map(
      entries.map((e) => [
        e.schoolId,
        { from: e.date, to: e.endDate ?? e.date },
      ]),
    );
    const assignedHere = new Map(
      assignments.map((a) => [key(a.teacherId, a.schoolId), a]),
    );
    const inWindow = (a: {
      schoolId: string;
      assignedFrom: Date | null;
      assignedUntil: Date | null;
    }) => {
      const w = windowOf.get(a.schoolId)!;
      return (
        (!a.assignedFrom || a.assignedFrom <= w.to) &&
        (!a.assignedUntil || a.assignedUntil >= w.from)
      );
    };

    // The timetable is the stronger signal: a teacher with classes is affected even if the assignment row is missing.
    const strangers = [
      ...new Set(
        [...classCount.keys()]
          .filter((k) => !assignedHere.has(k))
          .map((k) => Number(k.split(':')[0])),
      ),
    ];
    const strangerUsers = strangers.length
      ? await this.db.user.findMany({
          where: { id: { in: strangers }, isActive: true, deletedAt: null },
          select: {
            id: true,
            email: true,
            profile: { select: { fullName: true } },
          },
        })
      : [];
    const nameOf = new Map<number, { name: string; email: string }>();
    for (const a of assignments)
      nameOf.set(a.teacherId, {
        name: a.teacher.profile?.fullName ?? a.teacher.email ?? '',
        email: a.teacher.email ?? '',
      });
    for (const u of strangerUsers)
      nameOf.set(u.id, {
        name: u.profile?.fullName ?? u.email ?? '',
        email: u.email ?? '',
      });

    const schoolName = new Map(
      entries.map((e) => [e.schoolId, e.school?.name ?? '']),
    );
    const people = new Map<
      number,
      {
        id: number;
        name: string;
        email: string;
        classes: number;
        schools: { id: string; name: string; classes: number }[];
      }
    >();
    for (const [k, n] of classCount) {
      const [tid, sid] = [Number(k.split(':')[0]), k.slice(k.indexOf(':') + 1)];
      const a = assignedHere.get(k);
      const who = nameOf.get(tid);
      if (!who || (a && !inWindow(a))) continue; // inactive/removed teacher, or not assigned on these dates
      const p = people.get(tid) ?? {
        id: tid,
        name: who.name,
        email: who.email,
        classes: 0,
        schools: [],
      };
      p.classes += n;
      p.schools.push({ id: sid, name: schoolName.get(sid) ?? '', classes: n });
      people.set(tid, p);
    }
    const assignedOnly = new Map<number, { id: number; name: string }>();
    for (const a of assignments) {
      if (!people.has(a.teacherId) && inWindow(a))
        assignedOnly.set(a.teacherId, {
          id: a.teacherId,
          name: nameOf.get(a.teacherId)?.name ?? '',
        });
    }

    const byName = (a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name);
    const teachers = [...people.values()].sort(byName);
    const first = entries[0];
    return {
      name: first.name,
      type: first.type,
      date: first.date.toISOString().slice(0, 10),
      end_date: first.endDate ? first.endDate.toISOString().slice(0, 10) : null,
      schools: schoolIds
        .map((id) => ({
          id,
          name: schoolName.get(id) ?? '',
          teachers: teachers.filter((t) => t.schools.some((s) => s.id === id))
            .length,
        }))
        .sort(byName),
      teachers,
      without_classes: [...assignedOnly.values()].sort(byName),
    };
  }

  /**
   * Per school, the exact set of dates in [year, month] that were an active
   * working day for at least one teacher there — resolved DAY BY DAY against
   * each teacher's working-days history, not one flat weekday pattern for
   * the whole month. This is what makes the calendar grid exactly correct
   * around a mid-month change (e.g. a teacher moving from Mon-Thu to Mon-Fri
   * on the 16th): days 1-15 use the old pattern, 16-end use the new one, so
   * a Saturday that only became a working day partway through the month
   * shows correctly for the days it actually applies to and not before.
   */
  async getActiveDatesBySchoolForMonth(
    year: number,
    month: number,
  ): Promise<Record<string, string[]>> {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

    const rows = await this.db.teacherWorkingDaysHistory.findMany({
      where: { effectiveFrom: { lte: end } },
      select: {
        teacherId: true,
        schoolId: true,
        workingDays: true,
        effectiveFrom: true,
      },
      orderBy: { effectiveFrom: 'asc' },
    });

    // Group into one history timeline per (teacher, school) pair.
    const byPair = new Map<
      string,
      {
        schoolId: string;
        entries: Array<{ effectiveFrom: Date; workingDays: number[] }>;
      }
    >();
    for (const r of rows) {
      const key = `${r.teacherId}:${r.schoolId}`;
      if (!byPair.has(key))
        byPair.set(key, { schoolId: r.schoolId, entries: [] });
      byPair.get(key)!.entries.push({
        effectiveFrom: r.effectiveFrom,
        workingDays: r.workingDays,
      });
    }

    const activeDatesBySchool = new Map<string, Set<string>>();
    for (const { schoolId, entries } of byPair.values()) {
      for (
        const d = new Date(start);
        d <= end;
        d.setUTCDate(d.getUTCDate() + 1)
      ) {
        const days = resolveWorkingDaysForDate(entries, d);
        if (days.includes(d.getUTCDay())) {
          if (!activeDatesBySchool.has(schoolId))
            activeDatesBySchool.set(schoolId, new Set());
          activeDatesBySchool.get(schoolId)!.add(d.toISOString().split('T')[0]);
        }
      }
    }

    const result: Record<string, string[]> = {};
    for (const [schoolId, dates] of activeDatesBySchool) {
      result[schoolId] = [...dates].sort();
    }
    return result;
  }

  private toDto(
    entry: Awaited<
      ReturnType<DatabaseService['schoolCalendar']['findFirstOrThrow']>
    > & {
      school?: { name: string } | null;
    },
  ): CalendarEntryDto {
    return {
      id: entry.id,
      school_id: entry.schoolId,
      school_name: entry.school?.name ?? '',
      date: entry.date.toISOString().split('T')[0],
      end_date: entry.endDate
        ? entry.endDate.toISOString().split('T')[0]
        : null,
      name: entry.name,
      type: entry.type,
      academic_year: entry.academicYear,
      description: entry.description ?? null,
      batch_id: entry.batchId ?? null,
      created_at: entry.createdAt.toISOString(),
    };
  }

  async list(params?: {
    school_id?: string;
    year?: string;
    month?: string;
    academic_year?: string;
    type?: string;
  }) {
    let dateFilter: { gte?: Date; lte?: Date } | undefined;
    if (params?.year && params?.month) {
      const y = parseInt(params.year, 10);
      const m = parseInt(params.month, 10);
      dateFilter = {
        gte: new Date(Date.UTC(y, m - 1, 1)),
        lte: new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)),
      };
    } else if (params?.year) {
      const y = parseInt(params.year, 10);
      dateFilter = {
        gte: new Date(Date.UTC(y, 0, 1)),
        lte: new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999)),
      };
    }

    const where: Record<string, unknown> = { isActive: true };
    if (params?.school_id) where.schoolId = params.school_id;
    if (dateFilter) where.date = dateFilter;
    if (params?.academic_year) where.academicYear = params.academic_year;
    if (params?.type) where.type = params.type;

    const entries = await this.db.schoolCalendar.findMany({
      where,
      include: { school: { select: { name: true } } },
      orderBy: [{ date: 'asc' }, { schoolId: 'asc' }],
    });

    return { calendar: entries.map((e) => this.toDto(e)) };
  }

  /**
   * Read-only calendar listing scoped to a specific set of schools (e.g. a
   * teacher's own assigned schools) rather than "all schools" or a single
   * admin-picked one — used by the teacher-facing calendar view so a
   * multi-school teacher can see all their schools' holidays at once.
   */
  async listForSchools(schoolIds: string[], year: string, month: string) {
    if (schoolIds.length === 0) return { calendar: [] };
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    const dateFilter = {
      gte: new Date(Date.UTC(y, m - 1, 1)),
      lte: new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)),
    };
    const entries = await this.db.schoolCalendar.findMany({
      where: { isActive: true, schoolId: { in: schoolIds }, date: dateFilter },
      include: { school: { select: { name: true } } },
      orderBy: [{ date: 'asc' }, { schoolId: 'asc' }],
    });
    return { calendar: entries.map((e) => this.toDto(e)) };
  }

  async create(
    actorId: number,
    body: {
      school_id?: string;
      apply_to_all_schools?: boolean;
      date: string;
      end_date?: string;
      name: string;
      type: string;
      academic_year?: string;
      description?: string;
    },
  ): Promise<{
    calendar: CalendarEntryDto[];
    batch_id: string | null;
    schools_count: number;
    reports_closed: number;
  }> {
    if (!body.date) throw new BadRequestException('date is required');
    if (!body.name?.trim()) {
      throw new BadRequestException(
        'A reason for the holiday/entry is required',
      );
    }
    this.assertValidType(body.type);

    const date = new Date(body.date + 'T00:00:00.000Z');
    const endDate = body.end_date
      ? new Date(body.end_date + 'T00:00:00.000Z')
      : null;
    if (endDate && endDate < date) {
      throw new BadRequestException('end_date must be on or after date');
    }

    const baseData = {
      date,
      endDate,
      name: body.name.trim(),
      type: body.type,
      academicYear: body.academic_year ?? '2024-25',
      description: body.description?.trim() ?? null,
      createdByUserId: actorId,
    };

    const weekday = date.getUTCDay();
    const [activeWeekdaysBySchool, scheduledThatWeekday] = await Promise.all([
      this.getActiveWeekdaysBySchool(date),
      this.db.classSchedule.findMany({
        where: { isActive: true, dayOfWeek: weekday },
        select: { schoolId: true },
        distinct: ['schoolId'],
      }),
    ]);
    const hasClassesThatWeekday = new Set(
      scheduledThatWeekday.map((s) => s.schoolId),
    );
    // A school is eligible if a teacher's working-days pattern covers this
    // weekday OR the timetable has classes that weekday — teachers can file
    // reports for any timetabled class, so skipping such a school would leave
    // it open for reports on a declared holiday.
    const isSchoolEligible = (schoolId: string) => {
      const days = activeWeekdaysBySchool[schoolId];
      return (
        (!!days && days.includes(weekday)) ||
        hasClassesThatWeekday.has(schoolId)
      );
    };

    if (body.apply_to_all_schools) {
      const schools = await this.db.school.findMany({
        where: { isActive: true, deletedAt: null },
        select: { id: true },
      });
      const eligibleSchools = schools.filter((s) => isSchoolEligible(s.id));
      if (eligibleSchools.length === 0) {
        throw new BadRequestException(
          'No school has anyone working on this day — nothing to apply this entry to.',
        );
      }
      const batchId = randomUUID();
      const created = await this.db.$transaction(
        eligibleSchools.map((s) =>
          this.db.schoolCalendar.create({
            data: { ...baseData, schoolId: s.id, batchId },
            include: { school: { select: { name: true } } },
          }),
        ),
      );
      const reportsClosed = await this.closePendingReportsForEntries(created);
      return {
        calendar: created.map((e) => this.toDto(e)),
        batch_id: batchId,
        schools_count: created.length,
        reports_closed: reportsClosed,
      };
    }

    if (!body.school_id) {
      throw new BadRequestException(
        'school_id is required unless apply_to_all_schools is set',
      );
    }
    if (!isSchoolEligible(body.school_id)) {
      const dayName = WEEKDAY_NAMES[weekday];
      throw new BadRequestException(
        `No teacher works at this school on ${dayName}s — nothing to mark as a holiday.`,
      );
    }
    const entry = await this.db.schoolCalendar.create({
      data: { ...baseData, schoolId: body.school_id },
      include: { school: { select: { name: true } } },
    });
    const reportsClosed = await this.closePendingReportsForEntries([entry]);
    return {
      calendar: [this.toDto(entry)],
      batch_id: null,
      schools_count: 1,
      reports_closed: reportsClosed,
    };
  }

  /**
   * When a Holiday/Break covers dates that already have pending (not yet
   * reviewed) teacher reports — typically "Mark today as holiday" declared
   * mid-day — reject them so they can't be approved as if the school had
   * been open. Approved reports are left alone as historical record.
   */
  private async closePendingReportsForEntries(
    entries: Array<{
      schoolId: string;
      date: Date;
      endDate: Date | null;
      type: string;
      name: string;
    }>,
  ): Promise<number> {
    let closed = 0;
    for (const e of entries) {
      if (e.type !== 'Holiday' && e.type !== 'Break') continue;
      const start = new Date(e.date);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(e.endDate ?? e.date);
      end.setUTCHours(23, 59, 59, 999);
      const res = await this.db.teacherReport.updateMany({
        where: {
          schoolId: e.schoolId,
          reportDate: { gte: start, lte: end },
          status: { in: ['submitted', 'reviewed'] },
        },
        data: {
          status: 'rejected',
          adminNotes: `Auto-closed: school declared ${e.type.toLowerCase()} (${e.name}) on this date.`,
        },
      });
      closed += res.count;
    }
    return closed;
  }

  /** Convenience wrapper for the "Mark today as a holiday" quick action. */
  async markToday(
    actorId: number,
    body: {
      school_id?: string;
      apply_to_all_schools?: boolean;
      name: string;
      type?: string;
      description?: string;
      academic_year?: string;
    },
  ) {
    return this.create(actorId, {
      ...body,
      date: getTodayIstDateStr(),
      type: body.type ?? 'Holiday',
    });
  }

  async update(
    id: string,
    body: {
      date?: string;
      end_date?: string | null;
      name?: string;
      type?: string;
      academic_year?: string;
      description?: string | null;
    },
  ) {
    const existing = await this.db.schoolCalendar.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Calendar entry not found');

    if (body.type) this.assertValidType(body.type);

    const date = body.date ? new Date(body.date + 'T00:00:00.000Z') : undefined;
    const endDate =
      body.end_date === null
        ? null
        : body.end_date
          ? new Date(body.end_date + 'T00:00:00.000Z')
          : undefined;

    const updated = await this.db.schoolCalendar.update({
      where: { id },
      data: {
        ...(date && { date }),
        ...(endDate !== undefined && { endDate }),
        ...(body.name?.trim() && { name: body.name.trim() }),
        ...(body.type && { type: body.type }),
        ...(body.academic_year && { academicYear: body.academic_year }),
        ...(body.description !== undefined && {
          description: body.description?.trim() ?? null,
        }),
      },
      include: { school: { select: { name: true } } },
    });
    if (updated.isActive) {
      await this.closePendingReportsForEntries([updated]);
    }
    return { entry: this.toDto(updated) };
  }

  async remove(id: string) {
    const existing = await this.db.schoolCalendar.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Calendar entry not found');
    await this.db.schoolCalendar.update({
      where: { id },
      data: { isActive: false },
    });
    return { success: true };
  }

  /** Removes every entry created together via apply-to-all-schools. */
  async removeBatch(batchId: string) {
    const result = await this.db.schoolCalendar.updateMany({
      where: { batchId, isActive: true },
      data: { isActive: false },
    });
    if (result.count === 0) throw new NotFoundException('Batch not found');
    return { success: true, removed: result.count };
  }

  // ---- Read helpers used internally by AdminTeacherAttendanceService ----

  async getHolidayDatesForMonth(
    schoolId: string,
    year: number,
    month: number,
  ): Promise<{ date: string; type: string; name: string }[]> {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

    const entries = await this.db.schoolCalendar.findMany({
      where: {
        schoolId,
        isActive: true,
        type: { in: ['Holiday', 'Break', 'HalfDay'] },
        date: { lte: end },
        OR: [
          { endDate: null, date: { gte: start } },
          { endDate: { gte: start } },
        ],
      },
    });

    const dates: { date: string; type: string; name: string }[] = [];
    for (const entry of entries) {
      const rangeEnd = entry.endDate ?? entry.date;
      const cur = new Date(entry.date);
      while (cur <= rangeEnd && cur <= end) {
        if (cur >= start) {
          dates.push({
            date: cur.toISOString().split('T')[0],
            type: entry.type,
            name: entry.name,
          });
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }
    return dates;
  }

  async getCompensatoryDatesForMonth(
    schoolId: string,
    year: number,
    month: number,
  ): Promise<string[]> {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

    const entries = await this.db.schoolCalendar.findMany({
      where: {
        schoolId,
        isActive: true,
        type: 'CompensatoryWork',
        date: { gte: start, lte: end },
      },
    });

    const dates: string[] = [];
    for (const entry of entries) {
      const rangeEnd = entry.endDate ?? entry.date;
      const cur = new Date(entry.date);
      while (cur <= rangeEnd && cur <= end) {
        if (cur >= start) dates.push(cur.toISOString().split('T')[0]);
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }
    return dates;
  }
}
