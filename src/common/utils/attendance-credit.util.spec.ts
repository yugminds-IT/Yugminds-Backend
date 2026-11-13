import {
  combineWeights,
  presentCreditByDate,
  weightedMetrics,
} from './attendance-credit.util';

const D = '2026-07-06';
const date = new Date(`${D}T00:00:00Z`);
const base = {
  explicitAbsent: new Set<string>(),
  leaveDates: new Set<string>(),
  reportedDates: new Set<string>(),
  todayStr: '2026-12-01',
};

describe('split-day attendance credit', () => {
  const wBy = new Map([
    ['A', new Map([[D, 0.5]])],
    ['B', new Map([[D, 0.5]])],
  ]);
  const weights = combineWeights(wBy.values());

  it('two half slots make one working day', () => {
    expect(weights.get(D)).toBe(1);
  });

  it('both reports submitted = full day present', () => {
    const presentCredit = presentCreditByDate(
      [
        { schoolId: 'A', date, status: 'Present' },
        { schoolId: 'B', date, status: 'Present' },
      ],
      wBy,
    );
    const m = weightedMetrics({ ...base, weights, presentCredit });
    expect(m.present_days).toBe(1);
    expect(m.attendance_percentage).toBe(100);
  });

  it('only one report = half present, other half absent', () => {
    const presentCredit = presentCreditByDate(
      [{ schoolId: 'A', date, status: 'Present' }],
      wBy,
    );
    const m = weightedMetrics({ ...base, weights, presentCredit });
    expect(m).toMatchObject({
      present_days: 0.5,
      absent_days: 0.5,
      attendance_percentage: 50,
    });
  });

  it('legacy overlapping FULL days still count once', () => {
    const w = combineWeights([new Map([[D, 1]]), new Map([[D, 1]])]);
    expect(w.get(D)).toBe(1);
  });
});
