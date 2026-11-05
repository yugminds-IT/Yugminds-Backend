import { isSchoolAdminLeaveDeadlinePassed } from './date.util';

// IST = UTC+5:30 → 11pm IST = 17:30 UTC
const leave = (start: string, created: string) => ({
  startDate: new Date(`${start}T00:00:00.000Z`),
  createdAt: new Date(created),
});

describe('isSchoolAdminLeaveDeadlinePassed', () => {
  // Filed 27 Jul 2pm IST for leave starting 28 Jul → deadline 27 Jul 11pm IST
  const tomorrow = leave('2026-07-28', '2026-07-27T08:30:00.000Z');
  it('open before 11pm the day before the leave', () => {
    expect(
      isSchoolAdminLeaveDeadlinePassed(
        tomorrow,
        new Date('2026-07-27T17:29:59.000Z'),
      ),
    ).toBe(false);
  });
  it('closed from 11pm the day before the leave', () => {
    expect(
      isSchoolAdminLeaveDeadlinePassed(
        tomorrow,
        new Date('2026-07-27T17:30:00.000Z'),
      ),
    ).toBe(true);
  });
  it('a leave filed days ahead stays open until the evening before it starts', () => {
    const ahead = leave('2026-07-30', '2026-07-27T08:30:00.000Z');
    expect(
      isSchoolAdminLeaveDeadlinePassed(
        ahead,
        new Date('2026-07-28T10:00:00.000Z'),
      ),
    ).toBe(false);
    expect(
      isSchoolAdminLeaveDeadlinePassed(
        ahead,
        new Date('2026-07-29T17:30:00.000Z'),
      ),
    ).toBe(true);
  });
  it('a leave starting today (filed today) is open until 11pm today', () => {
    const today = leave('2026-07-27', '2026-07-27T04:00:00.000Z');
    expect(
      isSchoolAdminLeaveDeadlinePassed(
        today,
        new Date('2026-07-27T17:00:00.000Z'),
      ),
    ).toBe(false);
    expect(
      isSchoolAdminLeaveDeadlinePassed(
        today,
        new Date('2026-07-27T17:30:00.000Z'),
      ),
    ).toBe(true);
  });
});
