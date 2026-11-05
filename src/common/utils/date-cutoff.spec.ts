import { isBeforeAttendanceCutoff } from './date.util';

describe('isBeforeAttendanceCutoff (8pm IST)', () => {
  // IST = UTC+5:30 → 8pm IST = 14:30 UTC
  it.each([
    ['2026-07-27T14:29:59.000Z', true], // 19:59:59 IST
    ['2026-07-27T14:30:00.000Z', false], // 20:00:00 IST
    ['2026-07-27T18:30:00.000Z', true], // 00:00 IST next day
    ['2026-07-27T03:00:00.000Z', true], // 08:30 IST
  ])('%s -> %s', (iso, expected) => {
    expect(isBeforeAttendanceCutoff(new Date(iso))).toBe(expected);
  });
});
