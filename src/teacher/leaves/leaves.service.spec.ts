import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TeacherLeavesService } from './leaves.service';
import { DatabaseService } from '../../database/database.service';
import { NotificationsService } from '../../common/notifications/notifications.service';
import { isBeforeAttendanceCutoff } from '../../common/utils/date.util';

// "Today" frozen at 2026-07-20 (IST); the cutoff is toggled per test.
jest.mock('../../common/utils/date.util', () => ({
  ...jest.requireActual('../../common/utils/date.util'),
  getTodayIstDateStr: () => '2026-07-20',
  isBeforeAttendanceCutoff: jest.fn(() => true),
}));

describe('TeacherLeavesService', () => {
  let service: TeacherLeavesService;
  let db: {
    teacherSchool: { findFirst: jest.Mock; findMany: jest.Mock };
    teacherLeave: { findFirst: jest.Mock; create: jest.Mock; findMany: jest.Mock };
    user: { findUnique: jest.Mock; findMany: jest.Mock };
    schoolAdmin: { findMany: jest.Mock };
  };
  let notifications: { createManyRespectingPrefs: jest.Mock };

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
      user: {
        findUnique: jest.fn().mockResolvedValue({
          email: 't@example.com',
          profile: { fullName: 'Teacher' },
        }),
        findMany: jest.fn().mockResolvedValue([{ id: 99 }]),
      },
      schoolAdmin: { findMany: jest.fn().mockResolvedValue([{ userId: 10 }]) },
    };
    notifications = {
      createManyRespectingPrefs: jest.fn().mockResolvedValue(2),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeacherLeavesService,
        { provide: DatabaseService, useValue: db },
        { provide: NotificationsService, useValue: notifications },
      ],
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
    expect(db.teacherLeave.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        teacherId: 1,
        schoolId: 'school-a',
        status: 'pending',
      }),
    });
    expect(result.leave.school_id).toBe('school-a');
  });

  it('pins the leave to the selected school_id (does not re-route)', async () => {
    await service.create(1, { ...baseBody, school_id: 'school-a' });
    expect(db.teacherLeave.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ schoolId: 'school-a' }),
    });
    expect(db.schoolAdmin.findMany).toHaveBeenCalledWith({
      where: { schoolId: 'school-a' },
      select: { userId: true },
    });
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

  it('rejects a leave that starts in the past', async () => {
    await expect(
      service.create(1, { ...baseBody, start_date: '2026-07-19' }),
    ).rejects.toThrow(/cannot start in the past/i);
    expect(db.teacherLeave.create).not.toHaveBeenCalled();
  });

  it('rejects any leave submitted after the 8pm IST cutoff, even for tomorrow', async () => {
    (isBeforeAttendanceCutoff as jest.Mock).mockReturnValue(false);
    await expect(service.create(1, baseBody)).rejects.toThrow(/before 8:00 PM/i);
    await expect(
      service.create(1, { ...baseBody, start_date: '2026-07-21', end_date: '2026-07-22' }),
    ).rejects.toThrow(/before 8:00 PM/i);
    expect(db.teacherLeave.create).not.toHaveBeenCalled();
    (isBeforeAttendanceCutoff as jest.Mock).mockReturnValue(true);
  });

  it('allows a leave for tomorrow before the cutoff', async () => {
    await service.create(1, { ...baseBody, start_date: '2026-07-21', end_date: '2026-07-22' });
    expect(db.teacherLeave.create).toHaveBeenCalled();
  });

  describe('emergency leave', () => {
    const emergency = { ...baseBody, is_emergency: true, reason: 'Medical emergency' };

    it('is accepted after the 8pm cutoff and stored as Emergency/pending with both approval stages pending', async () => {
      (isBeforeAttendanceCutoff as jest.Mock).mockReturnValue(false);
      await service.create(1, emergency);
      expect(db.teacherLeave.create.mock.calls[0][0].data).toMatchObject({
        leaveType: 'Emergency',
        status: 'pending',
        schoolAdminStatus: 'pending',
        adminStatus: 'pending',
      });
      (isBeforeAttendanceCutoff as jest.Mock).mockReturnValue(true);
    });

    it('requires a reason', async () => {
      await expect(service.create(1, { ...emergency, reason: '   ' })).rejects.toThrow(/reason is required/i);
      await expect(service.create(1, { ...baseBody, is_emergency: true })).rejects.toThrow(/reason is required/i);
    });

    it('may start up to 2 days back (today is 2026-07-20) but no further', async () => {
      await service.create(1, { ...emergency, start_date: '2026-07-18', end_date: '2026-07-20' });
      expect(db.teacherLeave.create).toHaveBeenCalledTimes(1);
      await expect(
        service.create(1, { ...emergency, start_date: '2026-07-17', end_date: '2026-07-20' }),
      ).rejects.toThrow(/at most 2 days back/i);
    });

    it('a regular (non-emergency) leave stays blocked in the past and after the cutoff', async () => {
      await expect(service.create(1, { ...baseBody, start_date: '2026-07-19' })).rejects.toThrow(/in the past/i);
      (isBeforeAttendanceCutoff as jest.Mock).mockReturnValue(false);
      await expect(service.create(1, baseBody)).rejects.toThrow(/emergency leave/i);
      (isBeforeAttendanceCutoff as jest.Mock).mockReturnValue(true);
    });

    it('still blocks overlapping leave requests', async () => {
      db.teacherLeave.findFirst.mockResolvedValue({
        id: 'x', status: 'pending', startDate: new Date('2026-07-20'), endDate: new Date('2026-07-21'),
      });
      await expect(service.create(1, emergency)).rejects.toThrow(/overlapping/i);
    });
  });
});
