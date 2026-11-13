import { TeacherCalendarController } from './calendar.controller';

describe('teacher calendar — split-day slots', () => {
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  const slot = (kind: string, start: string, end: string) => ({
    '4': { slot: kind, start, end },
  });

  it('reports each school with its half-day window for a shared weekday', async () => {
    const c = Object.create(TeacherCalendarController.prototype);
    c.db = {
      teacherWorkingDaysHistory: {
        findMany: jest.fn().mockResolvedValue([
          {
            schoolId: 'A',
            workingDays: [4, 5],
            effectiveFrom: d('2026-01-01'),
            workingDaySlots: slot('MORNING', '08:00', '12:30'),
          },
          {
            schoolId: 'B',
            workingDays: [4],
            effectiveFrom: d('2026-01-01'),
            workingDaySlots: slot('AFTERNOON', '12:30', '17:00'),
          },
        ]),
      },
    };
    const { schedule } = await c.resolveMonthlySchedule(
      1,
      2026,
      11,
      new Map([
        ['A', 'School A'],
        ['B', 'School B'],
      ]),
    );
    // 2026-11-12 is a Thursday.
    const thu = schedule.filter((s: any) => s.date === '2026-11-12');
    expect(thu.map((s: any) => [s.school_id, s.slot?.slot])).toEqual([
      ['A', 'MORNING'],
      ['B', 'AFTERNOON'],
    ]);
    // Friday: only A, a full day (no slot).
    const fri = schedule.filter((s: any) => s.date === '2026-11-13');
    expect(fri).toHaveLength(1);
    expect(fri[0].slot).toBeUndefined();
  });
});
