import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

/**
 * Canonical, system-wide student ranking.
 *
 * This is the SINGLE source of truth for how a student's course / daily /
 * overall scores and their section / grade / school / system ranks are
 * computed. Every dashboard (student, teacher, school-admin, admin) must go
 * through this service so the numbers always agree.
 *
 * Rules (applied consistently everywhere):
 *  - Only `graded` submissions count.
 *  - Per (student, assignment) we keep the best/latest attempt according to the
 *    assignment's `retakeScoringRule` ("highest" vs "latest").
 *  - A student's score is GLOBAL — derived from ALL their graded submissions,
 *    not scoped to any one school. Ranks differ only by comparison group.
 *  - overall = course% * 0.6 + daily% * 0.4
 *  - Every active enrollment is included (a student with no graded work ranks
 *    last rather than disappearing).
 */

export type GlobalRankRow = {
  studentId: number;
  schoolId: string;
  schoolName: string;
  grade: string;
  section: string;
  studentName: string;
  courseScore: number;
  dailyScore: number;
  overallScore: number;
  gradedCount: number;
  badge: string;
};

export type RankScope = {
  rank: number | null;
  total: number;
  percentile: number | null;
};

/** Canonical leaderboard row (snake_case for direct API exposure). */
export type LeaderboardRow = {
  student_id: number;
  student_name: string;
  school_id: string;
  grade: string;
  section: string;
  course_score: number;
  daily_score: number;
  overall_score: number;
  badge: string;
  graded_count: number;
  rank: number;
  school_rank: number;
  grade_rank: number;
  section_rank: number;
};

@Injectable()
export class StudentRankingService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private readonly CACHE_KEY = 'ranking:global';
  private readonly TTL_SECONDS = 10 * 60;

  static computeBadge(score: number): string {
    if (score >= 90) return 'GOLD';
    if (score >= 75) return 'SILVER';
    if (score >= 60) return 'BRONZE';
    return 'NONE';
  }

  /** Drop the cache so the next read recomputes (call after grading). */
  async invalidate(): Promise<void> {
    await this.redis.del(this.CACHE_KEY);
  }

  /**
   * One row per active enrollment with the student's canonical scores.
   * Scans every graded submission in the system; cached in Redis for 10
   * minutes and shared across all dashboards AND all backend instances.
   */
  async getGlobalRanking(): Promise<{
    rows: GlobalRankRow[];
    schoolCount: number;
  }> {
    const cached = await this.redis.get(this.CACHE_KEY);
    if (cached) {
      return JSON.parse(cached) as {
        rows: GlobalRankRow[];
        schoolCount: number;
      };
    }

    const enrollments = await this.db.studentSchool.findMany({
      where: { isActive: true },
      include: {
        student: { include: { profile: true } },
        school: { select: { id: true, name: true } },
      },
    });
    const studentIds = [...new Set(enrollments.map((e) => e.studentId))];

    const allSubs = studentIds.length
      ? await this.db.assignmentSubmission.findMany({
          where: { studentId: { in: studentIds }, status: 'graded' },
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
        })
      : [];

    const subAsgnIds = [...new Set(allSubs.map((s) => s.assignmentId))];
    const asgns = subAsgnIds.length
      ? await this.db.assignment.findMany({
          where: { id: { in: subAsgnIds } },
          select: { id: true, assignmentType: true, retakeScoringRule: true },
        })
      : [];
    const asgnTypeMap = new Map(asgns.map((a) => [a.id, a]));

    // Best graded submission per (student, assignment), honoring retake rule.
    const bestByKey = new Map<string, (typeof allSubs)[0]>();
    for (const s of allSubs) {
      const key = `${s.studentId}:${s.assignmentId}`;
      const rule = String(
        asgnTypeMap.get(s.assignmentId)?.retakeScoringRule ?? 'latest',
      ).toLowerCase();
      const existing = bestByKey.get(key);
      if (!existing) {
        bestByKey.set(key, s);
      } else if (
        rule === 'highest' &&
        Number(s.score ?? 0) > Number(existing.score ?? 0)
      ) {
        bestByKey.set(key, s);
      } else if (rule !== 'highest') {
        bestByKey.set(key, s); // latest: ascending order → last wins
      }
    }

    // Aggregate per-student course/daily totals + graded count.
    const agg = new Map<
      number,
      {
        cTotal: number;
        cMax: number;
        dTotal: number;
        dMax: number;
        graded: number;
      }
    >();
    for (const s of bestByKey.values()) {
      const asgn = asgnTypeMap.get(s.assignmentId);
      const cur = agg.get(s.studentId) ?? {
        cTotal: 0,
        cMax: 0,
        dTotal: 0,
        dMax: 0,
        graded: 0,
      };
      const score = Number(s.score ?? 0);
      const max = Number(s.maxScore ?? 0);
      if (asgn?.assignmentType === 'COURSE') {
        cur.cTotal += score;
        cur.cMax += max;
      } else {
        cur.dTotal += score;
        cur.dMax += max;
      }
      cur.graded += 1;
      agg.set(s.studentId, cur);
    }

    const rows: GlobalRankRow[] = enrollments.map((e) => {
      const sc = agg.get(e.studentId) ?? {
        cTotal: 0,
        cMax: 0,
        dTotal: 0,
        dMax: 0,
        graded: 0,
      };
      const cp = sc.cMax > 0 ? (sc.cTotal / sc.cMax) * 100 : 0;
      const dp = sc.dMax > 0 ? (sc.dTotal / sc.dMax) * 100 : 0;
      const overall = Number((cp * 0.6 + dp * 0.4).toFixed(2));
      return {
        studentId: e.studentId,
        schoolId: e.schoolId,
        schoolName: e.school?.name ?? 'School',
        grade: e.grade ?? '',
        section: e.section ?? '',
        studentName:
          e.student.profile?.fullName ??
          e.student.email ??
          `Student ${e.studentId}`,
        courseScore: Number(cp.toFixed(2)),
        dailyScore: Number(dp.toFixed(2)),
        overallScore: overall,
        gradedCount: sc.graded,
        badge: StudentRankingService.computeBadge(overall),
      };
    });

    const schoolCount = new Set(enrollments.map((e) => e.schoolId)).size;
    const result = { rows, schoolCount };
    await this.redis.set(
      this.CACHE_KEY,
      JSON.stringify(result),
      'EX',
      this.TTL_SECONDS,
    );
    return result;
  }

  /** Position of `studentId` within an arbitrary cohort, by overall score. */
  rankWithin(
    list: { studentId: number; overallScore: number }[],
    studentId: number,
  ): RankScope {
    const sorted = [...list].sort((a, b) => b.overallScore - a.overallScore);
    const idx = sorted.findIndex((r) => r.studentId === studentId);
    const total = sorted.length;
    if (idx < 0) return { rank: null, total, percentile: null };
    return {
      rank: idx + 1,
      total,
      percentile:
        total > 0 ? Math.max(1, Math.ceil(((idx + 1) / total) * 100)) : null,
    };
  }

  /**
   * Turn a set of global rows into a sorted leaderboard with school / grade /
   * section ranks computed *within the provided rows*. Pass a school subset for
   * a school leaderboard, a multi-school subset for a teacher view, etc.
   * Grade/section ranks are keyed by school so identically-named grades in
   * different schools never merge.
   */
  buildLeaderboard(rows: GlobalRankRow[]): LeaderboardRow[] {
    // Single sort — all rank maps are derived from this order.
    const sorted = [...rows].sort((a, b) => b.overallScore - a.overallScore);

    const schoolRankMap = new Map<number, number>();
    const gradeRankMap = new Map<number, number>();
    const sectionRankMap = new Map<number, number>();
    // Grade/section rank counters are keyed per-group and increment as we walk
    // the already-sorted array, giving correct ranks in one pass.
    const gradeCounter = new Map<string, number>();
    const sectionCounter = new Map<string, number>();

    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      schoolRankMap.set(r.studentId, i + 1);

      const gKey = `${r.schoolId}::${r.grade}`;
      const gRank = (gradeCounter.get(gKey) ?? 0) + 1;
      gradeCounter.set(gKey, gRank);
      gradeRankMap.set(r.studentId, gRank);

      const sKey = `${r.schoolId}::${r.grade}::${r.section}`;
      const sRank = (sectionCounter.get(sKey) ?? 0) + 1;
      sectionCounter.set(sKey, sRank);
      sectionRankMap.set(r.studentId, sRank);
    }

    return sorted.map((r) => ({
      student_id: r.studentId,
      student_name: r.studentName,
      school_id: r.schoolId,
      grade: r.grade,
      section: r.section,
      course_score: r.courseScore,
      daily_score: r.dailyScore,
      overall_score: r.overallScore,
      badge: r.badge,
      graded_count: r.gradedCount,
      rank: schoolRankMap.get(r.studentId) ?? 0,
      school_rank: schoolRankMap.get(r.studentId) ?? 0,
      grade_rank: gradeRankMap.get(r.studentId) ?? 0,
      section_rank: sectionRankMap.get(r.studentId) ?? 0,
    }));
  }

  /**
   * Platform-wide leaderboard, one entry per student (multi-school enrollments
   * deduped), sorted by overall score with a 1-based `system_rank`.
   */
  async getSystemLeaderboard(
    limit?: number,
  ): Promise<(GlobalRankRow & { system_rank: number })[]> {
    const { rows } = await this.getGlobalRanking();
    const uniq = new Map<number, GlobalRankRow>();
    for (const r of rows) if (!uniq.has(r.studentId)) uniq.set(r.studentId, r);
    const sorted = [...uniq.values()]
      .sort((a, b) => b.overallScore - a.overallScore)
      .map((r, i) => ({ ...r, system_rank: i + 1 }));
    return limit ? sorted.slice(0, limit) : sorted;
  }
}
