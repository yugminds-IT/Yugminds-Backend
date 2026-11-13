import { BadRequestException } from '@nestjs/common';
import { REPORT_SUBJECTS } from '../report-subjects';

/**
 * One stored form for grades, times, subjects and statuses. Every value
 * WRITTEN is validated in the DatabaseService hook and rejected (400) if it is
 * not exactly the standard; nothing is converted. Blank means "not set" (null).
 */
const blank = (v: unknown) => v == null || String(v).trim() === '';
const bad = (what: string, v: unknown, hint: string) =>
  new BadRequestException(`Invalid ${what} "${String(v)}". ${hint}`);

/** "Grade 1" … "Grade 12". */
export function parseGrade(v: unknown): string | null {
  if (blank(v)) return null;
  if (typeof v === 'string' && /^Grade (?:[1-9]|1[0-2])$/.test(v)) return v;
  throw bad('grade', v, 'Use the standard form, e.g. "Grade 4" (1–12).');
}

/** 24-hour "HH:mm", zero-padded: "09:05", "14:30". */
export function parseTime(v: unknown): string | null {
  if (blank(v)) return null;
  if (typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v)) return v;
  throw bad('time', v, 'Use 24-hour "HH:mm", e.g. "09:05" or "14:30".');
}

/** Teaching subjects are a fixed list (see report-subjects.ts), exact spelling. */
export function parseSubject(v: unknown): string | null {
  if (blank(v)) return null;
  if (REPORT_SUBJECTS.includes(v as (typeof REPORT_SUBJECTS)[number]))
    return v as string;
  throw bad('subject', v, `Choose one of: ${REPORT_SUBJECTS.join(', ')}.`);
}

/** Allowed `status` values per model (exact spelling). */
export const STATUSES: Record<string, readonly string[]> = {
  Attendance: ['Present', 'Absent', 'Leave-Approved', 'Unreported'],
  TeacherLeave: ['pending', 'approved', 'rejected', 'cancelled'],
  TeacherReport: ['submitted', 'reviewed', 'approved', 'rejected'],
  RetakeRequest: ['pending', 'approved', 'rejected'],
  PasswordResetRequest: ['pending', 'approved', 'rejected', 'completed'],
  ContactSubmission: ['new', 'read', 'replied', 'archived'],
  AssignmentSubmission: ['pending', 'submitted', 'graded', 'late'],
  TeacherSectionAssignment: ['active', 'inactive'],
  StudentCertificate: ['active', 'broken', 'revoked'],
};

export function parseStatus(model: string, v: unknown): string {
  const allowed = STATUSES[model];
  if (!allowed || (typeof v === 'string' && allowed.includes(v))) {
    return v as string;
  }
  throw bad('status', v, `Allowed for ${model}: ${allowed.join(', ')}.`);
}
