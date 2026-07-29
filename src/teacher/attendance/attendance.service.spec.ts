import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { TeacherAttendanceService } from './attendance.service';
import { DatabaseService } from '../../database/database.service';
import { TeacherScheduleService } from '../schedule/teacher-schedule.service';

describe('TeacherAttendanceService.getToday', () => {
  let service: TeacherAttendanceService;
  let db: {
    teacherSchool: { findFirst: jest.Mock; findMany: jest.Mock };
    classSchedule: { findMany: jest.Mock };
    period: { findMany: jest.Mock };
    teacherReport: { findMany: jest.Mock };
    attendance: { findFirst: jest.Mock };
    teacherLeave: { findFirst: jest.Mock };
  };
  let teacherSchedule: { getWorkStatusForDate: jest.Mock };

  beforeEach(async () => {
    db = {
      teacherSchool: {
        findFirst: jest.fn().mockResolvedValue({ schoolId: 'school-a' }),
        findMany: jest.fn().mockResolvedValue([{ schoolId: 'school-a' }]),
      },
      classSchedule: { findMany: jest.fn().mockResolvedValue([]) },
      period: { findMany: jest.fn().mockResolvedValue([]) },
      teacherReport: { findMany: jest.fn().mockResolvedValue([]) },
      attendance: { findFirst: jest.fn().mockResolvedValue(null) },
      teacherLeave: { findFirst: jest.fn().mockResolvedValue(null) },
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
        TeacherAttendanceService,
        { provide: DatabaseService, useValue: db },
        { provide: TeacherScheduleService, useValue: teacherSchedule },
      ],
    }).compile();

    service = module.get<TeacherAttendanceService>(TeacherAttendanceService);
  });

  it('rejects a school_id the teacher is not assigned to', async () => {
    db.teacherSchool.findFirst.mockResolvedValue(null);
    await expect(
      service.getToday(1, 'school-b', '2026-07-20'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('reports Holiday status and skips ClassSchedule lookups when the school is closed today', async () => {
    teacherSchedule.getWorkStatusForDate.mockResolvedValue({
      workingSchoolIds: [],
      holidaySchoolIds: ['school-a'],
      offScheduleSchoolIds: [],
    });
    const result = await service.getToday(1, 'school-a', '2026-07-20');
    expect(result.attendance).toEqual({ status: 'Holiday', date: '2026-07-20' });
    expect(result.notScheduledToday).toBe(true);
    expect(db.classSchedule.findMany).not.toHaveBeenCalled();
  });

  it('reports Not-Scheduled status when the teacher has no working school today (not a holiday)', async () => {
    teacherSchedule.getWorkStatusForDate.mockResolvedValue({
      workingSchoolIds: [],
      holidaySchoolIds: [],
      offScheduleSchoolIds: ['school-a'],
    });
    const result = await service.getToday(1, 'school-a', '2026-07-20');
    expect(result.attendance).toEqual({ status: 'Not-Scheduled', date: '2026-07-20' });
  });

  it('restricts the ClassSchedule lookup to only the schools working today', async () => {
    await service.getToday(1, 'school-a', '2026-07-20');
    expect(db.classSchedule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ schoolId: { in: ['school-a'] } }),
      }),
    );
  });
});
