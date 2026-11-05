/**
 * Today's calendar date in IST, as a UTC-midnight-anchored Date — matches the
 * `dateStr + 'T00:00:00.000Z'` convention every Attendance/SchoolCalendar row
 * is keyed by. Schools operate on the IST calendar day; raw `new Date()` at
 * UTC midnight is wrong for ~5.5 hours every day (just after midnight IST,
 * UTC's calendar day hasn't turned over yet). No timezone library needed —
 * `Intl.DateTimeFormat('en-CA', ...)` already returns YYYY-MM-DD.
 */
export function getTodayIstDateOnly(): Date {
  return new Date(`${getTodayIstDateStr()}T00:00:00.000Z`);
}

/** Same as {@link getTodayIstDateOnly} but as a `YYYY-MM-DD` string. */
export function getTodayIstDateStr(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Attendance cutoff: a report counts toward Present only before 8pm IST. */
export const ATTENDANCE_CUTOFF_HOUR_IST = 20;

export function isBeforeAttendanceCutoff(now: Date = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(now),
  );
  return hour % 24 < ATTENDANCE_CUTOFF_HOUR_IST;
}

/**
 * School admins may approve/reject a leave only until 11pm IST on the day
 * before it starts (or, for a leave starting today, until 11pm that day —
 * never earlier than the day it was filed). System admins have no deadline.
 */
export const SCHOOL_ADMIN_LEAVE_DEADLINE_HOUR_IST = 23;

export function isSchoolAdminLeaveDeadlinePassed(
  leave: { startDate: Date; createdAt: Date; leaveType?: string | null },
  now: Date = new Date(),
): boolean {
  if (leave.leaveType === 'Emergency') return false; // emergency: no cutoff
  const istDay = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
  const dayBeforeStart = new Date(leave.startDate);
  dayBeforeStart.setUTCDate(dayBeforeStart.getUTCDate() - 1);
  const a = dayBeforeStart.toISOString().split('T')[0];
  const b = istDay(leave.createdAt);
  const deadlineDay = a > b ? a : b;
  return now.getTime() >= new Date(`${deadlineDay}T${SCHOOL_ADMIN_LEAVE_DEADLINE_HOUR_IST}:00:00+05:30`).getTime();
}

/** The exact instant the 8pm IST attendance cutoff falls on, for a YYYY-MM-DD day. */
export function attendanceCutoffInstant(dateStr: string): Date {
  return new Date(`${dateStr}T${ATTENDANCE_CUTOFF_HOUR_IST}:00:00+05:30`);
}
