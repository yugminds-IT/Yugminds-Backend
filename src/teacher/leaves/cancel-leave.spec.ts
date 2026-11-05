import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TeacherLeavesService } from './leaves.service';

jest.mock('../../common/utils/date.util', () => ({
  ...jest.requireActual('../../common/utils/date.util'),
  getTodayIstDateStr: () => '2026-07-20',
}));

const leave = (over: Record<string, unknown> = {}) => ({
  id: 'L1',
  teacherId: 1,
  schoolId: 's1',
  status: 'pending',
  startDate: new Date('2026-07-22T00:00:00.000Z'),
  endDate: new Date('2026-07-23T23:59:59.999Z'),
  ...over,
});

function make(found: unknown) {
  const db: any = {
    teacherLeave: {
      findFirst: jest.fn().mockResolvedValue(found),
      update: jest.fn().mockResolvedValue({}),
    },
    attendance: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ email: 't@x.org', profile: { fullName: 'T' } }),
      findMany: jest.fn().mockResolvedValue([{ id: 9 }]),
    },
    schoolAdmin: { findMany: jest.fn().mockResolvedValue([{ userId: 8 }]) },
  };
  const notifications: any = { createManyRespectingPrefs: jest.fn() };
  return {
    svc: new TeacherLeavesService(db, notifications),
    db,
    notifications,
  };
}

describe('TeacherLeavesService.cancel', () => {
  it('cancels a pending leave (no attendance change) and notifies school admins + admins', async () => {
    const { svc, db, notifications } = make(leave());
    const r = await svc.cancel(1, 'L1');
    expect(db.teacherLeave.update).toHaveBeenCalledWith({
      where: { id: 'L1' },
      data: { status: 'cancelled' },
    });
    expect(db.attendance.deleteMany).not.toHaveBeenCalled();
    expect(
      notifications.createManyRespectingPrefs.mock.calls[0][0]
        .map((n: any) => n.userId)
        .sort(),
    ).toEqual([8, 9]);
    expect(r.leave.status).toBe('Cancelled');
  });

  it('cancels an approved leave that has not started and clears its Leave-Approved days', async () => {
    const { svc, db } = make(leave({ status: 'approved' }));
    await svc.cancel(1, 'L1');
    expect(db.attendance.deleteMany.mock.calls[0][0].where).toMatchObject({
      teacherId: 1,
      schoolId: 's1',
      status: 'Leave-Approved',
    });
  });

  it('refuses an approved leave that starts today or has started', async () => {
    const started = make(
      leave({
        status: 'approved',
        startDate: new Date('2026-07-20T00:00:00.000Z'),
      }),
    );
    await expect(started.svc.cancel(1, 'L1')).rejects.toThrow(
      /before it starts/i,
    );
    expect(started.db.teacherLeave.update).not.toHaveBeenCalled();
  });

  it('refuses rejected and already-cancelled leaves', async () => {
    await expect(
      make(leave({ status: 'rejected' })).svc.cancel(1, 'L1'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      make(leave({ status: 'cancelled' })).svc.cancel(1, 'L1'),
    ).rejects.toThrow(/already cancelled/i);
  });

  it("can't cancel someone else's leave (looked up by teacherId)", async () => {
    const { svc, db } = make(null);
    await expect(svc.cancel(1, 'L1')).rejects.toThrow(NotFoundException);
    expect(db.teacherLeave.findFirst).toHaveBeenCalledWith({
      where: { id: 'L1', teacherId: 1 },
    });
  });
});
