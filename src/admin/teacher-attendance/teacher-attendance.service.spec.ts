import { Test, TestingModule } from '@nestjs/testing';
import { AdminTeacherAttendanceService } from './teacher-attendance.service';
import { DatabaseService } from '../../database/database.service';
import { AdminCalendarService } from '../calendar/calendar.service';

// "Today" is frozen at 2026-07-26 (a Sunday) for every test in this file —
// markMissing must never create rows past this date regardless of what
// end_date a caller requests.
jest.mock('../../common/utils/date.util', () => ({
  ...jest.requireActual('../../common/utils/date.util'),
  getTodayIstDateOnly: () => new Date('2026-07-26T00:00:00.000Z'),
}));

describe('AdminTeacherAttendanceService.markMissing', () => {
  let service: AdminTeacherAttendanceService;
  let db: {
    teacherSchool: { findMany: jest.Mock };
    teacherWorkingDaysHistory: { findMany: jest.Mock };
    attendance: { findMany: jest.Mock; create: jest.Mock };
  };
  let schoolCalendar: { getHolidayDatesForMonth: jest.Mock };

  beforeEach(async () => {
    db = {
      teacherSchool: {
        findMany: jest.fn().mockResolvedValue([{ teacherId: 1, schoolId: 'school-a' }]),
      },
      // Mon-Sat working pattern (0=Sun..6=Sat), in effect well before the range.
      teacherWorkingDaysHistory: {
        findMany: jest.fn().mockResolvedValue([
          { effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), workingDays: [1, 2, 3, 4, 5, 6] },
        ]),
      },
      attendance: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    schoolCalendar = {
      getHolidayDatesForMonth: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminTeacherAttendanceService,
        { provide: DatabaseService, useValue: db },
        { provide: AdminCalendarService, useValue: schoolCalendar },
      ],
    }).compile();

    service = module.get<AdminTeacherAttendanceService>(AdminTeacherAttendanceService);
  });

  it(
    'clamps end_date to today — requesting the whole month (which extends past "today") ' +
      'must not create Unreported rows for days that have not happened yet ' +
      '(regression: this used to sweep future dates, e.g. running "Mark Missing" for July ' +
      'on the 26th also stamped the 27th-31st Unreported before they occurred, all sharing ' +
      'one identical createdAt since they were inserted in the same request)',
    async () => {
      await service.markMissing({ start_date: '2026-07-20', end_date: '2026-07-31' });

      const createdDates = db.attendance.create.mock.calls.map(
        (call) => call[0].data.date.toISOString().split('T')[0],
      );
      expect(createdDates.length).toBeGreaterThan(0);
      for (const dateStr of createdDates) {
        expect(dateStr <= '2026-07-26').toBe(true);
      }
      // "Today" itself (26th, a Sunday) is the automatic weekly off, so the
      // real last created date should be the 25th.
      expect(createdDates).not.toContain('2026-07-27');
      expect(createdDates).not.toContain('2026-07-31');
    },
  );

  it('is a no-op (creates nothing, returns a zeroed summary) when start_date is already after "today"', async () => {
    const result = await service.markMissing({ start_date: '2026-08-01', end_date: '2026-08-31' });
    expect(db.attendance.create).not.toHaveBeenCalled();
    expect(result.summary).toEqual({
      records_created: 0,
      holidays_skipped: 0,
      teachers_affected: 0,
      dates_affected: 0,
    });
  });

  it('still processes the full requested range when end_date is already in the past', async () => {
    await service.markMissing({ start_date: '2026-07-01', end_date: '2026-07-04' });
    const createdDates = db.attendance.create.mock.calls.map(
      (call) => call[0].data.date.toISOString().split('T')[0],
    );
    // Jul 1 2026 is a Wednesday — Wed/Thu/Fri/Sat all working days per the
    // Mon-Sat pattern, none in the future relative to the frozen "today".
    expect(createdDates.sort()).toEqual(['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']);
  });
});
