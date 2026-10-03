import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { StudentRankingService } from '../../common/assignment/student-ranking.service';
import { overallScore } from '../../common/assignment/overall-score';

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
      this.db.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT COUNT(*)::bigint as count FROM "TeacherLeave" tl JOIN "User" u ON u.id = tl."teacherId" WHERE tl."schoolId" = ${schoolId} AND tl.status = 'pending'`.then(
        (rows) => Number(rows[0]?.count ?? 0),
      ),
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

  /** Published daily assignments of this school + course assignments from courses it can access. */
  private async schoolAssignments(schoolId: string) {
    const select = {
      id: true,
      assignmentType: true,
      totalMarks: true,
      retakeScoringRule: true,
      title: true,
      subject: true,
      isPublished: true,
      gradeId: true,
      createdAt: true,
      publishScope: true,
      publishedGradeIds: true,
      publishedSectionIds: true,
      courseId: true,
      chapter: { select: { courseId: true } },
    } as const;
    const [schoolAssignments, courseAccess] = await Promise.all([
      this.db.assignment.findMany({
        where: { schoolId, isPublished: true },
        select,
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
          select,
        })
      : [];

    const byId = new Map(schoolAssignments.map((a) => [a.id, a]));
    for (const a of courseAssignmentsFromLibrary) {
      if (!byId.has(a.id)) byId.set(a.id, a);
    }
    return [...byId.values()];
  }

  /**
   * Returns a function giving how many of this school's students an
   * assignment was published to: its sections, else its grades, else (course
   * assignments) the grades the course is shared with, else the whole school.
   */
  private async audienceCounter(
    schoolId: string,
    assignments: Awaited<
      ReturnType<SchoolAdminStatsService['schoolAssignments']>
    >,
    enrollments: Array<{ grade: string | null; section: string | null }>,
  ) {
    const gradeIds = new Set<string>();
    const sectionIds = new Set<string>();
    for (const a of assignments) {
      a.publishedGradeIds.forEach((id) => gradeIds.add(id));
      if (a.gradeId) gradeIds.add(a.gradeId);
      a.publishedSectionIds.forEach((id) => sectionIds.add(id));
    }
    const [grades, sections, courseAccess] = await Promise.all([
      this.db.grade.findMany({
        where: { id: { in: [...gradeIds] } },
        select: { id: true, name: true },
      }),
      this.db.section.findMany({
        where: { id: { in: [...sectionIds] } },
        select: { id: true, name: true, grade: { select: { name: true } } },
      }),
      this.db.courseAccess.findMany({
        where: { schoolId },
        select: {
          courseId: true,
          gradeAccess: { select: { gradeName: true } },
        },
      }),
    ]);
    const gradeName = new Map(grades.map((g) => [g.id, g.name]));
    const sectionClass = new Map(
      sections.map((s) => [s.id, `${s.grade.name}::${s.name}`]),
    );
    const courseGrades = new Map(
      courseAccess.map((c) => [
        c.courseId,
        c.gradeAccess.map((g) => g.gradeName),
      ]),
    );
    const byGrade = new Map<string, number>();
    const byClass = new Map<string, number>();
    for (const e of enrollments) {
      const g = e.grade ?? '';
      byGrade.set(g, (byGrade.get(g) ?? 0) + 1);
      const c = `${g}::${e.section ?? ''}`;
      byClass.set(c, (byClass.get(c) ?? 0) + 1);
    }
    const sumOf = (keys: Iterable<string>, counts: Map<string, number>) =>
      [...new Set(keys)].reduce((n, k) => n + (counts.get(k) ?? 0), 0);

    return (a: (typeof assignments)[number]): number => {
      if (a.publishScope === 'section' && a.publishedSectionIds.length) {
        return sumOf(
          a.publishedSectionIds
            .map((id) => sectionClass.get(id))
            .filter((c): c is string => !!c),
          byClass,
        );
      }
      const ids = a.publishedGradeIds.length
        ? a.publishedGradeIds
        : a.gradeId
          ? [a.gradeId]
          : [];
      if (ids.length) {
        return sumOf(
          ids.map((id) => gradeName.get(id)).filter((n): n is string => !!n),
          byGrade,
        );
      }
      const courseId = a.courseId ?? a.chapter?.courseId;
      const shared = courseId ? courseGrades.get(courseId) : undefined;
      if (a.assignmentType === 'COURSE' && shared?.length) {
        return sumOf(shared, byGrade);
      }
      return enrollments.length;
    };
  }

  /**
   * Per-student marks for one assignment, limited to this school's students.
   * The score shown follows the assignment's retake scoring rule, same as the
   * teacher's Submissions tab and the leaderboard.
   */
  async getAssignmentMarks(user: { id: number }, assignmentId: string) {
    const sa = await this.db.schoolAdmin.findFirst({
      where: { userId: user.id },
      select: { schoolId: true },
    });
    const schoolId = sa?.schoolId;
    if (!schoolId) throw new NotFoundException('Assignment not found');

    const assignment = (await this.schoolAssignments(schoolId)).find(
      (a) => a.id === assignmentId,
    );
    if (!assignment) throw new NotFoundException('Assignment not found');

    const enrollments = await this.db.studentSchool.findMany({
      where: { schoolId, isActive: true },
      select: {
        studentId: true,
        grade: true,
        section: true,
        student: {
          select: { email: true, profile: { select: { fullName: true } } },
        },
      },
    });
    const enrollmentById = new Map(enrollments.map((e) => [e.studentId, e]));

    const submissions = await this.db.assignmentSubmission.findMany({
      where: {
        assignmentId,
        studentId: { in: enrollments.map((e) => e.studentId) },
      },
      select: {
        studentId: true,
        attemptNumber: true,
        status: true,
        score: true,
        maxScore: true,
        submittedAt: true,
      },
      orderBy: [{ studentId: 'asc' }, { attemptNumber: 'asc' }],
    });

    const rule = String(assignment.retakeScoringRule ?? 'latest').toLowerCase();
    type Sub = (typeof submissions)[number];
    const byStudent = new Map<
      number,
      { attempts: number; latest: Sub; counted: Sub | null }
    >();
    for (const s of submissions) {
      const row = byStudent.get(s.studentId) ?? {
        attempts: 0,
        latest: s,
        counted: null,
      };
      row.attempts++;
      row.latest = s;
      if (s.status === 'graded' && s.score != null) {
        if (
          rule !== 'highest' ||
          !row.counted ||
          (row.counted.score ?? -1) < s.score
        ) {
          row.counted = s;
        }
      }
      byStudent.set(s.studentId, row);
    }

    const students = [...byStudent.entries()]
      .map(([studentId, row]) => {
        const e = enrollmentById.get(studentId);
        const counted = row.counted;
        const max = counted?.maxScore ?? assignment.totalMarks ?? null;
        return {
          student_id: studentId,
          student_name:
            e?.student.profile?.fullName ??
            e?.student.email ??
            `Student ${studentId}`,
          grade: e?.grade ?? null,
          section: e?.section ?? null,
          attempts: row.attempts,
          score: counted?.score ?? null,
          max_score: max,
          percent:
            counted?.score != null && max
              ? Math.round((counted.score / max) * 100)
              : null,
          status: counted ? 'graded' : 'pending',
          submitted_at: row.latest.submittedAt.toISOString(),
        };
      })
      .sort((a, b) => a.student_name.localeCompare(b.student_name));

    return {
      assignment: {
        id: assignment.id,
        title: assignment.title,
        assignment_type: assignment.assignmentType ?? 'COURSE',
        subject: assignment.subject,
        total_marks: assignment.totalMarks,
        scoring_rule: rule,
      },
      students,
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
        section_breakdown: [],
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

    const allAssignments = await this.schoolAssignments(schoolId);

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
        avg_overall: overallScore(
          g.courseMax > 0 ? (g.courseTotal / g.courseMax) * 100 : null,
          g.dailyMax > 0 ? (g.dailyTotal / g.dailyMax) * 100 : null,
        ),
      }))
      .sort((a, b) => b.avg_overall - a.avg_overall);

    // Section breakdown (grade + section)
    const sectionMap = new Map<
      string,
      {
        grade: string;
        section: string;
        courseTotal: number;
        courseMax: number;
        dailyTotal: number;
        dailyMax: number;
      }
    >();
    for (const sub of bestSubmissions) {
      const enrollment = enrollments.find((e) => e.studentId === sub.studentId);
      const grade = enrollment?.grade ?? 'Unknown';
      const section = String(enrollment?.section ?? '').trim();
      const key = `${grade}\0${section}`;
      const g = sectionMap.get(key) ?? {
        grade,
        section,
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
      sectionMap.set(key, g);
    }
    const section_breakdown = [...sectionMap.values()]
      .map((g) => ({
        grade: g.grade,
        section: g.section || null,
        avg_course_score:
          g.courseMax > 0
            ? Number(((g.courseTotal / g.courseMax) * 100).toFixed(2))
            : 0,
        avg_daily_score:
          g.dailyMax > 0
            ? Number(((g.dailyTotal / g.dailyMax) * 100).toFixed(2))
            : 0,
        avg_overall: overallScore(
          g.courseMax > 0 ? (g.courseTotal / g.courseMax) * 100 : null,
          g.dailyMax > 0 ? (g.dailyTotal / g.dailyMax) * 100 : null,
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

    const targetedCount = await this.audienceCounter(
      schoolId,
      allAssignments,
      enrollments,
    );

    // Assignment table
    const assignment_table = allAssignments
      .filter((a) => a.isPublished)
      .map((a) => {
        const subs = bestSubmissions.filter((s) => s.assignmentId === a.id);
        const submittedCount = new Set(
          allSubmissions
            .filter((s) => s.assignmentId === a.id)
            .map((s) => s.studentId),
        ).size;
        const scores = subs.map((s) => Number(s.score ?? 0));
        // Percent per student, so assignments with different totals average correctly.
        const percents = subs
          .map((s) => {
            const max = Number(s.maxScore ?? a.totalMarks ?? 0);
            return max > 0 ? (Number(s.score ?? 0) / max) * 100 : null;
          })
          .filter((p): p is number => p != null);
        const avg = percents.length
          ? Number(
              (percents.reduce((x, y) => x + y, 0) / percents.length).toFixed(
                2,
              ),
            )
          : 0;
        const high = scores.length ? Math.max(...scores) : 0;
        const low = scores.length ? Math.min(...scores) : 0;
        const targetedStudents = targetedCount(a);
        return {
          assignment_id: a.id,
          title: a.title,
          assignment_type: (a as any).assignmentType ?? 'COURSE',
          subject: a.subject,
          total_marks: a.totalMarks,
          total_submissions: submittedCount,
          graded_count: subs.length,
          avg_score: avg,
          avg_marks: scores.length
            ? Number(
                (scores.reduce((x, y) => x + y, 0) / scores.length).toFixed(2),
              )
            : null,
          highest_score: high,
          lowest_score: low,
          targeted_students: targetedStudents,
          // Capped: a student who submitted and later moved class still counts as submitted.
          completion_rate:
            targetedStudents > 0
              ? Math.min(
                  100,
                  Number(
                    ((submittedCount / targetedStudents) * 100).toFixed(2),
                  ),
                )
              : 0,
        };
      });

    // Only students with graded work — the rest aren't scoring 0%, they have no score.
    const scored = ranked.filter((r) => r.graded_assignments_count > 0);
    const overallAvg = scored.length
      ? Number(
          (
            scored.reduce((s, r) => s + r.overall_score, 0) / scored.length
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
      section_breakdown,
      subject_breakdown,
      assignment_table,
    };
  }
}
