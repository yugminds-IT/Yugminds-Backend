import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TeacherLeavesService } from './leaves.service';
import { DatabaseService } from '../../database/database.service';

describe('TeacherLeavesService', () => {
  let service: TeacherLeavesService;
  let db: {
    teacherSchool: { findFirst: jest.Mock; findMany: jest.Mock };
    teacherWorkingDaysHistory: { findMany: jest.Mock };
    teacherLeave: { findFirst: jest.Mock; create: jest.Mock; findMany: jest.Mock };
  };

  const baseBody = {
    school_id: 'school-a',
    start_date: '2026-07-20',
    end_date: '2026-07-21',
  };

  beforeEach(async () => {
    db = {
      teacherSchool: {
        findFirst: jest.fn().mockResolvedValue({ schoolId: 'school-a' }),
        findMany: jest.fn().mockResolvedValue([{ schoolId: 'school-a' }]),
      },
      // Empty history -> resolveSchoolRangesForLeave falls back to the
      // teacher-selected school_id/date-range as a single target.
      teacherWorkingDaysHistory: { findMany: jest.fn().mockResolvedValue([]) },
      teacherLeave: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'l1',
          schoolId: 'school-a',
          startDate: new Date('2026-07-20T00:00:00.000Z'),
          endDate: new Date('2026-07-21T23:59:59.999Z'),
          reason: null,
          status: 'pending',
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [TeacherLeavesService, { provide: DatabaseService, useValue: db }],
    }).compile();

    service = module.get<TeacherLeavesService>(TeacherLeavesService);
  });

  it('rejects a leave request for a school the teacher is not assigned to', async () => {
    db.teacherSchool.findFirst.mockResolvedValue(null);
    await expect(service.create(1, baseBody)).rejects.toThrow(ForbiddenException);
    expect(db.teacherLeave.create).not.toHaveBeenCalled();
  });

  it('creates a leave request when the teacher is assigned to the school', async () => {
    const result = await service.create(1, baseBody);
    expect(db.teacherLeave.create).toHaveBeenCalled();
    expect(result.leave.school_id).toBe('school-a');
  });

  it('rejects an overlapping pending/approved leave request', async () => {
    db.teacherLeave.findFirst.mockResolvedValue({
      id: 'existing',
      status: 'approved',
      startDate: new Date('2026-07-20T00:00:00.000Z'),
      endDate: new Date('2026-07-22T00:00:00.000Z'),
    });
    await expect(service.create(1, baseBody)).rejects.toThrow(BadRequestException);
    expect(db.teacherLeave.create).not.toHaveBeenCalled();
  });

  it('rejects listing leaves for a school the teacher is not assigned to', async () => {
    db.teacherSchool.findFirst.mockResolvedValue(null);
    await expect(service.list(1, 'school-b')).rejects.toThrow(ForbiddenException);
  });
});
