import { normalizeWeekdays } from './weekdays.util';

describe('normalizeWeekdays', () => {
  it('dedupes and sorts', () => {
    expect(normalizeWeekdays([3, 1, 1, 5, 3], [1, 2, 3, 4, 5])).toEqual([1, 3, 5]);
  });

  it('filters out non-integer and out-of-range values', () => {
    expect(normalizeWeekdays([1, 'x', 7, -1, 2.5, 4], [1, 2, 3, 4, 5])).toEqual([1, 4]);
  });

  it('falls back when input is not an array', () => {
    expect(normalizeWeekdays(undefined, [1, 2, 3, 4, 5])).toEqual([1, 2, 3, 4, 5]);
    expect(normalizeWeekdays(null, [1, 2, 3, 4, 5])).toEqual([1, 2, 3, 4, 5]);
    expect(normalizeWeekdays('not-an-array', [1, 2, 3, 4, 5])).toEqual([1, 2, 3, 4, 5]);
  });

  it('falls back when input is an empty or all-invalid array', () => {
    expect(normalizeWeekdays([], [1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(normalizeWeekdays([7, -1, 'x'], [1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('accepts 0 (Sunday) and 6 (Saturday) as valid', () => {
    expect(normalizeWeekdays([0, 6], [1, 2, 3, 4, 5])).toEqual([0, 6]);
  });
});
