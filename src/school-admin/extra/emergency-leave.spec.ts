import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SchoolAdminExtraController } from './school-admin-extra.controller';

jest.mock('../../common/utils/date.util', () => ({
  ...jest.requireActual('../../common/utils/date.util'),
  getTodayIstDateStr: () => '2026-07-20',
}));

const user = { id: 99 };
function make(
  over: { overlap?: unknown; assigned?: unknown; leave?: unknown } = {},
) {
  const attendanceUpsert = jest.fn();
  const leaveCreate = jest.fn(async ({ data }) => ({ id: 'L1', ...data }));
  const db: any = {
    schoolAdmin: { findFirst: jest.fn().mockResolvedValue({ schoolId: 's1' }) },
    teacherSchool: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          'assigned' in over ? over.assigned : { schoolId: 's1' },
        ),
    },
    teacherLeave: {
      findFirst: jest.fn().mockResolvedValue(over.overlap ?? null),
      create: leaveCreate,
      update: jest.fn(async ({ data }) => ({
        teacherId: 5,
        schoolId: 's1',
        startDate: new Date('2026-07-21T00:00:00.000Z'),
        endDate: new Date('2026-07-21T23:59:59.999Z'),
        adminRemarks: null,
        ...data,
      })),
    },
    attendance: {
      findUnique: jest.fn().mockResolvedValue({ status: 'Absent' }),
      upsert: attendanceUpsert,
      updateMany: jest.fn(),
    },
    school: { findUnique: jest.fn().mockResolvedValue({ name: 'S' }) },
    schoolAdmin2: {},
  };
  db.teacherLeave.findFirst = jest
    .fn()
    .mockImplementation(async (a) =>
      a?.where?.id ? (over.leave ?? null) : (over.overlap ?? null),
    );
  db.schoolAdmin.findMany = jest.fn().mockResolvedValue([]);
  db.user = { findMany: jest.fn().mockResolvedValue([]) };
  const notifications: any = { sendOne: jest.fn() };
  const realtime: any = { emitDashboardStatsForUsers: jest.fn() };
  const ctl = new SchoolAdminExtraController(
    db,
    {} as any,
    realtime,
    {} as any,
    notifications,
  );
  return { ctl, db, attendanceUpsert, leaveCreate, notifications };
}
const body = {
  teacher_id: 5,
  start_date: '2026-07-19',
  end_date: '2026-07-20',
  reason: 'Hospitalised',
};

describe('school admin: create emergency leave on behalf of a teacher', () => {
  it('creates an Emergency leave with stage 1 approved, stage 2 pending, and NO attendance change yet', async () => {
    const { ctl, leaveCreate, attendanceUpsert, notifications } = make();
    await ctl.createEmergencyLeave(user, body);
    expect(leaveCreate.mock.calls[0][0].data).toMatchObject({
      teacherId: 5,
      schoolId: 's1',
      leaveType: 'Emergency',
      status: 'pending',
      schoolAdminStatus: 'approved',
      schoolAdminBy: '99',
      adminStatus: 'pending',
    });
    expect(attendanceUpsert).not.toHaveBeenCalled();
    expect(notifications.sendOne).toHaveBeenCalled(); // teacher (+ admins, none in this mock)
  });
  it('requires a reason', async () => {
    await expect(
      make().ctl.createEmergencyLeave(user, { ...body, reason: '' }),
    ).rejects.toThrow(/reason is required/i);
  });
  it('rejects a start more than 2 days back', async () => {
    await expect(
      make().ctl.createEmergencyLeave(user, {
        ...body,
        start_date: '2026-07-17',
      }),
    ).rejects.toThrow(/2 days back/i);
  });
  it('rejects a teacher from another school', async () => {
    await expect(
      make({ assigned: null }).ctl.createEmergencyLeave(user, body),
    ).rejects.toThrow(/not assigned/i);
  });
  it('rejects an overlapping leave', async () => {
    await expect(
      make({ overlap: { id: 'x' } }).ctl.createEmergencyLeave(user, body),
    ).rejects.toThrow(/overlapping/i);
  });
  it('rejects missing/invalid input', async () => {
    const { ctl } = make();
    await expect(
      ctl.createEmergencyLeave(user, {
        start_date: '2026-07-20',
        end_date: '2026-07-20',
        reason: 'x',
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      ctl.createEmergencyLeave(user, { ...body, end_date: '2026-07-18' }),
    ).rejects.toThrow(/End date/i);
  });
});

describe('school admin: approving leave (11pm deadline vs emergency)', () => {
  const regular = {
    id: 'R',
    schoolId: 's1',
    teacherId: 5,
    status: 'pending',
    leaveType: 'General',
    startDate: new Date('2020-01-02T00:00:00.000Z'),
    createdAt: new Date('2020-01-01T05:00:00.000Z'),
  };
  it('blocks a school admin on a regular leave after the 11pm deadline', async () => {
    const { ctl } = make({ leave: regular });
    await expect(
      ctl.updateLeave(user, 'R', { action: 'approve' }),
    ).rejects.toThrow(ForbiddenException);
  });
  const emergencyLeave = {
    ...regular,
    id: 'E',
    leaveType: 'Emergency',
    schoolAdminStatus: 'pending',
    adminStatus: 'pending',
  };

  it('school admin approving an emergency leave (no cutoff) is only stage 1: stays pending, no attendance change', async () => {
    const { ctl, db, attendanceUpsert, notifications } = make({
      leave: emergencyLeave,
    });
    await ctl.updateLeave(user, 'E', { action: 'approve' });
    const data = db.teacherLeave.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: 'pending',
      schoolAdminStatus: 'approved',
      schoolAdminBy: '99',
    });
    expect(data.approvedBy).toBeUndefined();
    expect(attendanceUpsert).not.toHaveBeenCalled();
    expect(notifications.sendOne).toHaveBeenCalled(); // teacher told it awaits admin
  });
  it('school admin rejecting an emergency leave rejects the whole leave', async () => {
    const { ctl, db } = make({ leave: emergencyLeave });
    await ctl.updateLeave(user, 'E', { action: 'reject' });
    expect(db.teacherLeave.update.mock.calls[0][0].data).toMatchObject({
      status: 'rejected',
      schoolAdminStatus: 'rejected',
    });
  });
  it('school admin cannot act once the emergency leave is already decided', async () => {
    const { ctl } = make({ leave: { ...emergencyLeave, status: 'approved' } });
    await expect(
      ctl.updateLeave(user, 'E', { action: 'reject' }),
    ).rejects.toThrow(/already been decided/i);
  });
  it('emergency leave cannot be reset to pending', async () => {
    const { ctl } = make({ leave: emergencyLeave });
    await expect(
      ctl.updateLeave(user, 'E', { status: 'pending' }),
    ).rejects.toThrow(/approved or rejected/i);
  });
  it('school admin approval FINALISES an admin-filed emergency leave (admin already approved) and marks attendance', async () => {
    const { ctl, db, attendanceUpsert } = make({
      leave: { ...emergencyLeave, adminStatus: 'approved' },
    });
    await ctl.updateLeave(user, 'E', { action: 'approve' });
    expect(db.teacherLeave.update.mock.calls[0][0].data).toMatchObject({
      status: 'approved',
      schoolAdminStatus: 'approved',
    });
    expect(attendanceUpsert).toHaveBeenCalled();
  });
  it('a cancelled leave cannot be approved or rejected', async () => {
    const { ctl } = make({
      leave: { ...regular, id: 'C', status: 'cancelled' },
    });
    await expect(
      ctl.updateLeave(user, 'C', { action: 'approve' }),
    ).rejects.toThrow(/cancelled/i);
  });
});
