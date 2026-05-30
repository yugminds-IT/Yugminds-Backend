export type AttemptScore = {
  attemptNumber: number;
  score: number | null;
  submittedAt: Date;
};

export function selectAttemptByScoringRule(
  attempts: AttemptScore[],
  scoringRule: 'highest' | 'latest',
): AttemptScore | null {
  if (!attempts.length) return null;
  if (scoringRule === 'highest') {
    return (
      [...attempts].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0] ?? null
    );
  }
  return (
    [...attempts].sort((a, b) => a.attemptNumber - b.attemptNumber)[
      attempts.length - 1
    ] ?? null
  );
}

export function calculateWeightedPercentage(
  totalScore: number,
  totalMaxScore: number,
): number {
  if (totalMaxScore <= 0) return 0;
  return Number(((totalScore / totalMaxScore) * 100).toFixed(2));
}
