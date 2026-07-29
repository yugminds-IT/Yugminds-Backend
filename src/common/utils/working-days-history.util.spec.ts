import { resolveWorkingDaysForDate, WorkingDaysHistoryEntry } from './working-days-history.util';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('resolveWorkingDaysForDate', () => {
  it('returns [] when there is no history at all', () => {
    expect(resolveWorkingDaysForDate([], d('2026-07-15'))).toEqual([]);
  });

  it('returns [] for a date before the earliest entry — the assignment did not exist yet', () => {
    const history: WorkingDaysHistoryEntry[] = [
      { effectiveFrom: d('2026-07-16'), workingDays: [1, 2, 3, 4, 5] },
    ];
    expect(resolveWorkingDaysForDate(history, d('2026-07-01'))).toEqual([]);
  });

  it('returns the single entry for any date on/after its effectiveFrom', () => {
    const history: WorkingDaysHistoryEntry[] = [
      { effectiveFrom: d('2026-07-01'), workingDays: [1, 2, 3, 4] },
    ];
    expect(resolveWorkingDaysForDate(history, d('2026-07-01'))).toEqual([1, 2, 3, 4]);
    expect(resolveWorkingDaysForDate(history, d('2026-07-31'))).toEqual([1, 2, 3, 4]);
  });

  // The core scenario this whole feature exists for: a mid-month change
  // (Mon-Thu -> Mon-Fri effective the 16th) must resolve to the OLD pattern
  // for days 1-15 and the NEW pattern for days 16 onward — never one flat
  // array retroactively covering the whole month either way.
  it('resolves a mid-month change on the correct side of the boundary', () => {
    const history: WorkingDaysHistoryEntry[] = [
      { effectiveFrom: d('2026-07-01'), workingDays: [1, 2, 3, 4] }, // Mon-Thu
      { effectiveFrom: d('2026-07-16'), workingDays: [1, 2, 3, 4, 5] }, // Mon-Fri
    ];
    expect(resolveWorkingDaysForDate(history, d('2026-07-15'))).toEqual([1, 2, 3, 4]);
    expect(resolveWorkingDaysForDate(history, d('2026-07-16'))).toEqual([1, 2, 3, 4, 5]);
    expect(resolveWorkingDaysForDate(history, d('2026-07-31'))).toEqual([1, 2, 3, 4, 5]);
  });

  it('resolves correctly across three or more changes', () => {
    const history: WorkingDaysHistoryEntry[] = [
      { effectiveFrom: d('2026-06-01'), workingDays: [1, 2, 3, 4, 5] },
      { effectiveFrom: d('2026-07-01'), workingDays: [1, 2, 3, 4] },
      { effectiveFrom: d('2026-07-16'), workingDays: [1, 2, 3, 4, 5, 6] },
    ];
    expect(resolveWorkingDaysForDate(history, d('2026-06-15'))).toEqual([1, 2, 3, 4, 5]);
    expect(resolveWorkingDaysForDate(history, d('2026-07-10'))).toEqual([1, 2, 3, 4]);
    expect(resolveWorkingDaysForDate(history, d('2026-07-20'))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('is order-independent — resolves correctly even if entries arrive unsorted', () => {
    const history: WorkingDaysHistoryEntry[] = [
      { effectiveFrom: d('2026-07-16'), workingDays: [1, 2, 3, 4, 5] },
      { effectiveFrom: d('2026-07-01'), workingDays: [1, 2, 3, 4] },
    ];
    expect(resolveWorkingDaysForDate(history, d('2026-07-10'))).toEqual([1, 2, 3, 4]);
    expect(resolveWorkingDaysForDate(history, d('2026-07-20'))).toEqual([1, 2, 3, 4, 5]);
  });

  it('a backdated correction changes the resolved pattern for dates in its range', () => {
    // Admin realizes 3 weeks later that the change actually started earlier
    // and adds a backdated entry — this must correctly override the interim
    // period between the backdated date and the next real change.
    const history: WorkingDaysHistoryEntry[] = [
      { effectiveFrom: d('2026-07-01'), workingDays: [1, 2, 3, 4, 5] },
      { effectiveFrom: d('2026-07-10'), workingDays: [1, 2, 3] }, // backdated correction, added later
      { effectiveFrom: d('2026-07-20'), workingDays: [1, 2, 3, 4, 5] },
    ];
    expect(resolveWorkingDaysForDate(history, d('2026-07-05'))).toEqual([1, 2, 3, 4, 5]);
    expect(resolveWorkingDaysForDate(history, d('2026-07-15'))).toEqual([1, 2, 3]);
    expect(resolveWorkingDaysForDate(history, d('2026-07-25'))).toEqual([1, 2, 3, 4, 5]);
  });
});
