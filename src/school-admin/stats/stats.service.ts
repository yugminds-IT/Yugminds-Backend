import { Injectable, NotFoundException } from '@nestjs/common';
import { SchoolPerformanceService } from './performance.service';
import { ExamAnalyticsService } from '../../common/assignment/exam-analytics.service';
import { AssignmentReportService } from '../../common/assignment/assignment-report.service';
import { DatabaseService } from '../../database/database.service';
import { AdminTeacherAttendanceService } from '../../admin/teacher-attendance/teacher-attendance.service';

@Injectable()
export class SchoolAdminStatsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly teacherAttendance: AdminTeacherAttendanceService,
    private readonly performance: SchoolPerformanceService,
    private readonly examAnalytics: ExamAnalyticsService,
    private readonly assignmentReport: AssignmentReportService,
  ) {}

  private async schoolIdOf(user: { id: number }) {
    const sa = await this.db.schoolAdmin.findFirst({
      where: { userId: user.id },
      select: { schoolId: true },
    });
    return sa?.schoolId ?? null;
  }

  async getLeaderboard(user: { id: number }) {
    const schoolId = await this.schoolIdOf(user);
    if (!schoolId)
      return {
        leaderboard: [],
        summary: {},
        grade_breakdown: [],
        section_breakdown: [],
        subject_breakdown: [],
        daily_subject_breakdown: [],
        assignment_table: [],
      };
    return this.performance.getLeaderboard(schoolId);
  }

  async getExamAnalytics(user: { id: number }) {
    const schoolId = await this.schoolIdOf(user);
    return {
      analytics: await this.examAnalytics.compute(schoolId ? [schoolId] : []),
    };
  }

  async getAssignmentReport(user: { id: number }, assignmentId: string) {
    const schoolId = await this.schoolIdOf(user);
    if (!schoolId) throw new NotFoundException('Assignment not found');
    return this.assignmentReport.get(assignmentId, schoolId);
  }

  async getAssignmentMarks(user: { id: number }, assignmentId: string) {
    const schoolId = await this.schoolIdOf(user);
    if (!schoolId) throw new NotFoundException('Assignment not found');
    return this.performance.getAssignmentMarks(schoolId, assignmentId);
  }

  async get(user: { id: number; tenantId?: string }) {
    const sa = await this.db.schoolAdmin.findFirst({
      where: { userId: user.id },
      select: { schoolId: true },
    });
    const schoolId = sa?.schoolId ?? null;
    if (!schoolId) {
      return {
        totalStudents: 0,
        totalTeachers: 0,
        activeCourses: 0,
        pendingReports: 0,
        pendingLeaves: 0,
        pendingEmergencyLeaves: 0,
        averageAttendance: 0,
      };
    }

    const [
      totalStudents,
      totalTeachers,
      activeCourses,
      pendingReports,
      pendingLeaves,
      pendingEmergencyLeaves,
    ] = await Promise.all([
      this.db.studentSchool.count({ where: { schoolId, isActive: true } }),
      // Only active teacher accounts — an unfiltered teacherSchool count kept
      // deactivated teachers in the total and disagreed with the admin
      // dashboard, which counts active users only.
      this.db.teacherSchool.count({
        where: { schoolId, teacher: { isActive: true } },
      }),
      this.db.courseAccess.count({
        where: {
          schoolId,
          course: { isPublished: true },
        },
      }),
      this.db.teacherReport.count({ where: { schoolId, status: 'submitted' } }),
      // TeacherLeave.teacherId has no enforced FK — exclude rows orphaned by
      // a hard-deleted teacher (see AdminDashboardService.getStats()).
      this.db.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT COUNT(*)::bigint as count FROM "TeacherLeave" tl JOIN "User" u ON u.id = tl."teacherId" WHERE tl."schoolId" = ${schoolId} AND tl.status = 'pending'`.then(
        (rows) => Number(rows[0]?.count ?? 0),
      ),
      // Of those, how many are emergency leaves (shown separately on the dashboard).
      this.db.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT COUNT(*)::bigint as count FROM "TeacherLeave" tl JOIN "User" u ON u.id = tl."teacherId" WHERE tl."schoolId" = ${schoolId} AND tl.status = 'pending' AND tl."leaveType" = 'Emergency'`.then(
        (rows) => Number(rows[0]?.count ?? 0),
      ),
    ]);

    const averageAttendance =
      await this.teacherAttendance.averageRate(schoolId);

    return {
      totalStudents,
      totalTeachers,
      activeCourses,
      pendingReports,
      pendingLeaves,
      pendingEmergencyLeaves,
      averageAttendance,
    };
  }
}
