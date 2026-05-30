import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class SchoolAdminStatsService {
  constructor(private readonly db: DatabaseService) {}

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
      this.db.teacherSchool.count({ where: { schoolId } }),
      this.db.courseAccess.count({
        where: {
          schoolId,
          course: { isPublished: true },
        },
      }),
      this.db.teacherReport.count({ where: { schoolId, status: 'submitted' } }),
      this.db.teacherLeave.count({ where: { schoolId, status: 'pending' } }),
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

  async getAssignmentAnalytics(user: { id: number; tenantId?: string }) {
    const sa = await this.db.schoolAdmin.findFirst({
      where: { userId: user.id },
      select: { schoolId: true },
    });
    const schoolId = sa?.schoolId ?? null;
    if (!schoolId) {
      return {
        summary: {},
        grade_wise: [],
        subject_wise: [],
        top_students: [],
        low_students: [],
        retake_stats: [],
      };
    }

    const schoolCourseAccess = await this.db.courseAccess.findMany({
      where: { schoolId },
      select: { courseId: true },
    });
    const courseIds = [...new Set(schoolCourseAccess.map((c) => c.courseId))];
    const assignments = await this.db.assignment.findMany({
      where: {
        isPublished: true,
        OR: [
          { schoolId },
          { courseId: { in: courseIds } },
          { chapter: { courseId: { in: courseIds } } },
        ],
      },
      select: {
        id: true,
        gradeId: true,
        subject: true,
        retakeEnabled: true,
        title: true,
      },
    });
    const assignmentIds = assignments.map((a) => a.id);
    const submissions = assignmentIds.length
      ? await this.db.assignmentSubmission.findMany({
          where: { assignmentId: { in: assignmentIds } },
          include: { student: { include: { profile: true } } },
        })
      : [];

    const gradeWiseMap = new Map<
      string,
      { total: number; max: number; count: number }
    >();
    const subjectWiseMap = new Map<
      string,
      { total: number; max: number; count: number }
    >();
    const retakeMap = new Map<
      string,
      {
        assignmentTitle: string;
        totalAttempts: number;
        retakeAttempts: number;
        avgDelta: number;
        deltas: number[];
      }
    >();
    const studentAgg = new Map<
      number,
      { name: string; score: number; max: number }
    >();

    for (const sub of submissions) {
      const assignment = assignments.find((a) => a.id === sub.assignmentId);
      if (!assignment) continue;
      const gradeKey = assignment.gradeId ?? 'Unknown Grade';
      const subjectKey = assignment.subject ?? 'General';
      const score = Number(sub.score ?? 0);
      const max = Number(sub.maxScore ?? 0);

      const g = gradeWiseMap.get(gradeKey) ?? { total: 0, max: 0, count: 0 };
      g.total += score;
      g.max += max;
      g.count += 1;
      gradeWiseMap.set(gradeKey, g);

      const s = subjectWiseMap.get(subjectKey) ?? {
        total: 0,
        max: 0,
        count: 0,
      };
      s.total += score;
      s.max += max;
      s.count += 1;
      subjectWiseMap.set(subjectKey, s);

      const st = studentAgg.get(sub.studentId) ?? {
        name:
          sub.student.profile?.fullName ??
          sub.student.email ??
          `Student ${sub.studentId}`,
        score: 0,
        max: 0,
      };
      st.score += score;
      st.max += max;
      studentAgg.set(sub.studentId, st);

      if (assignment.retakeEnabled) {
        const rt = retakeMap.get(sub.assignmentId) ?? {
          assignmentTitle: assignment.title,
          totalAttempts: 0,
          retakeAttempts: 0,
          avgDelta: 0,
          deltas: [],
        };
        rt.totalAttempts += 1;
        if (sub.attemptNumber > 1) rt.retakeAttempts += 1;
        retakeMap.set(sub.assignmentId, rt);
      }
    }

    // Approx retake improvement delta by student+assignment latest-first gap
    const grouped = new Map<string, typeof submissions>();
    for (const s of submissions) {
      const key = `${s.assignmentId}:${s.studentId}`;
      const arr = grouped.get(key) ?? [];
      arr.push(s);
      grouped.set(key, arr);
    }
    for (const [key, rows] of grouped) {
      const [assignmentId] = key.split(':');
      const retake = retakeMap.get(assignmentId);
      if (!retake) continue;
      const sorted = [...rows].sort(
        (a, b) => a.attemptNumber - b.attemptNumber,
      );
      if (sorted.length > 1) {
        const delta = Number(
          (sorted[sorted.length - 1].score ?? 0) - Number(sorted[0].score ?? 0),
        );
        retake.deltas.push(delta);
      }
    }

    const topRanked = [...studentAgg.entries()]
      .map(([studentId, row]) => ({
        student_id: studentId,
        student_name: row.name,
        cumulative_percentage:
          row.max > 0 ? Number(((row.score / row.max) * 100).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.cumulative_percentage - a.cumulative_percentage);

    const grade_wise = [...gradeWiseMap.entries()].map(([grade_id, agg]) => ({
      grade_id,
      average_percentage:
        agg.max > 0 ? Number(((agg.total / agg.max) * 100).toFixed(2)) : 0,
      attempts: agg.count,
    }));
    const subject_wise = [...subjectWiseMap.entries()].map(
      ([subject, agg]) => ({
        subject,
        average_percentage:
          agg.max > 0 ? Number(((agg.total / agg.max) * 100).toFixed(2)) : 0,
        attempts: agg.count,
      }),
    );
    const retake_stats = [...retakeMap.entries()].map(
      ([assignment_id, row]) => ({
        assignment_id,
        assignment_title: row.assignmentTitle,
        retake_rate:
          row.totalAttempts > 0
            ? Number(
                ((row.retakeAttempts / row.totalAttempts) * 100).toFixed(2),
              )
            : 0,
        improvement_avg: row.deltas.length
          ? Number(
              (
                row.deltas.reduce((a, b) => a + b, 0) / row.deltas.length
              ).toFixed(2),
            )
          : 0,
      }),
    );

    return {
      summary: {
        assignments_count: assignments.length,
        completion_rate:
          assignments.length > 0
            ? Number(
                ((submissions.length / assignments.length) * 100).toFixed(2),
              )
            : 0,
      },
      grade_wise,
      subject_wise,
      top_students: topRanked.slice(0, 10),
      low_students: topRanked.slice(-10).reverse(),
      retake_stats,
    };
  }

  private computeBadge(overallScore: number): string {
    if (overallScore >= 90) return 'GOLD';
    if (overallScore >= 75) return 'SILVER';
    if (overallScore >= 60) return 'BRONZE';
    return 'NONE';
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

    // Build per-student score buckets
    type Bucket = {
      courseScore: number;
      courseMax: number;
      dailyScore: number;
      dailyMax: number;
      attempted: Set<string>;
      graded: Set<string>;
    };
    const studentBuckets = new Map<number, Bucket>();

    for (const sub of bestSubmissions) {
      const cur = studentBuckets.get(sub.studentId) ?? {
        courseScore: 0,
        courseMax: 0,
        dailyScore: 0,
        dailyMax: 0,
        attempted: new Set<string>(),
        graded: new Set<string>(),
      };
      const isCourse = courseAssignmentIds.includes(sub.assignmentId);
      const score = Number(sub.score ?? 0);
      const max = Number(sub.maxScore ?? 0);
      if (isCourse) {
        cur.courseScore += score;
        cur.courseMax += max;
      } else {
        cur.dailyScore += score;
        cur.dailyMax += max;
      }
      cur.attempted.add(sub.assignmentId);
      if (sub.status === 'graded') cur.graded.add(sub.assignmentId);
      studentBuckets.set(sub.studentId, cur);
    }

    const emptyBucket: Bucket = {
      courseScore: 0,
      courseMax: 0,
      dailyScore: 0,
      dailyMax: 0,
      attempted: new Set(),
      graded: new Set(),
    };
    const studentRows = enrollments.map((e) => {
      const bucket = studentBuckets.get(e.studentId) ?? emptyBucket;
      const coursePercent =
        bucket.courseMax > 0
          ? Number(((bucket.courseScore / bucket.courseMax) * 100).toFixed(2))
          : 0;
      const dailyPercent =
        bucket.dailyMax > 0
          ? Number(((bucket.dailyScore / bucket.dailyMax) * 100).toFixed(2))
          : 0;
      const overall = Number(
        (coursePercent * 0.6 + dailyPercent * 0.4).toFixed(2),
      );
      return {
        student_id: e.studentId,
        student_name:
          e.student.profile?.fullName ??
          e.student.email ??
          `Student ${e.studentId}`,
        grade: e.grade ?? '',
        section: e.section ?? '',
        course_assignment_score: coursePercent,
        daily_assignment_score: dailyPercent,
        overall_score: overall,
        assignments_attempted: bucket.attempted.size,
        graded_assignments_count: bucket.graded.size,
        badge: this.computeBadge(overall),
      };
    });

    const ranked = [...studentRows]
      .sort((a, b) => b.overall_score - a.overall_score)
      .map((r, idx) => ({ ...r, rank: idx + 1 }));

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

    const overallAvg = studentRows.length
      ? Number(
          (
            studentRows.reduce((s, r) => s + r.overall_score, 0) /
            studentRows.length
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
