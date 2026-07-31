/**
 * Dedupe/sort/clamp a raw day-of-week array to 0-6 (0=Sun..6=Sat); falls
 * back to the given default when absent, invalid, or empty. Shared between
 * TeacherSchool.workingDays (AdminTeachersService) and School.operatingDays
 * (AdminSchoolsService) so both use the exact same normalization rules.
 */
export function normalizeWeekdays(input: unknown, fallback: number[]): number[] {
  if (!Array.isArray(input)) return fallback;
  const days = [
    ...new Set(
      input
        .map((d) => Number(d))
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    ),
  ].sort((a, b) => a - b);
  return days.length > 0 ? days : fallback;
}

/** Weekday names for 0=Sun..6=Sat, used in cross-validation error messages. */
export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** Default School.operatingDays when unset: all days except Sunday. */
export const DEFAULT_OPERATING_DAYS = [1, 2, 3, 4, 5, 6];
