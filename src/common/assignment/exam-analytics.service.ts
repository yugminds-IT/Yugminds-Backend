import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { StudentRankingService } from './student-ranking.service';
import { examPhase } from './assignment-types';

const PASS_PERCENT = 40;
const pct = (total: number, max: number) =>
  max > 0 ? Number(((total / max) * 100).toFixed(2)) : 0;

/**
 * Exam analytics, computed live from graded EXAM submissions. Exams are kept
 * out of the course/daily/overall ranking, so this is their own score + rank.
 * Shared by the teacher, school-admin and admin dashboards.
 */
@Injectable()
export class ExamAnalyticsService {
  constructor(private readonly db: DatabaseService) {}

  async compute(schoolIds: string[]) {
    const empty = {
      summary: {
        exams_count: 0,
        live: 0,
        upcoming: 0,
        closed: 0,
        participants: 0,
        avg_score: 0,
        pass_rate: 0,
      },
      exams: [] as unknown[],
      by_subject: [] as unknown[],
      by_exam_type: [] as unknown[],
      students: [] as unknown[],
    };
    if (!schoolIds.length) return empty;

    const exams = await this.db.assignment.findMany({
      where: {
        assignmentType: 'EXAM',
        isPublished: true,
        schoolId: { in: schoolIds },
      },
      orderBy: { startsAt: 'desc' },
      select: {
        id: true,
        title: true,
        subject: true,
        examType: true,
        schoolId: true,
        startsAt: true,
        endsAt: true,
        totalMarks: true,
        retakeScoringRule: true,
      },
    });
    if (!exams.length) return empty;

    const examById = new Map(exams.map((e) => [e.id, e]));
    const submissions = await this.db.assignmentSubmission.findMany({
      where: { assignmentId: { in: exams.map((e) => e.id) } },
      orderBy: [{ studentId: 'asc' }, { attemptNumber: 'asc' }],
      select: {
        assignmentId: true,
        studentId: true,
        attemptNumber: true,
        status: true,
        score: true,
        maxScore: true,
      },
    });

    // Official attempt per (student, exam): graded only, honouring the retake rule.
    const best = StudentRankingService.pickBestGraded(
      submissions,
      (s) => `${s.studentId}:${s.assignmentId}`,
      (id) => examById.get(id)?.retakeScoringRule ?? 'latest',
    );
    const scored = [...best.values()].map((s) => {
      const max = Number(s.maxScore ?? examById.get(s.assignmentId)?.totalMarks ?? 0);
      return {
        studentId: s.studentId,
        assignmentId: s.assignmentId,
        score: Math.min(Math.max(Number(s.score ?? 0), 0), max),
        max,
      };
    });

    const now = new Date();
    const examRows = exams.map((e) => {
      const rows = scored.filter((s) => s.assignmentId === e.id);
      const pcts = rows.map((r) => pct(r.score, r.max));
      const subs = submissions.filter((s) => s.assignmentId === e.id);
      return {
        assignment_id: e.id,
        title: e.title,
        subject: e.subject,
        exam_type: e.examType,
        school_id: e.schoolId,
        phase: examPhase(e, now),
        starts_at: e.startsAt?.toISOString() ?? null,
        ends_at: e.endsAt?.toISOString() ?? null,
        participants: new Set(subs.map((s) => s.studentId)).size,
        graded_count: rows.length,
        retake_count: subs.filter((s) => s.attemptNumber > 1).length,
        avg_score_percentage: pcts.length
          ? Number((pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(2))
          : 0,
        highest_score_percentage: pcts.length ? Math.max(...pcts) : 0,
        lowest_score_percentage: pcts.length ? Math.min(...pcts) : 0,
        pass_rate: pcts.length
          ? Number(((pcts.filter((p) => p >= PASS_PERCENT).length / pcts.length) * 100).toFixed(1))
          : 0,
      };
    });

    const group = (keyOf: (e: (typeof exams)[number]) => string) => {
      const m = new Map<string, { total: number; max: number; n: number }>();
      for (const r of scored) {
        const e = examById.get(r.assignmentId)!;
        const k = keyOf(e);
        const cur = m.get(k) ?? { total: 0, max: 0, n: 0 };
        cur.total += r.score;
        cur.max += r.max;
        cur.n += 1;
        m.set(k, cur);
      }
      return [...m.entries()]
        .map(([key, v]) => ({ key, avg_score: pct(v.total, v.max), submissions: v.n }))
        .sort((a, b) => b.avg_score - a.avg_score);
    };

    // Student exam score + rank (own ranking, not mixed with course/daily).
    const byStudent = new Map<number, { total: number; max: number; n: number }>();
    for (const r of scored) {
      const cur = byStudent.get(r.studentId) ?? { total: 0, max: 0, n: 0 };
      cur.total += r.score;
      cur.max += r.max;
      cur.n += 1;
      byStudent.set(r.studentId, cur);
    }
    const studentIds = [...byStudent.keys()];
    const profiles = studentIds.length
      ? await this.db.studentSchool.findMany({
          where: { studentId: { in: studentIds }, schoolId: { in: schoolIds }, isActive: true },
          select: {
            studentId: true,
            schoolId: true,
            grade: true,
            section: true,
            student: { select: { email: true, profile: { select: { fullName: true } } } },
          },
        })
      : [];
    const profileById = new Map(profiles.map((p) => [p.studentId, p]));
    const students = studentIds
      .map((id) => {
        const v = byStudent.get(id)!;
        const p = profileById.get(id);
        return {
          student_id: id,
          name: p?.student.profile?.fullName ?? p?.student.email ?? `Student ${id}`,
          school_id: p?.schoolId ?? null,
          grade: p?.grade ?? null,
          section: p?.section ?? null,
          exams_taken: v.n,
          score: pct(v.total, v.max),
        };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .map((s, i, arr) => ({
        ...s,
        // competition ranking: ties share a rank
        rank: i > 0 && arr[i - 1].score === s.score ? 0 : i + 1,
      }));
    for (let i = 0; i < students.length; i++)
      if (students[i].rank === 0) students[i].rank = students[i - 1].rank;

    const allPct = scored.map((r) => pct(r.score, r.max));
    return {
      summary: {
        exams_count: exams.length,
        live: examRows.filter((e) => e.phase === 'open').length,
        upcoming: examRows.filter((e) => e.phase === 'upcoming').length,
        closed: examRows.filter((e) => e.phase === 'closed').length,
        participants: new Set(submissions.map((s) => s.studentId)).size,
        avg_score: allPct.length
          ? Number((allPct.reduce((a, b) => a + b, 0) / allPct.length).toFixed(2))
          : 0,
        pass_rate: allPct.length
          ? Number(((allPct.filter((p) => p >= PASS_PERCENT).length / allPct.length) * 100).toFixed(1))
          : 0,
      },
      exams: examRows,
      by_subject: group((e) => e.subject ?? 'General').map((g) => ({ subject: g.key, avg_score: g.avg_score, submissions: g.submissions })),
      by_exam_type: group((e) => e.examType ?? 'OTHER').map((g) => ({ exam_type: g.key, avg_score: g.avg_score, submissions: g.submissions })),
      students,
    };
  }

  /** Per-student exam history + rank (student's own analytics page). */
  async forStudent(studentId: number) {
    const ss = await this.db.studentSchool.findFirst({
      where: { studentId, isActive: true },
      select: { schoolId: true },
    });
    if (!ss) return null;
    const data = await this.compute([ss.schoolId]);
    const students = data.students as Array<{ student_id: number; rank: number; score: number; exams_taken: number }>;
    const me = students.find((s) => s.student_id === studentId) ?? null;
    return {
      score: me?.score ?? null,
      rank: me?.rank ?? null,
      ranked_students: students.length,
      exams_taken: me?.exams_taken ?? 0,
    };
  }
}
