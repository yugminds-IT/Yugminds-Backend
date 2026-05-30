import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class TeacherAttendanceService {
  constructor(private readonly db: DatabaseService) {}

  private toDateOnly(dateStr: string): Date {
    const d = new Date(dateStr + 'T12:00:00.000Z');
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  /**
   * Get today's attendance status and report progress for the teacher.
   */
  async getToday(teacherId: number, schoolId?: string, dateStr?: string) {
    const date = dateStr ? this.toDateOnly(dateStr) : new Date();
    const dateStart = new Date(date);
    dateStart.setUTCHours(0, 0, 0, 0);
    const dateEnd = new Date(date);
    dateEnd.setUTCHours(23, 59, 59, 999);

    const schoolIds = schoolId
      ? [schoolId]
      : (
          await this.db.teacherSchool.findMany({
            where: { teacherId },
            select: { schoolId: true },
          })
        ).map((s) => s.schoolId);

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
    };

    if (schoolIds.length === 0) return result;

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
        schoolId: { in: schoolIds },
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

    const scheduled = schedules.map((s) => {
      const p = periodById.get(s.periodId);
      return {
        period_id: s.periodId,
        grade: (s as { grade?: string | null }).grade ?? undefined,
        subject: (s as { subject?: string | null }).subject ?? undefined,
        start_time:
          (s as { startTime?: string | null }).startTime ??
          p?.startTime ??
          undefined,
        end_time:
          (s as { endTime?: string | null }).endTime ?? p?.endTime ?? undefined,
      };
    });

    const uniquePeriodIds = Array.from(
      new Set(scheduled.map((p) => p.period_id).filter(Boolean)),
    );

    // 2. Check for submitted reports
    const reports =
      uniquePeriodIds.length > 0
        ? await this.db.teacherReport.findMany({
            where: {
              teacherId,
              schoolId: { in: schoolIds },
              reportDate: { gte: dateStart, lte: dateEnd },
              periodId: { in: uniquePeriodIds },
            },
            select: { periodId: true },
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
      where: { teacherId, schoolId: { in: schoolIds }, date: dateStart },
    });

    // 4. Check for leave
    const leave = await this.db.teacherLeave.findFirst({
      where: {
        teacherId,
        schoolId: { in: schoolIds },
        startDate: { lte: dateEnd },
        endDate: { gte: dateStart },
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
      // Inferred status
      status =
        result.totalPeriods > 0
          ? result.periodsWithReports >= result.totalPeriods
            ? 'Present'
            : 'Unreported'
          : 'Unreported';
    }
    result.attendance = { status, date: result.date };
    return result;
  }

  /**
   * Calculate actual working days for a teacher in a given month.
   * Uses ClassSchedule (dayOfWeek) to find scheduled days, then subtracts
   * school holidays/breaks from SchoolCalendar, and adds CompensatoryWork days.
   */
  private async getScheduledWorkingDays(
    teacherId: number,
    schoolId: string,
    year: number,
    month: number,
  ): Promise<number> {
    // Get distinct scheduled days of week for this teacher
    const schedules = await this.db.classSchedule.findMany({
      where: { teacherId, schoolId, isActive: true },
      select: { dayOfWeek: true },
      distinct: ['dayOfWeek'],
    });

    if (schedules.length === 0) return 0;

    const scheduledDays = new Set(schedules.map((s) => s.dayOfWeek));

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

    // Walk through every day in the month
    let workingDays = 0;
    const cur = new Date(monthStart);
    while (cur <= monthEnd) {
      const dateStr = cur.toISOString().split('T')[0];
      const dow = cur.getUTCDay();

      if (compensatoryDates.has(dateStr)) {
        // Compensatory working days always count (even if weekend)
        workingDays += holidayDates.has(dateStr)
          ? 0
          : halfDayDates.has(dateStr)
            ? 0.5
            : 1;
      } else if (scheduledDays.has(dow) && !holidayDates.has(dateStr)) {
        workingDays += halfDayDates.has(dateStr) ? 0.5 : 1;
      }

      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    return workingDays;
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

    const primarySchoolId = schoolIds[0];

    const monthlyData = await Promise.all(
      months.map(async ({ year, month }) => {
        const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
        const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
        const monthKey = `${year}-${String(month).padStart(2, '0')}`;

        const [attendanceRecords, leaveRecords, scheduleWorkingDays] =
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
            this.getScheduledWorkingDays(
              teacherId,
              primarySchoolId,
              year,
              month,
            ),
          ]);

        const presentDayDates = new Set(
          attendanceRecords
            .filter((a) => a.status === 'Present')
            .map((a) => a.date.toISOString().split('T')[0]),
        );
        const presentDays = presentDayDates.size;

        // Calculate leave days (only on scheduled working days), excluding days where present
        let leaveDays = 0;
        const processedLeaveDates = new Set<string>();

        leaveRecords.forEach((l) => {
          const overlapStart = l.startDate > start ? l.startDate : start;
          const overlapEnd = l.endDate < end ? l.endDate : end;
          const current = new Date(overlapStart);
          while (current <= overlapEnd) {
            const dateStr = current.toISOString().split('T')[0];
            if (
              !presentDayDates.has(dateStr) &&
              !processedLeaveDates.has(dateStr)
            ) {
              leaveDays++;
              processedLeaveDates.add(dateStr);
            }
            current.setUTCDate(current.getUTCDate() + 1);
          }
        });

        const absentDays = attendanceRecords.filter(
          (a) => a.status === 'Absent',
        ).length;
        const unreportedDays = attendanceRecords.filter(
          (a) => a.status === 'Unreported',
        ).length;

        // Use schedule-based working days as denominator when available
        // Fallback to sum of recorded statuses if no schedule exists
        const totalWorkingDays =
          scheduleWorkingDays > 0
            ? scheduleWorkingDays
            : presentDays + absentDays + leaveDays + unreportedDays;

        const attendancePercentage =
          totalWorkingDays > 0
            ? Math.round((presentDays / totalWorkingDays) * 100)
            : 0;

        return {
          month: monthKey,
          school_id: primarySchoolId,
          present_days: presentDays,
          absent_days: absentDays,
          leave_days: leaveDays,
          unreported_days: unreportedDays,
          total_working_days: Math.round(totalWorkingDays),
          attendance_percentage: attendancePercentage,
        };
      }),
    );
    return { monthlyData };
  }

  /**
   * List daily attendance records for a date range.
   */
  async list(teacherId: number, schoolId?: string, from?: string, to?: string) {
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
    return {
      attendance: records.map((r) => ({
        id: r.id,
        school_id: r.schoolId,
        date: r.date.toISOString().split('T')[0],
        status: r.status,
        recorded_at: r.createdAt.toISOString(),
      })),
    };
  }
}
