import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class RankingService {
  constructor(private readonly db: DatabaseService) {}

  private computeBadge(overallScore: number): string {
    if (overallScore >= 90) return 'GOLD';
    if (overallScore >= 75) return 'SILVER';
    if (overallScore >= 60) return 'BRONZE';
    return 'NONE';
  }

  private scoreToGpaLike(percentage: number): number {
    return Math.max(
      0,
      Math.min(4, Number(((percentage / 100) * 4).toFixed(2))),
    );
  }

  /**
   * Canonical per-(student, course, subject) score aggregation stored in StudentScore.
   * Applies retakeScoringRule per assignment; does NOT filter by status.
   */
  async recomputeStudentScores(
    studentId: number,
    courseId?: string | null,
  ): Promise<void> {
    const assignments = await this.db.assignment.findMany({
      where: courseId ? { courseId } : undefined,
      select: {
        id: true,
        courseId: true,
        gradeId: true,
        schoolId: true,
        subject: true,
        totalMarks: true,
        retakeScoringRule: true,
      },
    });
    if (!assignments.length) return;

    const submissions = await this.db.assignmentSubmission.findMany({
      where: { studentId, assignmentId: { in: assignments.map((a) => a.id) } },
      orderBy: [
        { assignmentId: 'asc' },
        { attemptNumber: 'asc' },
        { submittedAt: 'asc' },
      ],
      select: {
        assignmentId: true,
        attemptNumber: true,
        score: true,
        maxScore: true,
        submittedAt: true,
      },
    });

    const subsByAssignment = new Map<string, typeof submissions>();
    for (const s of submissions) {
      const arr = subsByAssignment.get(s.assignmentId) ?? [];
      arr.push(s);
      subsByAssignment.set(s.assignmentId, arr);
    }

    type Bucket = {
      schoolId: string | null;
      gradeId: string | null;
      courseId: string | null;
      subject: string;
      cumulativeScore: number;
      cumulativeMaxScore: number;
      scoringRule: 'highest' | 'latest';
    };
    const buckets = new Map<string, Bucket>();
    const makeKey = (cid: string | null, subject: string) =>
      `${cid ?? 'none'}::${subject}`;

    for (const a of assignments) {
      const scoringRule: 'highest' | 'latest' =
        String(a.retakeScoringRule ?? '').toLowerCase() === 'highest'
          ? 'highest'
          : 'latest';
      const attempts = subsByAssignment.get(a.id) ?? [];
      if (!attempts.length) continue;

      const chosen =
        scoringRule === 'highest'
          ? [...attempts].sort((x, y) => (y.score ?? -1) - (x.score ?? -1))[0]
          : attempts[attempts.length - 1];

      const subject = String(a.subject ?? 'General').trim() || 'General';
      const key = makeKey(a.courseId ?? null, subject);
      const bucket = buckets.get(key) ?? {
        schoolId: a.schoolId ?? null,
        gradeId: a.gradeId ?? null,
        courseId: a.courseId ?? null,
        subject,
        cumulativeScore: 0,
        cumulativeMaxScore: 0,
        scoringRule,
      };
      bucket.cumulativeScore += Number(chosen.score ?? 0);
      bucket.cumulativeMaxScore += Number(chosen.maxScore ?? a.totalMarks ?? 0);
      bucket.scoringRule = scoringRule;
      buckets.set(key, bucket);
    }

    for (const b of buckets.values()) {
      if (!b.courseId) continue;
      const percentage =
        b.cumulativeMaxScore > 0
          ? Number(
              ((b.cumulativeScore / b.cumulativeMaxScore) * 100).toFixed(2),
            )
          : 0;
      await this.db.studentScore.upsert({
        where: {
          studentId_courseId_subject: {
            studentId,
            courseId: b.courseId,
            subject: b.subject,
          },
        },
        create: {
          studentId,
          schoolId: b.schoolId,
          gradeId: b.gradeId,
          courseId: b.courseId,
          subject: b.subject,
          cumulativeScore: b.cumulativeScore,
          cumulativeMaxScore: b.cumulativeMaxScore,
          percentage,
          gpaLikeScore: this.scoreToGpaLike(percentage),
          scoringRule: b.scoringRule,
        },
        update: {
          schoolId: b.schoolId,
          gradeId: b.gradeId,
          cumulativeScore: b.cumulativeScore,
          cumulativeMaxScore: b.cumulativeMaxScore,
          percentage,
          gpaLikeScore: this.scoreToGpaLike(percentage),
          scoringRule: b.scoringRule,
        },
      });
    }
  }

  /**
   * Canonical school-wide rank computation stored in StudentScoreSummary.
   * Uses graded-only submissions and respects retakeScoringRule.
   * Formula: overall = courseScore * 0.6 + dailyScore * 0.4
   */
  async recomputeStudentScoreSummary(schoolId: string): Promise<void> {
    const schoolStudents = await this.db.studentSchool.findMany({
      where: { schoolId, isActive: true },
      select: { studentId: true },
    });
    const studentIds = schoolStudents.map((s) => s.studentId);
    if (!studentIds.length) return;

    const [schoolAssignments, courseAccess] = await Promise.all([
      this.db.assignment.findMany({
        where: { schoolId },
        select: {
          id: true,
          assignmentType: true,
          totalMarks: true,
          retakeScoringRule: true,
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
    const courseAssignments = accessibleCourseIds.length
      ? await this.db.assignment.findMany({
          where: {
            OR: [
              { courseId: { in: accessibleCourseIds } },
              { chapter: { courseId: { in: accessibleCourseIds } } },
            ],
            assignmentType: 'COURSE',
          },
          select: {
            id: true,
            assignmentType: true,
            totalMarks: true,
            retakeScoringRule: true,
          },
        })
      : [];

    const allAssignments = [
      ...schoolAssignments,
      ...courseAssignments.filter(
        (ca) => !schoolAssignments.some((sa) => sa.id === ca.id),
      ),
    ];
    const courseIds = allAssignments
      .filter((a) => (a as any).assignmentType === 'COURSE')
      .map((a) => a.id);
    const dailyIds = allAssignments
      .filter((a) => (a as any).assignmentType !== 'COURSE')
      .map((a) => a.id);

    // Only graded submissions for stored summary
    const allSubmissions = await this.db.assignmentSubmission.findMany({
      where: {
        studentId: { in: studentIds },
        assignmentId: { in: allAssignments.map((a) => a.id) },
        status: 'graded',
      },
      select: {
        studentId: true,
        assignmentId: true,
        score: true,
        maxScore: true,
        attemptNumber: true,
      },
      orderBy: [
        { studentId: 'asc' },
        { assignmentId: 'asc' },
        { attemptNumber: 'asc' },
      ],
    });

    const computeBuckets = (assignmentIds: string[]) => {
      const bestByKey = new Map<
        string,
        { studentId: number; score: number; maxScore: number }
      >();
      for (const s of allSubmissions) {
        if (!assignmentIds.includes(s.assignmentId)) continue;
        const asgn = allAssignments.find((a) => a.id === s.assignmentId);
        const rule = String(asgn?.retakeScoringRule ?? 'latest').toLowerCase();
        const key = `${s.studentId}:${s.assignmentId}`;
        const existing = bestByKey.get(key);
        if (!existing) {
          bestByKey.set(key, {
            studentId: s.studentId,
            score: Number(s.score ?? 0),
            maxScore: Number(s.maxScore ?? asgn?.totalMarks ?? 0),
          });
        } else if (
          rule === 'highest' &&
          Number(s.score ?? 0) > existing.score
        ) {
          bestByKey.set(key, {
            studentId: s.studentId,
            score: Number(s.score ?? 0),
            maxScore: Number(s.maxScore ?? asgn?.totalMarks ?? 0),
          });
        } else {
          // latest: ascending order means last write wins
          bestByKey.set(key, {
            studentId: s.studentId,
            score: Number(s.score ?? 0),
            maxScore: Number(s.maxScore ?? asgn?.totalMarks ?? 0),
          });
        }
      }
      const byStudent = new Map<number, { total: number; max: number }>();
      for (const val of bestByKey.values()) {
        const cur = byStudent.get(val.studentId) ?? { total: 0, max: 0 };
        cur.total += val.score;
        cur.max += val.maxScore;
        byStudent.set(val.studentId, cur);
      }
      return byStudent;
    };

    const courseByStudent = computeBuckets(courseIds);
    const dailyByStudent = computeBuckets(dailyIds);

    const scores = studentIds.map((sid) => {
      const c = courseByStudent.get(sid);
      const d = dailyByStudent.get(sid);
      const courseScore = c && c.max > 0 ? (c.total / c.max) * 100 : 0;
      const dailyScore = d && d.max > 0 ? (d.total / d.max) * 100 : 0;
      const overall = courseScore * 0.6 + dailyScore * 0.4;
      return {
        studentId: sid,
        courseScore: Number(courseScore.toFixed(2)),
        dailyScore: Number(dailyScore.toFixed(2)),
        overallScore: Number(overall.toFixed(2)),
        badge: this.computeBadge(Number(overall.toFixed(2))),
      };
    });

    const ranked = [...scores].sort((a, b) => b.overallScore - a.overallScore);
    const courseRanked = [...scores].sort(
      (a, b) => b.courseScore - a.courseScore,
    );
    const dailyRanked = [...scores].sort((a, b) => b.dailyScore - a.dailyScore);

    await Promise.all(
      scores.map((s) => {
        const overallRank =
          ranked.findIndex((r) => r.studentId === s.studentId) + 1;
        const courseRank =
          courseRanked.findIndex((r) => r.studentId === s.studentId) + 1;
        const dailyRank =
          dailyRanked.findIndex((r) => r.studentId === s.studentId) + 1;
        return this.db.$executeRaw`
          INSERT INTO "StudentScoreSummary" ("id", "studentId", "schoolId", "academicYear",
            "courseAssignmentScore", "dailyAssignmentScore", "overallScore",
            "courseAssignmentRank", "dailyAssignmentRank", "overallRank", "badge", "lastCalculatedAt")
          VALUES (gen_random_uuid(), ${s.studentId}, ${schoolId}, '2024-25',
            ${s.courseScore}, ${s.dailyScore}, ${s.overallScore},
            ${courseRank}, ${dailyRank}, ${overallRank}, ${s.badge}, now())
          ON CONFLICT ("studentId") DO UPDATE SET
            "schoolId" = EXCLUDED."schoolId",
            "courseAssignmentScore" = EXCLUDED."courseAssignmentScore",
            "dailyAssignmentScore" = EXCLUDED."dailyAssignmentScore",
            "overallScore" = EXCLUDED."overallScore",
            "courseAssignmentRank" = EXCLUDED."courseAssignmentRank",
            "dailyAssignmentRank" = EXCLUDED."dailyAssignmentRank",
            "overallRank" = EXCLUDED."overallRank",
            "badge" = EXCLUDED."badge",
            "lastCalculatedAt" = now()
        `;
      }),
    );
  }
}
