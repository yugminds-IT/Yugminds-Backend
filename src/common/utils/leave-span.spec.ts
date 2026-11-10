import { assertLeaveSpan, MAX_LEAVE_DAYS } from './leave-rules.util';

describe('assertLeaveSpan', () => {
  it('allows a one-day and a maximum-length leave', () => {
    expect(() => assertLeaveSpan('2026-07-01', '2026-07-01')).not.toThrow();
    expect(() => assertLeaveSpan('2026-01-01', '2026-12-31')).not.toThrow(); // 365 days
  });

  it('rejects a leave longer than MAX_LEAVE_DAYS', () => {
    expect(MAX_LEAVE_DAYS).toBe(366);
    expect(() => assertLeaveSpan('2026-01-01', '2027-01-02')).toThrow(/more than 366 days/);
    expect(() => assertLeaveSpan('2026-01-01', '2999-01-01')).toThrow();
  });
});
