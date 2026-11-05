import { BadRequestException } from '@nestjs/common';
import { AdminLeavesService } from './leaves.service';

jest.mock('../../common/utils/date.util', () => ({
  ...jest.requireActual('../../common/utils/date.util'),
  getTodayIstDateStr: () => '2026-07-20',
}));

function make(over: { assigned?: unknown; overlap?: unknown } = {}) {
  const db: any = {
    teacherSchool: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          'assigned' in over ? over.assigned : { schoolId: 's1' },
        ),
    },
    teacherLeave: {
      findFirst: jest.fn().mockResolvedValue(over.overlap ?? null),
      create: jest.fn(async ({ data }) => ({ id: 'L1', ...data })),
    },
    schoolAdmin: { findMany: jest.fn().mockResolvedValue([{ userId: 8 }]) },
  };
  const notifications: any = { sendOne: jest.fn() };
  const realtime: any = { emitDashboardStatsForUsers: jest.fn() };
  return {
    svc: new AdminLeavesService(db, realtime, notifications),
    db,
    notifications,
  };
}
const body = {
  teacher_id: 5,
  school_id: 's1',
  start_date: '2026-07-19',
  end_date: '2026-07-20',
  reason: 'Hospitalised',
};

describe('admin: file emergency leave on behalf of a teacher', () => {
  it('creates it with the admin stage approved, school-admin stage pending, still pending overall, no attendance change', async () => {
    const { svc, db, notifications } = make();
    await svc.createEmergency(body, 1);
    expect(db.teacherLeave.create.mock.calls[0][0].data).toMatchObject({
      leaveType: 'Emergency',
      status: 'pending',
      adminStatus: 'approved',
      adminBy: '1',
      schoolAdminStatus: 'pending',
    });
    // teacher + the school admin are told
    expect(
      notifications.sendOne.mock.calls.map((c: any[]) => c[1]).sort(),
    ).toEqual([5, 8]);
  });
  it('requires a reason, enforces the 2-day window, the school assignment and no overlap', async () => {
    await expect(
      make().svc.createEmergency({ ...body, reason: ' ' }, 1),
    ).rejects.toThrow(/reason is required/i);
    await expect(
      make().svc.createEmergency({ ...body, start_date: '2026-07-17' }, 1),
    ).rejects.toThrow(/2 days back/i);
    await expect(
      make({ assigned: null }).svc.createEmergency(body, 1),
    ).rejects.toThrow(/not assigned/i);
    await expect(
      make({ overlap: { id: 'x' } }).svc.createEmergency(body, 1),
    ).rejects.toThrow(/overlapping/i);
  });
  it('rejects missing input and a reversed range', async () => {
    await expect(
      make().svc.createEmergency({ ...body, school_id: undefined }, 1),
    ).rejects.toThrow(BadRequestException);
    await expect(
      make().svc.createEmergency({ ...body, end_date: '2026-07-18' }, 1),
    ).rejects.toThrow(/End date/i);
  });
});
