import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { StudentRankingService } from '../../common/assignment/student-ranking.service';

@Injectable()
export class SchoolAdminStatsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly studentRanking: StudentRankingService,
  ) {}

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
        averageAttendance: 0,
      };
    }

    const since = new Date();
    since.setDate(since.getDate() - 30);

    const [
      totalStudents,
      totalTeachers,
      activeCourses,
      pendingReports,
      pendingLeaves,
      attendanceAgg,
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
      this.db
        .$queryRaw<
          Array<{ count: bigint }>
        >`SELECT COUNT(*)::bigint as count FROM "TeacherLeave" tl JOIN "User" u ON u.id = tl."teacherId" WHERE tl."schoolId" = ${schoolId} AND tl.status = 'pending'`
        .then((rows) => Number(rows[0]?.count ?? 0)),
      this.db.attendance.groupBy({
        by: ['status'],
        where: { schoolId, date: { gte: since } },
        _count: { _all: true },
      }),
    ]);

    let totalAttendance = 0;
    let presentAttendance = 0;
    for (const row of attendanceAgg ?? []) {
      const c = row._count?._all ?? 0;
      totalAttendance += c;
      if (String(row.status ?? '').toLowerCase() === 'present')
        presentAttendance += c;
    }
    const averageAttendance =
      totalAttendance > 0
        ? Math.round((presentAttendance / totalAttendance) * 100)
        : 0;

    return {
      totalStudents,
      totalTeachers,
      activeCourses,
      pendingReports,
      pendingLeaves,
      averageAttendance,
    };
  }

  async getLeaderboard(user: { id: number }) {
    const sa = await this.db.schoolAdmin.findFirst({
      where: { userId: user.id },
      select: { schoolId: true },
    });
    const schoolId = sa?.schoolId ?? null;
    if (!schoolId)
      return {
        leaderboard: [],
        summary: {},
        grade_breakdown: [],
        subject_breakdown: [],
        assignment_table: [],
      };

    const [schoolInfo, totalStudents] = await Promise.all([
      this.db.school.findUnique({
        where: { id: schoolId },
        select: { name: true },
      }),
      this.db.studentSchool.count({ where: { schoolId, isActive: true } }),
    ]);

    // Get all students in school with their profile and enrollment info
    const enrollments = await this.db.studentSchool.findMany({
      where: { schoolId, isActive: true },
      include: { student: { include: { profile: true } } },
    });

    const studentIds = enrollments.map((e) => e.studentId);

    // Get all school-scoped assignments (daily, published only) + course assignments accessible by school
    const [schoolAssignments, courseAccess] = await Promise.all([
      this.db.assignment.findMany({
        where: { schoolId, isPublished: true },
        select: {
          id: true,
          assignmentType: true,
          totalMarks: true,
          retakeScoringRule: true,
          title: true,
          subject: true,
          isPublished: true,
          gradeId: true,
          createdAt: true,
        },
      }),
      this.db.courseAccess.findMany({
        where: { schoolId },
        select: { courseId: true },
      }),
    ]);

    const accessibleCourseIds = [
      ...new Set(courseAccess.map((c) => c.courseId)),
    ];
    const courseAssignmentsFromLibrary = accessibleCourseIds.length
      ? await this.db.assignment.findMany({
          where: {
            assignmentType: 'COURSE',
            isPublished: true,
            OR: [
              { courseId: { in: accessibleCourseIds } },
              { chapter: { courseId: { in: accessibleCourseIds } } },
            ],
          },
          select: {
            id: true,
            assignmentType: true,
            totalMarks: true,
            retakeScoringRule: true,
            title: true,
            subject: true,
            isPublished: true,
            gradeId: true,
            createdAt: true,
          },
        })
      : [];

    // Merge, deduplicate
    const allAssignmentsMap = new Map(schoolAssignments.map((a) => [a.id, a]));
    for (const a of courseAssignmentsFromLibrary) {
      if (!allAssignmentsMap.has(a.id)) allAssignmentsMap.set(a.id, a);
    }
    const allAssignments = [...allAssignmentsMap.values()];

    const publishedCount = allAssignments.filter((a) => a.isPublished).length;
    const courseAssignmentIds = allAssignments
      .filter((a) => (a as any).assignmentType === 'COURSE')
      .map((a) => a.id);
    const dailyAssignmentIds = allAssignments
      .filter((a) => (a as any).assignmentType !== 'COURSE')
      .map((a) => a.id);

    const allSubmissions =
      studentIds.length && allAssignments.length
        ? await this.db.assignmentSubmission.findMany({
            where: {
              studentId: { in: studentIds },
              assignmentId: { in: allAssignments.map((a) => a.id) },
            },
            select: {
              studentId: true,
              assignmentId: true,
              score: true,
              maxScore: true,
              attemptNumber: true,
              status: true,
              submittedAt: true,
            },
            orderBy: [
              { studentId: 'asc' },
              { assignmentId: 'asc' },
              { attemptNumber: 'asc' },
            ],
          })
        : [];

    // Canonical deduplication: graded-only, respect retakeScoringRule per assignment
    const asgnRuleMap = new Map(
      allAssignments.map((a) => [
        a.id,
        String((a as any).retakeScoringRule ?? 'latest').toLowerCase(),
      ]),
    );
    const bestByKey = new Map<string, (typeof allSubmissions)[0]>();
    for (const sub of allSubmissions) {
      if (sub.status !== 'graded') continue;
      const key = `${sub.studentId}:${sub.assignmentId}`;
      const rule = asgnRuleMap.get(sub.assignmentId) ?? 'latest';
      const existing = bestByKey.get(key);
      if (!existing) {
        bestByKey.set(key, sub);
      } else if (
        rule === 'highest' &&
        Number(sub.score ?? 0) > Number(existing.score ?? 0)
      ) {
        bestByKey.set(key, sub);
      } else if (rule !== 'highest') {
        // latest: ascending order means last write wins
        bestByKey.set(key, sub);
      }
    }
    const bestSubmissions = [...bestByKey.values()];

    // Student leaderboard — canonical scores/ranks from the shared service,
    // scoped to this school. Keeps all dashboards in agreement.
    const { rows: saGlobalRows } = await this.studentRanking.getGlobalRanking();
    const ranked = this.studentRanking
      .buildLeaderboard(saGlobalRows.filter((r) => r.schoolId === schoolId))
      .map((r) => ({
        student_id: r.student_id,
        student_name: r.student_name,
        grade: r.grade,
        section: r.section,
        course_assignment_score: r.course_score,
        daily_assignment_score: r.daily_score,
        overall_score: r.overall_score,
        assignments_attempted: r.graded_count,
        graded_assignments_count: r.graded_count,
        badge: r.badge,
        rank: r.rank,
        school_rank: r.school_rank,
        grade_rank: r.grade_rank,
        section_rank: r.section_rank,
      }));

    // Grade breakdown
    const gradeMap = new Map<
      string,
      {
        courseTotal: number;
        courseMax: number;
        dailyTotal: number;
        dailyMax: number;
      }
    >();
    for (const sub of bestSubmissions) {
      const enrollment = enrollments.find((e) => e.studentId === sub.studentId);
      const grade = enrollment?.grade ?? 'Unknown';
      const g = gradeMap.get(grade) ?? {
        courseTotal: 0,
        courseMax: 0,
        dailyTotal: 0,
        dailyMax: 0,
      };
      const isCourse = courseAssignmentIds.includes(sub.assignmentId);
      if (isCourse) {
        g.courseTotal += Number(sub.score ?? 0);
        g.courseMax += Number(sub.maxScore ?? 0);
      } else {
        g.dailyTotal += Number(sub.score ?? 0);
        g.dailyMax += Number(sub.maxScore ?? 0);
      }
      gradeMap.set(grade, g);
    }
    const grade_breakdown = [...gradeMap.entries()]
      .map(([grade, g]) => ({
        grade,
        avg_course_score:
          g.courseMax > 0
            ? Number(((g.courseTotal / g.courseMax) * 100).toFixed(2))
            : 0,
        avg_daily_score:
          g.dailyMax > 0
            ? Number(((g.dailyTotal / g.dailyMax) * 100).toFixed(2))
            : 0,
        avg_overall: Number(
          (
            (g.courseMax > 0 ? (g.courseTotal / g.courseMax) * 100 * 0.6 : 0) +
            (g.dailyMax > 0 ? (g.dailyTotal / g.dailyMax) * 100 * 0.4 : 0)
          ).toFixed(2),
        ),
      }))
      .sort((a, b) => b.avg_overall - a.avg_overall);

    // Subject breakdown
    const subjectMap = new Map<string, { total: number; max: number }>();
    for (const sub of bestSubmissions) {
      const asgn = allAssignments.find((a) => a.id === sub.assignmentId);
      const subj = asgn?.subject ?? 'General';
      const s = subjectMap.get(subj) ?? { total: 0, max: 0 };
      s.total += Number(sub.score ?? 0);
      s.max += Number(sub.maxScore ?? 0);
      subjectMap.set(subj, s);
    }
    const subject_breakdown = [...subjectMap.entries()]
      .map(([subject, s]) => ({
        subject,
        avg_score: s.max > 0 ? Number(((s.total / s.max) * 100).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.avg_score - a.avg_score);

    // Assignment table
    const assignment_table = allAssignments
      .filter((a) => a.isPublished)
      .map((a) => {
        const subs = bestSubmissions.filter((s) => s.assignmentId === a.id);
        const submittedCount = new Set(subs.map((s) => s.studentId)).size;
        const scores = subs.map((s) => Number(s.score ?? 0));
        const avg = scores.length
          ? Number(
              (scores.reduce((x, y) => x + y, 0) / scores.length).toFixed(2),
            )
          : 0;
        const high = scores.length ? Math.max(...scores) : 0;
        const low = scores.length ? Math.min(...scores) : 0;
        const targetedStudents = totalStudents;
        return {
          assignment_id: a.id,
          title: a.title,
          assignment_type: (a as any).assignmentType ?? 'COURSE',
          subject: a.subject,
          total_submissions: submittedCount,
          avg_score: avg,
          highest_score: high,
          lowest_score: low,
          completion_rate:
            targetedStudents > 0
              ? Number(((submittedCount / targetedStudents) * 100).toFixed(2))
              : 0,
        };
      });

    const overallAvg = ranked.length
      ? Number(
          (
            ranked.reduce((s, r) => s + r.overall_score, 0) / ranked.length
          ).toFixed(2),
        )
      : 0;

    return {
      summary: {
        school_name: schoolInfo?.name ?? '',
        total_students: totalStudents,
        total_assignments_published: publishedCount,
        course_assignments_published: courseAssignmentIds.length,
        daily_assignments_published: dailyAssignmentIds.length,
        overall_avg_score: overallAvg,
      },
      leaderboard: ranked,
      grade_breakdown,
      subject_breakdown,
      assignment_table,
    };
  }
}
