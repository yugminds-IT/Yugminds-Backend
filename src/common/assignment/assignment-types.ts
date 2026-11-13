import { BadRequestException } from '@nestjs/common';

export const ASSIGNMENT_TYPES = ['COURSE', 'DAILY', 'EXAM'] as const;
export type AssignmentTypeName = (typeof ASSIGNMENT_TYPES)[number];

export const EXAM_TYPES = [
  'ANNUAL',
  'SEMESTER',
  'QUARTERLY',
  'HALF_YEARLY',
  'MID_TERM',
  'UNIT_TEST',
  'OTHER',
] as const;

/** Strict parse: unknown values are a 400, never silently coerced to DAILY. */
export function parseAssignmentType(
  raw: unknown,
  fallback: AssignmentTypeName = 'DAILY',
): AssignmentTypeName {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const v = String(raw).toUpperCase();
  if (!(ASSIGNMENT_TYPES as readonly string[]).includes(v)) {
    throw new BadRequestException(
      `assignmentType must be one of ${ASSIGNMENT_TYPES.join(', ')}`,
    );
  }
  return v as AssignmentTypeName;
}

export function parseExamType(raw: unknown): string {
  const v = String(raw ?? '').toUpperCase();
  if (!(EXAM_TYPES as readonly string[]).includes(v)) {
    throw new BadRequestException(
      `examType must be one of ${EXAM_TYPES.join(', ')}`,
    );
  }
  return v;
}

export type ExamPhase = 'upcoming' | 'open' | 'closed';

export function examPhase(
  a: { startsAt: Date | null; endsAt: Date | null },
  now = new Date(),
): ExamPhase {
  if (a.startsAt && now < a.startsAt) return 'upcoming';
  if (a.endsAt && now > a.endsAt) return 'closed';
  return 'open';
}

/** Latest moment this attempt may be submitted (window end, capped by duration). */
export function examDeadline(
  a: { endsAt: Date | null; durationMinutes: number | null },
  startedAt: Date,
): Date | null {
  const byDuration = a.durationMinutes
    ? new Date(startedAt.getTime() + a.durationMinutes * 60_000)
    : null;
  if (a.endsAt && byDuration)
    return a.endsAt < byDuration ? a.endsAt : byDuration;
  return a.endsAt ?? byDuration;
}

export interface ExamFields {
  examType: string;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number | null;
}

function parseDate(raw: unknown, name: string): Date {
  const d = new Date(String(raw ?? ''));
  if (!raw || Number.isNaN(d.getTime()))
    throw new BadRequestException(`${name} must be a valid date-time`);
  return d;
}

/**
 * Validate + normalise the exam-only fields from a request body (camel or
 * snake case). `prev` supplies current values for partial updates.
 */
export function parseExamFields(
  body: Record<string, unknown>,
  prev?: { [K in keyof ExamFields]?: ExamFields[K] | null } | null,
): ExamFields {
  const pick = (a: string, b: string) => body[a] ?? body[b];
  const examType = parseExamType(
    pick('examType', 'exam_type') ?? prev?.examType,
  );
  const startsAt = parseDate(
    pick('startsAt', 'starts_at') ?? prev?.startsAt,
    'startsAt',
  );
  const endsAt = parseDate(pick('endsAt', 'ends_at') ?? prev?.endsAt, 'endsAt');
  if (endsAt <= startsAt)
    throw new BadRequestException('endsAt must be after startsAt');
  const rawDur = pick('durationMinutes', 'duration_minutes');
  const dur =
    rawDur === undefined
      ? (prev?.durationMinutes ?? null)
      : rawDur === null || rawDur === ''
        ? null
        : Number(rawDur);
  if (dur !== null) {
    if (!Number.isInteger(dur) || dur <= 0)
      throw new BadRequestException(
        'durationMinutes must be a positive whole number',
      );
    if (dur * 60_000 > endsAt.getTime() - startsAt.getTime())
      throw new BadRequestException(
        'durationMinutes cannot exceed the exam window',
      );
  }
  return { examType, startsAt, endsAt, durationMinutes: dur };
}

export const LATE_POLICIES = ['allow', 'close'] as const;
export type DuePhase = 'open' | 'late' | 'closed';

export function parseLatePolicy(raw: unknown, fallback = 'allow'): string {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const v = String(raw).toLowerCase();
  if (!(LATE_POLICIES as readonly string[]).includes(v))
    throw new BadRequestException(
      `lateSubmissionPolicy must be one of ${LATE_POLICIES.join(', ')}`,
    );
  return v;
}

/** Due date is date-only (stored as UTC midnight): it runs to the end of that day in IST. */
export function dueClosesAt(dueDate: Date | null): Date | null {
  if (!dueDate) return null;
  return new Date(
    Date.UTC(
      dueDate.getUTCFullYear(),
      dueDate.getUTCMonth(),
      dueDate.getUTCDate(),
      18,
      29,
      59,
      999,
    ),
  );
}

/**
 * Moment submissions stop being accepted (DAILY/COURSE): end of the due day for
 * policy "close", end of the close day for "allow" + closeDate, else never.
 */
export function closeCutoff(a: {
  dueDate: Date | null;
  closeDate?: Date | null;
  lateSubmissionPolicy?: string | null;
}): Date | null {
  if (a.lateSubmissionPolicy === 'close') return dueClosesAt(a.dueDate);
  return dueClosesAt(a.closeDate ?? null);
}

/** Validate the close date against the due date + policy. Returns the value to store. */
export function resolveCloseDate(
  policy: string,
  dueDate: Date | null,
  closeRaw: unknown,
): Date | null {
  if (
    policy === 'close' ||
    closeRaw === undefined ||
    closeRaw === null ||
    closeRaw === ''
  )
    return null;
  const d = new Date(String(closeRaw));
  if (Number.isNaN(d.getTime()))
    throw new BadRequestException('closeDate must be a valid date');
  if (!dueDate)
    throw new BadRequestException('Set a due date before a close date');
  if (
    d.getTime() <
    Date.UTC(
      dueDate.getUTCFullYear(),
      dueDate.getUTCMonth(),
      dueDate.getUTCDate(),
    )
  )
    throw new BadRequestException('closeDate cannot be before the due date');
  return d;
}

/** DAILY/COURSE only. late = past due but still accepting; closed = past the cutoff. */
export function duePhase(
  a: {
    dueDate: Date | null;
    closeDate?: Date | null;
    lateSubmissionPolicy?: string | null;
    assignmentType?: string | null;
  },
  now = new Date(),
): DuePhase {
  if (a.assignmentType === 'EXAM') return 'open';
  const end = dueClosesAt(a.dueDate);
  if (!end || now <= end) return 'open';
  const cutoff = closeCutoff(a);
  return cutoff && now > cutoff ? 'closed' : 'late';
}
