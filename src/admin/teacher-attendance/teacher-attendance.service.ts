import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Role } from '@prisma/client';

@Injectable()
export class AdminTeacherAttendanceService {
  constructor(private readonly db: DatabaseService) {}

  /** Monday–Friday in UTC (aligned with mark-missing weekend skip). */
  private isUtcWeekday(isoDateStr: string): boolean {
    const d = new Date(`${isoDateStr}T12:00:00.000Z`);
    const w = d.getUTCDay();
    return w !== 0 && w !== 6;
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
  async list(schoolId?: string, teacherId?: string) {
    if (teacherId) {
      const tid = parseInt(teacherId, 10);
      if (isNaN(tid))
        return { summary: null, teacherTodayStatus: {}, attendance: [] };
      const records = await this.db.attendance.findMany({
        where: { teacherId: tid },
        orderBy: { date: 'desc' },
        take: 365,
      });
      return {
        summary: null,
        teacherTodayStatus: {},
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
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
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

    const onLeaveTeacherIds = new Set(leaves.map((l) => l.teacherId));
    let presentToday = 0;
    let absentToday = 0;
    let onLeaveToday = 0;
    const teacherTodayStatus: Record<
      string,
      {
        status: string;
        isOnLeave: boolean;
        leaveType?: string;
        attendanceRate?: number;
      }
    > = {};

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
      // Present from attendance overrides approved leave (teacher marked in).
      if (picked === 'Present') {
        status = 'Present';
        presentToday++;
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
    }

    const totalTeachers = filtered.length;
    const activeCount = activeTeachers.length;
    const attendanceRate =
      activeCount > 0 ? Math.round((presentToday / activeCount) * 100) : 0;

    return {
      summary: {
        totalTeachers,
        presentToday,
        absentToday,
        onLeaveToday,
        attendanceRate,
      },
      teacherTodayStatus,
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
  async monthly(month?: string) {
    const now = new Date();
    const year = month ? parseInt(month.slice(0, 4), 10) : now.getFullYear();
    const monthNum = month
      ? parseInt(month.slice(5, 7), 10)
      : now.getMonth() + 1;
    const start = new Date(Date.UTC(year, monthNum - 1, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(year, monthNum, 0, 23, 59, 59, 999));
    const monthKey = `${year}-${String(monthNum).padStart(2, '0')}`;

    const teachers = await this.db.user.findMany({
      where: { role: Role.teacher, isActive: true },
      include: {
        profile: true,
        teacherSchools: { include: { school: true } },
      },
    });

    const monthlyData: Array<{
      id: string;
      teacher_id: string;
      month: string;
      present_days: number;
      absent_days: number;
      leave_days: number;
      unreported_days: number;
      total_working_days: number;
      attendance_percentage: number;
      profiles: { full_name: string; email: string };
      schools: { name: string; school_code: string };
    }> = [];

    for (const t of teachers) {
      const schoolIds = (t.teacherSchools ?? []).map((ts) => ts.schoolId);
      if (schoolIds.length === 0) continue;

      const primary = t.teacherSchools[0];
      const schoolName = primary.school?.name ?? '';
      const schoolCode = primary.school?.schoolCode ?? '';

      const attendanceRecords = await this.db.attendance.findMany({
        where: {
          teacherId: t.id,
          schoolId: { in: schoolIds },
          date: { gte: start, lte: end },
        },
      });
      const leaveRecords = await this.db.teacherLeave.findMany({
        where: {
          teacherId: t.id,
          schoolId: { in: schoolIds },
          startDate: { lte: end },
          endDate: { gte: start },
          status: 'approved',
        },
      });

      const presentDayDates = new Set(
        attendanceRecords
          .filter((a) => a.status === 'Present')
          .map((a) => a.date.toISOString().split('T')[0])
          .filter((d) => this.isUtcWeekday(d)),
      );
      const presentDays = presentDayDates.size;

      const absentDayDates = new Set(
        attendanceRecords
          .filter((a) => a.status === 'Absent')
          .map((a) => a.date.toISOString().split('T')[0])
          .filter((d) => this.isUtcWeekday(d)),
      );

      const unreportedDayDates = new Set(
        attendanceRecords
          .filter((a) => a.status === 'Unreported')
          .map((a) => a.date.toISOString().split('T')[0])
          .filter((d) => this.isUtcWeekday(d)),
      );

      const leaveDayDates = new Set<string>();
      leaveRecords.forEach((l) => {
        const overlapStart = l.startDate > start ? l.startDate : start;
        const overlapEnd = l.endDate < end ? l.endDate : end;
        const current = new Date(overlapStart);
        while (current <= overlapEnd) {
          const dateStr = current.toISOString().split('T')[0];
          if (this.isUtcWeekday(dateStr)) {
            if (!presentDayDates.has(dateStr) && !leaveDayDates.has(dateStr)) {
              leaveDayDates.add(dateStr);
            }
          }
          current.setUTCDate(current.getUTCDate() + 1);
        }
      });
      const leaveDays = leaveDayDates.size;

      for (const d of presentDayDates) absentDayDates.delete(d);
      for (const d of leaveDayDates) absentDayDates.delete(d);
      for (const d of presentDayDates) unreportedDayDates.delete(d);
      for (const d of leaveDayDates) unreportedDayDates.delete(d);
      for (const d of absentDayDates) unreportedDayDates.delete(d);
      const absentDays = absentDayDates.size;
      const unreportedDays = unreportedDayDates.size;

      const totalWorkingDays = new Set([
        ...presentDayDates,
        ...absentDayDates,
        ...leaveDayDates,
        ...unreportedDayDates,
      ]).size;
      const attendancePercentage =
        totalWorkingDays > 0
          ? Math.round((presentDays / totalWorkingDays) * 100)
          : 0;

      monthlyData.push({
        id: `${t.id}-${monthKey}`,
        teacher_id: String(t.id),
        month: monthKey,
        present_days: presentDays,
        absent_days: absentDays,
        leave_days: leaveDays,
        unreported_days: unreportedDays,
        total_working_days: totalWorkingDays,
        attendance_percentage: attendancePercentage,
        profiles: {
          full_name: t.profile?.fullName ?? '',
          email: t.email,
        },
        schools: { name: schoolName, school_code: schoolCode },
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
  async markMissing(body: { start_date: string; end_date: string }) {
    const start = this.toDateOnly(body.start_date);
    const end = this.toDateOnly(body.end_date);
    end.setUTCHours(23, 59, 59, 999);

    const teachers = await this.db.teacherSchool.findMany({
      select: { teacherId: true, schoolId: true },
    });
    const existing = await this.db.attendance.findMany({
      where: { date: { gte: start, lte: end } },
    });
    const existingSet = new Set(
      existing.map(
        (e) =>
          `${e.teacherId}-${e.schoolId}-${e.date.toISOString().split('T')[0]}`,
      ),
    );

    let recordsCreated = 0;
    const datesAffected = new Set<string>();
    const teachersAffected = new Set<number>();

    for (const { teacherId, schoolId } of teachers) {
      for (
        let d = new Date(start);
        d <= end;
        d.setUTCDate(d.getUTCDate() + 1)
      ) {
        const dow = d.getUTCDay();
        if (dow === 0 || dow === 6) continue;
        const dateStr = d.toISOString().split('T')[0];
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
        teachers_affected: teachersAffected.size,
        dates_affected: datesAffected.size,
      },
    };
  }
}
