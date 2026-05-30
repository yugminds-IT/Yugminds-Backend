import { ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class TeacherDashboardService {
  constructor(private readonly db: DatabaseService) {}

  private toDateOnly(dateStr: string): Date | null {
    const d = new Date(dateStr + 'T12:00:00.000Z');
    if (isNaN(d.getTime())) return null;
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  async get(teacherId: number, query: { school_id?: string; date?: string }) {
    const schoolId = query.school_id;
    if (schoolId) {
      const assigned = await this.db.teacherSchool.findFirst({
        where: { teacherId, schoolId },
      });
      if (!assigned)
        throw new ForbiddenException('Not assigned to this school');
    }

    const schoolIds = schoolId
      ? [schoolId]
      : (
          await this.db.teacherSchool.findMany({
            where: { teacherId },
            select: { schoolId: true },
          })
        ).map((s) => s.schoolId);

    if (schoolIds.length === 0) {
      return {
        stats: {
          todaysClasses: 0,
          pendingReports: 0,
          totalClasses: 0,
          monthlyAttendance: 0,
          pendingLeaves: 0,
          totalStudents: 0,
        },
        meta: {
          school_ids: [],
          date: query.date ?? new Date().toISOString().split('T')[0],
        },
      };
    }

    const dateStr = query.date ?? new Date().toISOString().split('T')[0];
    const day =
      this.toDateOnly(dateStr) ??
      this.toDateOnly(new Date().toISOString().split('T')[0])!;
    const dayStart = new Date(day);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setUTCHours(23, 59, 59, 999);

    // Classes assigned = teacher section assignments (optionally by school)
    const assignments = await this.db.teacherSectionAssignment.findMany({
      where: {
        teacherId,
        ...(schoolId ? { schoolId } : { schoolId: { in: schoolIds } }),
      },
      include: { section: true },
    });
    const totalClasses = assignments.length;

    // Total students = students in those assigned sections (for this school)
    const bySchool = new Map<string, Set<string>>();
    for (const a of assignments) {
      if (!bySchool.has(a.schoolId)) bySchool.set(a.schoolId, new Set());
      const name = a.section?.name ?? '';
      if (name) bySchool.get(a.schoolId)!.add(name);
    }
    const studentCounts = await Promise.all(
      Array.from(bySchool.entries()).map(async ([sid, sections]) => {
        const sec = Array.from(sections);
        if (sec.length === 0) return 0;
        return this.db.studentSchool.count({
          where: { schoolId: sid, section: { in: sec }, isActive: true },
        });
      }),
    );
    const totalStudents = studentCounts.reduce((sum, n) => sum + n, 0);

    // Today's classes = distinct scheduled periods for this teacher today
    const dayOfWeek = dayStart.getUTCDay();
    const schedulesToday = await this.db.classSchedule.findMany({
      where: {
        teacherId,
        schoolId: { in: schoolIds },
        dayOfWeek,
        isActive: true,
      },
      select: { periodId: true },
    });
    const todaysClasses = new Set(schedulesToday.map((s) => s.periodId)).size;

    // Pending reports = submitted reports today (awaiting approval)
    const pendingReports = await this.db.teacherReport.count({
      where: {
        teacherId,
        schoolId: { in: schoolIds },
        reportDate: { gte: dayStart, lte: dayEnd },
        status: 'submitted',
      },
    });

    // Pending leaves = pending leave requests (created by teacher) scoped to schools
    const pendingLeaves = await this.db.teacherLeave.count({
      where: { teacherId, schoolId: { in: schoolIds }, status: 'pending' },
    });

    // Monthly attendance % = current month present / total days (from Attendance table)
    const monthStart = new Date(
      Date.UTC(
        dayStart.getUTCFullYear(),
        dayStart.getUTCMonth(),
        1,
        0,
        0,
        0,
        0,
      ),
    );
    const monthEnd = new Date(
      Date.UTC(
        dayStart.getUTCFullYear(),
        dayStart.getUTCMonth() + 1,
        0,
        23,
        59,
        59,
        999,
      ),
    );
    const attendanceRows = await this.db.attendance.findMany({
      where: {
        teacherId,
        schoolId: { in: schoolIds },
        date: { gte: monthStart, lte: monthEnd },
      },
      select: { status: true, date: true },
    });
    const presentDays = new Set(
      attendanceRows
        .filter((a) => a.status === 'Present')
        .map((a) => a.date.toISOString().split('T')[0]),
    ).size;
    const totalAttendanceDays = new Set(
      attendanceRows.map((a) => a.date.toISOString().split('T')[0]),
    ).size;
    const monthlyAttendance =
      totalAttendanceDays > 0
        ? Math.round((presentDays / totalAttendanceDays) * 100)
        : 0;

    return {
      stats: {
        todaysClasses,
        pendingReports,
        totalClasses,
        monthlyAttendance,
        pendingLeaves,
        totalStudents,
      },
      meta: { school_ids: schoolIds, date: dateStr },
    };
  }
}
