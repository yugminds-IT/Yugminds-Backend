import { BadRequestException } from '@nestjs/common';

export function sumQuestionMarks(
  questions: Array<{ marks?: unknown }>,
): number {
  return questions.reduce((sum, q) => {
    const n = Number(q.marks ?? 1);
    return sum + (Number.isFinite(n) && n > 0 ? n : 1);
  }, 0);
}

/** Rejects a question set whose marks exceed the assignment total. Under-filling is allowed. */
export function assertQuestionMarksFitTotal(
  totalMarks: number | null | undefined,
  questions: Array<{ marks?: unknown }>,
): void {
  if (totalMarks == null || questions.length === 0) return;
  const cap = Number(totalMarks);
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new BadRequestException(
      'Assignment total marks must be greater than 0.',
    );
  }
  const sum = sumQuestionMarks(questions);
  if (sum > cap + 1e-9) {
    throw new BadRequestException(
      `Question marks add up to ${sum}, which exceeds the assignment total of ${cap}. Reduce question marks or raise the total.`,
    );
  }
}
