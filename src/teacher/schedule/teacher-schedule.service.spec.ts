import { Test, TestingModule } from '@nestjs/testing';
import { TeacherScheduleService } from './teacher-schedule.service';
import { DatabaseService } from '../../database/database.service';
import { AdminCalendarService } from '../../admin/calendar/calendar.service';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('TeacherScheduleService', () => {
  let service: TeacherScheduleService;
  let db: { teacherWorkingDaysHistory: { findMany: jest.Mock } };
  let calendar: {
    getHolidayDatesForMonth: jest.Mock;
    getCompensatoryDatesForMonth: jest.Mock;
  };

  beforeEach(async () => {
    db = { teacherWorkingDaysHistory: { findMany: jest.fn() } };
    calendar = {
      getHolidayDatesForMonth: jest.fn().mockResolvedValue([]),
      getCompensatoryDatesForMonth: jest.fn().mockResolvedValue([]),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeacherScheduleService,
        { provide: DatabaseService, useValue: db },
        { provide: AdminCalendarService, useValue: calendar },
      ],
    }).compile();

    service = module.get<TeacherScheduleService>(TeacherScheduleService);
  });

  it('returns empty result for an empty school list', async () => {
    const result = await service.getWorkStatusForDate(1, [], d('2026-07-20'));
    expect(result).toEqual({
      workingSchoolIds: [],
      holidaySchoolIds: [],
      offScheduleSchoolIds: [],
    });
  });

  it('classifies a school as working when today matches the resolved weekly pattern', async () => {
    // 2026-07-20 is a Monday.
    db.teacherWorkingDaysHistory.findMany.mockResolvedValue([
      { effectiveFrom: d('2026-07-01'), workingDays: [1, 2, 3, 4, 5] },
    ]);
    const result = await service.getWorkStatusForDate(1, ['school-a'], d('2026-07-20'));
    expect(result.workingSchoolIds).toEqual(['school-a']);
    expect(result.holidaySchoolIds).toEqual([]);
    expect(result.offScheduleSchoolIds).toEqual([]);
  });

  it('classifies a school as off-schedule when today is not in the weekly pattern', async () => {
    // Teacher only works Mon-Thu at this school; 2026-07-24 is a Friday.
    db.teacherWorkingDaysHistory.findMany.mockResolvedValue([
      { effectiveFrom: d('2026-07-01'), workingDays: [1, 2, 3, 4] },
    ]);
    const result = await service.getWorkStatusForDate(1, ['school-a'], d('2026-07-24'));
    expect(result.offScheduleSchoolIds).toEqual(['school-a']);
    expect(result.workingSchoolIds).toEqual([]);
  });

  it('classifies a school as holiday even on an otherwise-working weekday', async () => {
    db.teacherWorkingDaysHistory.findMany.mockResolvedValue([
      { effectiveFrom: d('2026-07-01'), workingDays: [1, 2, 3, 4, 5] },
    ]);
    calendar.getHolidayDatesForMonth.mockResolvedValue([
      { date: '2026-07-20', type: 'Holiday' },
    ]);
    const result = await service.getWorkStatusForDate(1, ['school-a'], d('2026-07-20'));
    expect(result.holidaySchoolIds).toEqual(['school-a']);
    expect(result.workingSchoolIds).toEqual([]);
  });

  it('treats a declared compensatory-work day as working even outside the weekly pattern', async () => {
    // 2026-07-25 is a Saturday, not in the Mon-Fri pattern, but declared CompensatoryWork.
    db.teacherWorkingDaysHistory.findMany.mockResolvedValue([
      { effectiveFrom: d('2026-07-01'), workingDays: [1, 2, 3, 4, 5] },
    ]);
    calendar.getCompensatoryDatesForMonth.mockResolvedValue(['2026-07-25']);
    const result = await service.getWorkStatusForDate(1, ['school-a'], d('2026-07-25'));
    expect(result.workingSchoolIds).toEqual(['school-a']);
    expect(result.offScheduleSchoolIds).toEqual([]);
  });

  it('resolves each school independently for a multi-school teacher on the same date', async () => {
    // 2026-07-24 is a Friday: school-a works Mon-Fri (working), school-b works Mon-Thu (off-schedule).
    db.teacherWorkingDaysHistory.findMany.mockImplementation(
      ({ where }: { where: { schoolId: string } }) =>
        Promise.resolve(
          where.schoolId === 'school-a'
            ? [{ effectiveFrom: d('2026-07-01'), workingDays: [1, 2, 3, 4, 5] }]
            : [{ effectiveFrom: d('2026-07-01'), workingDays: [1, 2, 3, 4] }],
        ),
    );
    const result = await service.getWorkStatusForDate(
      1,
      ['school-a', 'school-b'],
      d('2026-07-24'),
    );
    expect(result.workingSchoolIds).toEqual(['school-a']);
    expect(result.offScheduleSchoolIds).toEqual(['school-b']);
  });

  it('classifies a school with no working-days history yet as off-schedule (not working)', async () => {
    db.teacherWorkingDaysHistory.findMany.mockResolvedValue([]);
    const result = await service.getWorkStatusForDate(1, ['school-a'], d('2026-07-20'));
    expect(result.offScheduleSchoolIds).toEqual(['school-a']);
    expect(result.workingSchoolIds).toEqual([]);
  });
});
