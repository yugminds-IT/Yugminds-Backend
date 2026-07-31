import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TeacherReportsService } from './reports.service';
import { DatabaseService } from '../../database/database.service';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { TeacherScheduleService } from '../schedule/teacher-schedule.service';
import { getTodayIstDateStr } from '../../common/utils/date.util';

describe('TeacherReportsService.create', () => {
  let service: TeacherReportsService;
  let db: {
    teacherSchool: { findFirst: jest.Mock };
    teacherReport: { findFirst: jest.Mock; create: jest.Mock; count: jest.Mock };
    attendance: { upsert: jest.Mock; findUnique: jest.Mock };
    classSchedule: { findMany: jest.Mock };
    schoolAdmin: { findMany: jest.Mock };
    user: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let teacherSchedule: { getWorkStatusForDate: jest.Mock };

  // A date safely in the past relative to whenever this test runs, so the
  // future-date guard never rejects the existing happy-path tests.
  const pastDate = '2020-01-06'; // a Monday
  const baseBody = {
    school_id: 'school-a',
    date: pastDate,
    period_id: 'period-1',
  };

  beforeEach(async () => {
    db = {
      teacherSchool: { findFirst: jest.fn().mockResolvedValue({ schoolId: 'school-a' }) },
      teacherReport: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'r1',
          schoolId: 'school-a',
          reportDate: new Date(`${pastDate}T12:00:00.000Z`),
          grade: null,
          periodId: 'period-1',
          status: 'submitted',
          topicsTaught: null,
          studentCount: null,
          durationHours: null,
          notes: null,
        }),
        count: jest.fn().mockResolvedValue(0),
      },
      attendance: {
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      classSchedule: { findMany: jest.fn().mockResolvedValue([]) },
      schoolAdmin: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
    };
    teacherSchedule = {
      getWorkStatusForDate: jest.fn().mockResolvedValue({
        workingSchoolIds: ['school-a'],
        holidaySchoolIds: [],
        offScheduleSchoolIds: [],
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeacherReportsService,
        { provide: DatabaseService, useValue: db },
        {
          provide: RealtimeGateway,
          useValue: { emitDashboardStatsForUsers: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: TeacherScheduleService, useValue: teacherSchedule },
      ],
    }).compile();

    service = module.get<TeacherReportsService>(TeacherReportsService);
  });

  it('rejects a report for a school the teacher is not assigned to', async () => {
    db.teacherSchool.findFirst.mockResolvedValue(null);
    await expect(service.create(1, baseBody)).rejects.toThrow(ForbiddenException);
    expect(db.teacherReport.create).not.toHaveBeenCalled();
  });

  it('rejects a report on a date the school has declared a holiday', async () => {
    teacherSchedule.getWorkStatusForDate.mockResolvedValue({
      workingSchoolIds: [],
      holidaySchoolIds: ['school-a'],
      offScheduleSchoolIds: [],
    });
    await expect(service.create(1, baseBody)).rejects.toThrow(BadRequestException);
    expect(db.teacherReport.create).not.toHaveBeenCalled();
  });

  it('rejects a report for a future date', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const futureDateStr = tomorrow.toISOString().split('T')[0];
    // Guard against a flake if this test somehow runs exactly at a date
    // rollover boundary — futureDateStr must actually be after "today".
    expect(futureDateStr > getTodayIstDateStr()).toBe(true);

    await expect(
      service.create(1, { ...baseBody, date: futureDateStr }),
    ).rejects.toThrow(BadRequestException);
    expect(db.teacherReport.create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate report for the same teacher+school+date+period', async () => {
    db.teacherReport.findFirst.mockResolvedValue({ id: 'existing-report' });
    await expect(service.create(1, baseBody)).rejects.toThrow(BadRequestException);
    expect(db.teacherReport.create).not.toHaveBeenCalled();
  });

  it('creates the report when the teacher is assigned and it is not a holiday', async () => {
    const result = await service.create(1, baseBody);
    expect(db.teacherReport.create).toHaveBeenCalled();
    expect(result.report.school_id).toBe('school-a');
  });

  describe('attendance auto-marking', () => {
    it('marks attendance Present when the teacher has no schedule that day (any report counts)', async () => {
      db.classSchedule.findMany.mockResolvedValue([]);
      const result = await service.create(1, baseBody);
      expect(db.attendance.upsert).toHaveBeenCalled();
      expect(result.attendance_marked_present).toBe(true);
    });

    it('does NOT mark attendance Present when only some of the day\'s scheduled periods have been reported', async () => {
      db.classSchedule.findMany.mockResolvedValue([
        { periodId: 'period-1' },
        { periodId: 'period-2' },
      ]);
      // Only 1 of the 2 scheduled periods has a report so far (this submission).
      db.teacherReport.count.mockResolvedValue(1);
      const result = await service.create(1, baseBody);
      expect(db.attendance.upsert).not.toHaveBeenCalled();
      expect(result.attendance_marked_present).toBe(false);
    });

    it('marks attendance Present once every scheduled period for the day has been reported', async () => {
      db.classSchedule.findMany.mockResolvedValue([
        { periodId: 'period-1' },
        { periodId: 'period-2' },
      ]);
      db.teacherReport.count.mockResolvedValue(2);
      const result = await service.create(1, baseBody);
      expect(db.attendance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { status: 'Present' } }),
      );
      expect(result.attendance_marked_present).toBe(true);
    });

    it(
      'never overwrites an existing Leave-Approved day to Present ' +
        '(regression: a teacher on approved leave who submitted any report for that day ' +
        'used to have their leave status silently clobbered)',
      async () => {
        db.classSchedule.findMany.mockResolvedValue([]);
        db.attendance.findUnique.mockResolvedValue({ status: 'Leave-Approved' });
        const result = await service.create(1, baseBody);
        expect(db.attendance.upsert).not.toHaveBeenCalled();
        expect(result.attendance_marked_present).toBe(false);
      },
    );

    it('does mark Present over a non-leave existing status (e.g. a prior Absent record)', async () => {
      db.classSchedule.findMany.mockResolvedValue([]);
      db.attendance.findUnique.mockResolvedValue({ status: 'Absent' });
      const result = await service.create(1, baseBody);
      expect(db.attendance.upsert).toHaveBeenCalled();
      expect(result.attendance_marked_present).toBe(true);
    });
  });

  describe('report_status', () => {
    it('a fresh submission reports as "Pending" to the teacher', async () => {
      const result = await service.create(1, baseBody);
      expect(result.report.report_status).toBe('Pending');
    });
  });
});

describe('TeacherReportsService.list — stats', () => {
  let service: TeacherReportsService;
  let db: {
    teacherReport: { findMany: jest.Mock; count: jest.Mock };
  };

  beforeEach(async () => {
    db = {
      teacherReport: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeacherReportsService,
        { provide: DatabaseService, useValue: db },
        {
          provide: RealtimeGateway,
          useValue: { emitDashboardStatsForUsers: jest.fn() },
        },
        {
          provide: TeacherScheduleService,
          useValue: { getWorkStatusForDate: jest.fn() },
        },
      ],
    }).compile();
    service = module.get<TeacherReportsService>(TeacherReportsService);
  });

  it(
    'returns stats computed via count(), independent of the limit-capped findMany result ' +
      "(regression: the Analytics page's \"Total Reports (All time)\" used to be reports.length " +
      'off a list capped at 500)',
    async () => {
      // findMany (the capped list) returns just 1 row...
      db.teacherReport.findMany.mockResolvedValue([
        {
          id: 'r1',
          schoolId: 'school-a',
          reportDate: new Date('2026-07-20T12:00:00.000Z'),
          grade: 'Grade 1',
          periodId: 'p1',
          status: 'submitted',
          topicsTaught: null,
          studentCount: null,
          durationHours: null,
          notes: null,
        },
      ]);
      // ...but the real counts are much larger, proving stats aren't
      // derived from the capped array.
      db.teacherReport.count
        .mockResolvedValueOnce(600) // total
        .mockResolvedValueOnce(300) // submitted (pending)
        .mockResolvedValueOnce(50) // reviewed
        .mockResolvedValueOnce(200) // approved
        .mockResolvedValueOnce(50); // rejected

      const result = await service.list(1, { limit: 1 });

      expect(result.reports).toHaveLength(1);
      expect(result.stats).toEqual({
        total: 600,
        pending: 300,
        reviewed: 50,
        approved: 200,
        rejected: 50,
      });
    },
  );

  it('scopes every count() call to the requesting teacherId', async () => {
    await service.list(42, {});
    for (const call of db.teacherReport.count.mock.calls) {
      expect(call[0].where.teacherId).toBe(42);
    }
  });
});
