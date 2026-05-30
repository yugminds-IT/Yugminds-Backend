import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function normalizeScoringRule(rule: unknown): 'highest' | 'latest' {
  return String(rule ?? '').toLowerCase() === 'highest' ? 'highest' : 'latest';
}

async function main() {
  const assignments = await prisma.assignment.findMany({
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
  const assignmentIds = assignments.map((a) => a.id);
  if (!assignmentIds.length) {
    console.log('No assignments found.');
    return;
  }

  const submissions = await prisma.assignmentSubmission.findMany({
    where: { assignmentId: { in: assignmentIds } },
    orderBy: [{ studentId: 'asc' }, { assignmentId: 'asc' }, { attemptNumber: 'asc' }],
    select: {
      studentId: true,
      assignmentId: true,
      score: true,
      maxScore: true,
      attemptNumber: true,
    },
  });

  const byStudent = new Map<number, typeof submissions>();
  for (const row of submissions) {
    const arr = byStudent.get(row.studentId) ?? [];
    arr.push(row);
    byStudent.set(row.studentId, arr);
  }

  let upserted = 0;
  for (const [studentId, rows] of byStudent.entries()) {
    const groupedByAssignment = new Map<string, typeof rows>();
    for (const row of rows) {
      const arr = groupedByAssignment.get(row.assignmentId) ?? [];
      arr.push(row);
      groupedByAssignment.set(row.assignmentId, arr);
    }

    const bucket = new Map<
      string,
      {
        schoolId: string | null;
        gradeId: string | null;
        courseId: string | null;
        subject: string;
        cumulativeScore: number;
        cumulativeMaxScore: number;
        scoringRule: 'highest' | 'latest';
      }
    >();

    for (const assignment of assignments) {
      const attempts = groupedByAssignment.get(assignment.id) ?? [];
      if (!attempts.length) continue;
      const scoringRule = normalizeScoringRule(assignment.retakeScoringRule);
      const chosen =
        scoringRule === 'highest'
          ? [...attempts].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0]
          : attempts[attempts.length - 1];

      const key = `${assignment.courseId ?? 'none'}::${assignment.subject ?? 'General'}`;
      const agg =
        bucket.get(key) ??
        {
          schoolId: assignment.schoolId ?? null,
          gradeId: assignment.gradeId ?? null,
          courseId: assignment.courseId ?? null,
          subject: String(assignment.subject ?? 'General'),
          cumulativeScore: 0,
          cumulativeMaxScore: 0,
          scoringRule,
        };
      agg.cumulativeScore += Number(chosen?.score ?? 0);
      agg.cumulativeMaxScore += Number(chosen?.maxScore ?? assignment.totalMarks ?? 0);
      agg.scoringRule = scoringRule;
      bucket.set(key, agg);
    }

    for (const row of bucket.values()) {
      if (!row.courseId) continue;
      const percentage =
        row.cumulativeMaxScore > 0
          ? Number(((row.cumulativeScore / row.cumulativeMaxScore) * 100).toFixed(2))
          : 0;
      const gpaLikeScore = Number(((percentage / 100) * 4).toFixed(2));
      await prisma.studentScore.upsert({
        where: {
          studentId_courseId_subject: {
            studentId,
            courseId: row.courseId,
            subject: row.subject,
          },
        },
        create: {
          studentId,
          schoolId: row.schoolId,
          gradeId: row.gradeId,
          courseId: row.courseId,
          subject: row.subject,
          cumulativeScore: row.cumulativeScore,
          cumulativeMaxScore: row.cumulativeMaxScore,
          percentage,
          gpaLikeScore,
          scoringRule: row.scoringRule,
        },
        update: {
          schoolId: row.schoolId,
          gradeId: row.gradeId,
          cumulativeScore: row.cumulativeScore,
          cumulativeMaxScore: row.cumulativeMaxScore,
          percentage,
          gpaLikeScore,
          scoringRule: row.scoringRule,
        },
      });
      upserted += 1;
    }
  }

  console.log(`Backfill complete. Upserted ${upserted} student score rows.`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
