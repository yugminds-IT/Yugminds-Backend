import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TeacherReportsService } from './reports.service';
import { DatabaseService } from '../../database/database.service';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { TeacherScheduleService } from '../schedule/teacher-schedule.service';

describe('TeacherReportsService.create', () => {
  let service: TeacherReportsService;
  let db: {
    teacherSchool: { findFirst: jest.Mock };
    teacherReport: { findFirst: jest.Mock; create: jest.Mock; count: jest.Mock };
    attendance: { upsert: jest.Mock };
    classSchedule: { findMany: jest.Mock };
    schoolAdmin: { findMany: jest.Mock };
    user: { findMany: jest.Mock };
  };
  let teacherSchedule: { getWorkStatusForDate: jest.Mock };

  const baseBody = {
    school_id: 'school-a',
    date: '2026-07-20',
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
          reportDate: new Date('2026-07-20T12:00:00.000Z'),
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
      attendance: { upsert: jest.fn().mockResolvedValue({}) },
      classSchedule: { findMany: jest.fn().mockResolvedValue([]) },
      schoolAdmin: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
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

  it('creates the report when the teacher is assigned and it is not a holiday', async () => {
    const result = await service.create(1, baseBody);
    expect(db.teacherReport.create).toHaveBeenCalled();
    expect(result.report.school_id).toBe('school-a');
  });
});
