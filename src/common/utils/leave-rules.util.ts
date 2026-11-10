import { BadRequestException } from '@nestjs/common';

/** Stored in TeacherLeave.leaveType. Emergency leaves skip every time cutoff. */
export const EMERGENCY_LEAVE_TYPE = 'Emergency';
/** An emergency leave may start up to this many days in the past (today = 0). */
export const EMERGENCY_MAX_BACKDATE_DAYS = 2;

export const isEmergencyLeave = (l: { leaveType?: string | null }): boolean =>
  l.leaveType === EMERGENCY_LEAVE_TYPE;

/** Longest single leave request; approval writes one attendance row per day. */
export const MAX_LEAVE_DAYS = 366;

/** Rejects a leave range longer than MAX_LEAVE_DAYS (inputs already validated YYYY-MM-DD). */
export function assertLeaveSpan(startDate: string, endDate: string): void {
  const days =
    (Date.parse(`${endDate}T00:00:00.000Z`) -
      Date.parse(`${startDate}T00:00:00.000Z`)) /
      86400000 +
    1;
  if (days > MAX_LEAVE_DAYS) {
    throw new BadRequestException(
      `A leave cannot span more than ${MAX_LEAVE_DAYS} days.`,
    );
  }
}

/** YYYY-MM-DD shifted by `days` (calendar math in UTC, no timezone drift). */
export function shiftDateStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/** Strict emergency rules: a reason is required and the start can't be too far back. */
export function assertEmergencyLeaveAllowed(
  startDate: string,
  reason: string | undefined | null,
  todayStr: string,
): void {
  if (!reason?.trim()) {
    throw new BadRequestException(
      'A reason is required for an emergency leave.',
    );
  }
  const earliest = shiftDateStr(todayStr, -EMERGENCY_MAX_BACKDATE_DAYS);
  if (startDate < earliest) {
    throw new BadRequestException(
      `An emergency leave can start at most ${EMERGENCY_MAX_BACKDATE_DAYS} days back (earliest ${earliest}).`,
    );
  }
}

type AttendanceDb = {
  attendance: {
    findUnique: (a: any) => Promise<{ status: string } | null>;
    upsert: (a: any) => Promise<unknown>;
  };
};

/**
 * Marks every day of an approved leave Leave-Approved, except days the
 * teacher is already Present. Shared by approval and school-admin-created
 * emergency leave so both behave identically (including past days that the
 * 8pm cron already stamped Absent).
 */
export async function applyApprovedLeaveToAttendance(
  db: AttendanceDb,
  leave: {
    teacherId: number;
    schoolId: string;
    startDate: Date;
    endDate: Date;
  },
): Promise<void> {
  const start = new Date(leave.startDate);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(leave.endDate);
  end.setUTCHours(0, 0, 0, 0);
  for (
    const d = new Date(start);
    d.getTime() <= end.getTime();
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const key = {
      teacherId_schoolId_date: {
        teacherId: leave.teacherId,
        schoolId: leave.schoolId,
        date: new Date(d),
      },
    };
    const existing = await db.attendance.findUnique({ where: key });
    if (existing?.status === 'Present') continue;
    await db.attendance.upsert({
      where: key,
      create: {
        teacherId: leave.teacherId,
        schoolId: leave.schoolId,
        date: new Date(d),
        status: 'Leave-Approved',
      },
      update: { status: 'Leave-Approved' },
    });
  }
}

export type ApprovalStage = 'pending' | 'approved' | 'rejected';

/** Per-stage view of an emergency leave (null stage columns read as pending). */
export function emergencyStages(l: {
  schoolAdminStatus?: string | null;
  adminStatus?: string | null;
}): { school_admin_status: ApprovalStage; admin_status: ApprovalStage } {
  return {
    school_admin_status: (l.schoolAdminStatus as ApprovalStage) ?? 'pending',
    admin_status: (l.adminStatus as ApprovalStage) ?? 'pending',
  };
}

/** Fields every list/create response adds so each role can see both stages. */
export function leaveStageFields(l: {
  leaveType?: string | null;
  schoolAdminStatus?: string | null;
  adminStatus?: string | null;
  schoolAdminAt?: Date | null;
  adminAt?: Date | null;
}) {
  if (!isEmergencyLeave(l)) return { is_emergency: false };
  return {
    is_emergency: true,
    ...emergencyStages(l),
    school_admin_at: l.schoolAdminAt?.toISOString() ?? null,
    admin_at: l.adminAt?.toISOString() ?? null,
  };
}

/** School admin is stage 1: can act only while the leave is still undecided. */
export function assertSchoolAdminStageOpen(l: { status: string }): void {
  if (l.status !== 'pending') {
    throw new BadRequestException(
      'This emergency leave has already been decided; only a system admin can change it.',
    );
  }
}

/** Admin is stage 2: approval requires the school admin's approval first. */
export function assertAdminMayApproveEmergency(l: {
  schoolAdminStatus?: string | null;
}): void {
  if (l.schoolAdminStatus !== 'approved') {
    throw new BadRequestException(
      'The school admin must approve this emergency leave first (approvals are sequential).',
    );
  }
}

type AttendanceBulkDb = {
  attendance: { updateMany: (a: any) => Promise<unknown> };
};

/**
 * A leave that was approved and is now rejected: its Leave-Approved days go
 * back to what they'd have been — Absent for days already settled (before
 * today), Unreported for today/future (settled by the 8pm run later).
 */
export async function revertLeaveApprovedAttendance(
  db: AttendanceBulkDb,
  leave: {
    teacherId: number;
    schoolId: string;
    startDate: Date;
    endDate: Date;
  },
  todayStr: string,
): Promise<void> {
  const start = new Date(leave.startDate);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(leave.endDate);
  end.setUTCHours(23, 59, 59, 999);
  const today = new Date(`${todayStr}T00:00:00.000Z`);
  const base = {
    teacherId: leave.teacherId,
    schoolId: leave.schoolId,
    status: 'Leave-Approved',
  };
  await db.attendance.updateMany({
    where: { ...base, date: { gte: start, lt: today < end ? today : end } },
    data: { status: 'Absent' },
  });
  await db.attendance.updateMany({
    where: { ...base, date: { gte: today > start ? today : start, lte: end } },
    data: { status: 'Unreported' },
  });
}
