import { BadRequestException } from '@nestjs/common';
import { SchoolAdminExtraController } from './school-admin-extra.controller';

// A MORNING-only teacher (08:00–12:30 on Thursday=4) shared with another school.
describe('assertTeacherSchedulable — half-day windows', () => {
  const make = (workingDaySlots: unknown, period: { s: string; e: string }) => {
    const db = {
      teacherSchool: {
        findUnique: jest.fn().mockResolvedValue({
          workingDays: [1, 4],
          workingDaySlots,
          assignedFrom: null,
          assignedUntil: null,
        }),
      },
      teacherWorkingDaysHistory: { findMany: jest.fn().mockResolvedValue([]) },
      period: {
        findFirst: jest.fn().mockResolvedValue({
          periodNumber: 6,
          startTime: period.s,
          endTime: period.e,
        }),
      },
    };
    const c = Object.create(SchoolAdminExtraController.prototype);
    c.db = db;
    return (day: number, periodId?: string) =>
      c.assertTeacherSchedulable('school-a', 7, day, periodId);
  };
  const am = { '4': { slot: 'MORNING', start: '08:00', end: '12:30' } };

  it('allows a period inside the window', async () => {
    await expect(
      make(am, { s: '9:00', e: '9:45' })(4, 'p1'),
    ).resolves.toBeUndefined();
  });

  it('rejects a period outside the window with a clear message', async () => {
    await expect(make(am, { s: '13:15', e: '14:00' })(4, 'p6')).rejects.toThrow(
      /08:00–12:30 on Thursdays.*P6/,
    );
  });

  it('rejects a period that straddles the window end', async () => {
    await expect(make(am, { s: '12:10', e: '12:50' })(4, 'p5')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('a full-day teacher can take any period', async () => {
    await expect(
      make(null, { s: '15:00', e: '15:40' })(4, 'p9'),
    ).resolves.toBeUndefined();
  });

  it('still rejects a weekday the teacher does not work', async () => {
    await expect(make(am, { s: '9:00', e: '9:45' })(2, 'p1')).rejects.toThrow(
      /Tuesdays/,
    );
  });
});
