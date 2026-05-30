import {
  calculateWeightedPercentage,
  selectAttemptByScoringRule,
  type AttemptScore,
} from './score-selection.util';

describe('score-selection util', () => {
  const attempts: AttemptScore[] = [
    {
      attemptNumber: 1,
      score: 2,
      submittedAt: new Date('2026-05-01T00:00:00.000Z'),
    },
    {
      attemptNumber: 2,
      score: 6,
      submittedAt: new Date('2026-05-02T00:00:00.000Z'),
    },
    {
      attemptNumber: 3,
      score: 4,
      submittedAt: new Date('2026-05-03T00:00:00.000Z'),
    },
  ];

  it('selects latest attempt when rule is latest', () => {
    const selected = selectAttemptByScoringRule(attempts, 'latest');
    expect(selected?.attemptNumber).toBe(3);
    expect(selected?.score).toBe(4);
  });

  it('selects highest scoring attempt when rule is highest', () => {
    const selected = selectAttemptByScoringRule(attempts, 'highest');
    expect(selected?.attemptNumber).toBe(2);
    expect(selected?.score).toBe(6);
  });

  it('returns zero percentage when max score is zero', () => {
    expect(calculateWeightedPercentage(10, 0)).toBe(0);
  });

  it('calculates weighted percentage to two decimals', () => {
    expect(calculateWeightedPercentage(45, 60)).toBe(75);
  });
});
