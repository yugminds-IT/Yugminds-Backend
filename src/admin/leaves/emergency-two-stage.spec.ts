import { BadRequestException } from '@nestjs/common';
import { AdminLeavesService } from './leaves.service';

function make(leave: Record<string, unknown>) {
  const db: any = {
    teacherLeave: {
      findUnique: jest.fn().mockResolvedValue(leave),
      update: jest.fn(async ({ data }) => ({
        ...leave,
        ...data,
        startDate: new Date('2026-07-20T00:00:00.000Z'),
        endDate: new Date('2026-07-20T00:00:00.000Z'),
      })),
    },
    attendance: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
      createMany: jest.fn(),
    },
    school: { findUnique: jest.fn().mockResolvedValue({ name: 'S' }) },
    schoolAdmin: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const svc = new AdminLeavesService(
    db,
    { emitDashboardStatsForUsers: jest.fn() } as any,
    { sendOne: jest.fn() } as any,
  );
  return { svc, db };
}
const emergency = (over = {}) => ({
  id: 'E',
  teacherId: 5,
  schoolId: 's1',
  status: 'pending',
  leaveType: 'Emergency',
  schoolAdminStatus: 'pending',
  adminStatus: 'pending',
  adminRemarks: null,
  approvedBy: null,
  startDate: new Date('2026-07-20T00:00:00.000Z'),
  endDate: new Date('2026-07-20T00:00:00.000Z'),
  ...over,
});

describe('admin: emergency leave is stage 2 of 2', () => {
  it('cannot approve before the school admin has approved (sequential)', async () => {
    const { svc, db } = make(emergency());
    await expect(svc.update({ id: 'E', status: 'Approved' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(svc.update({ id: 'E', status: 'Approved' })).rejects.toThrow(
      /school admin must approve/i,
    );
    expect(db.teacherLeave.update).not.toHaveBeenCalled();
  });
  it('cannot approve when the school admin rejected', async () => {
    const { svc } = make(
      emergency({ schoolAdminStatus: 'rejected', status: 'rejected' }),
    );
    await expect(svc.update({ id: 'E', status: 'Approved' })).rejects.toThrow(
      /school admin must approve/i,
    );
  });
  it('approves after stage 1 with no time cutoff: final approved + attendance marked', async () => {
    const { svc, db } = make(emergency({ schoolAdminStatus: 'approved' }));
    await svc.update({ id: 'E', status: 'Approved', actor_user_id: '1' });
    expect(db.teacherLeave.update.mock.calls[0][0].data).toMatchObject({
      status: 'approved',
      adminStatus: 'approved',
      adminBy: '1',
    });
    expect(db.attendance.createMany).toHaveBeenCalled();
  });
  it('can reject at any time, even before the school admin acts', async () => {
    const { svc, db } = make(emergency());
    await svc.update({ id: 'E', status: 'Rejected', actor_user_id: '1' });
    expect(db.teacherLeave.update.mock.calls[0][0].data).toMatchObject({
      status: 'rejected',
      adminStatus: 'rejected',
    });
  });
  it('regular leave keeps single-stage approval (no school-admin prerequisite)', async () => {
    const { svc, db } = make({
      ...emergency(),
      leaveType: 'General',
      schoolAdminStatus: null,
      adminStatus: null,
    });
    await svc.update({ id: 'E', status: 'Approved' });
    expect(
      db.teacherLeave.update.mock.calls[0][0].data.adminStatus,
    ).toBeUndefined();
    expect(db.teacherLeave.update.mock.calls[0][0].data.status).toBe(
      'approved',
    );
  });
});
