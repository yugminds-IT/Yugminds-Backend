import { BadRequestException } from '@nestjs/common';
import {
  attendanceCutoffInstant,
  isSchoolAdminLeaveDeadlinePassed,
} from './date.util';
import {
  applyApprovedLeaveToAttendance,
  assertEmergencyLeaveAllowed,
  leaveStageFields,
  revertLeaveApprovedAttendance,
  shiftDateStr,
} from './leave-rules.util';

describe('assertEmergencyLeaveAllowed', () => {
  it('reason required; start window is today-2 .. future', () => {
    expect(() =>
      assertEmergencyLeaveAllowed('2026-07-20', '', '2026-07-20'),
    ).toThrow(BadRequestException);
    expect(() =>
      assertEmergencyLeaveAllowed('2026-07-18', 'sick', '2026-07-20'),
    ).not.toThrow();
    expect(() =>
      assertEmergencyLeaveAllowed('2026-07-17', 'sick', '2026-07-20'),
    ).toThrow(/2 days back/);
    expect(() =>
      assertEmergencyLeaveAllowed('2026-08-01', 'sick', '2026-07-20'),
    ).not.toThrow();
  });
  it('shiftDateStr crosses month boundaries', () => {
    expect(shiftDateStr('2026-03-01', -2)).toBe('2026-02-27');
  });
});

describe('emergency leave has no school-admin deadline', () => {
  const base = {
    startDate: new Date('2026-07-21T00:00:00.000Z'),
    createdAt: new Date('2026-07-20T08:00:00.000Z'),
  };
  const late = new Date('2026-07-25T00:00:00.000Z');
  it('regular leave is locked long after; emergency never is', () => {
    expect(isSchoolAdminLeaveDeadlinePassed(base, late)).toBe(true);
    expect(
      isSchoolAdminLeaveDeadlinePassed(
        { ...base, leaveType: 'Emergency' },
        late,
      ),
    ).toBe(false);
  });
});

describe('applyApprovedLeaveToAttendance', () => {
  it('upserts Leave-Approved for each day but leaves Present days alone', async () => {
    const statuses: Record<string, string> = {
      '2026-07-19': 'Present',
      '2026-07-20': 'Absent',
    };
    const upsert = jest.fn();
    const db = {
      attendance: {
        findUnique: jest.fn(async ({ where }) => {
          const d = where.teacherId_schoolId_date.date
            .toISOString()
            .split('T')[0];
          return statuses[d] ? { status: statuses[d] } : null;
        }),
        upsert,
      },
    };
    await applyApprovedLeaveToAttendance(db, {
      teacherId: 1,
      schoolId: 's',
      startDate: new Date('2026-07-19T00:00:00.000Z'),
      endDate: new Date('2026-07-21T23:59:59.999Z'),
    });
    const days = upsert.mock.calls.map(
      (c) => c[0].create.date.toISOString().split('T')[0],
    );
    expect(days).toEqual(['2026-07-20', '2026-07-21']); // 19th was Present → skipped
    expect(upsert.mock.calls[0][0].update).toEqual({
      status: 'Leave-Approved',
    });
  });
});

describe('leaveStageFields (what teacher/admins see)', () => {
  it('regular leave exposes no stages', () => {
    expect(leaveStageFields({ leaveType: 'General' })).toEqual({
      is_emergency: false,
    });
  });
  it('emergency leave exposes both stages; null reads as pending', () => {
    expect(
      leaveStageFields({
        leaveType: 'Emergency',
        schoolAdminStatus: 'approved',
        adminStatus: null,
        schoolAdminAt: new Date('2026-07-20T10:00:00Z'),
      }),
    ).toEqual({
      is_emergency: true,
      school_admin_status: 'approved',
      admin_status: 'pending',
      school_admin_at: '2026-07-20T10:00:00.000Z',
      admin_at: null,
    });
  });
});

describe('attendanceCutoffInstant', () => {
  it('is 8pm IST = 14:30 UTC on that day', () => {
    expect(attendanceCutoffInstant('2026-07-27').toISOString()).toBe(
      '2026-07-27T14:30:00.000Z',
    );
  });
});

describe('revertLeaveApprovedAttendance (rejected after approval)', () => {
  it('past days go back to Absent, today/future to Unreported', async () => {
    const updateMany = jest.fn();
    await revertLeaveApprovedAttendance(
      { attendance: { updateMany } },
      {
        teacherId: 1,
        schoolId: 's',
        startDate: new Date('2026-07-18T00:00:00.000Z'),
        endDate: new Date('2026-07-22T00:00:00.000Z'),
      },
      '2026-07-20',
    );
    const [past, rest] = updateMany.mock.calls.map((c) => c[0]);
    expect(past.data).toEqual({ status: 'Absent' });
    expect(past.where.date.gte.toISOString()).toBe('2026-07-18T00:00:00.000Z');
    expect(past.where.date.lt.toISOString()).toBe('2026-07-20T00:00:00.000Z');
    expect(rest.data).toEqual({ status: 'Unreported' });
    expect(rest.where.date.gte.toISOString()).toBe('2026-07-20T00:00:00.000Z');
    expect(rest.where.status).toBe('Leave-Approved');
  });
});
