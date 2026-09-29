export interface RetakeSettings {
  retakeEnabled: boolean | null;
  maxRetakeAttempts: number | null;
  retakeAccessScope: string | null;
  retakeWindowOpen: boolean | null;
}

/**
 * Whether a student may start another attempt. The single rule shared by the
 * submit guard, the detail endpoint's Retake button and the assignments list,
 * so what the UI offers always matches what submit accepts.
 * `maxRetakeAttempts` counts retakes, so total attempts = max + 1; null = unlimited.
 *
 * An active personal grant is exactly one extra attempt for that student
 * (consumed on submit), independent of the class-wide settings — otherwise
 * granting one student had to switch retakes on for the whole class.
 */
export function canRetakeAssignment(
  a: RetakeSettings,
  attemptsCount: number,
  grantActive: boolean,
): boolean {
  if (grantActive) return true;
  if (!a.retakeEnabled) return false;
  if ((a.retakeAccessScope ?? 'all') !== 'all') return false;
  const hasCapacity =
    a.maxRetakeAttempts == null || attemptsCount < a.maxRetakeAttempts + 1;
  // Window only matters for fixed-attempt assignments; unlimited ones stay open.
  const allowedByWindow = a.maxRetakeAttempts === null || !!a.retakeWindowOpen;
  return hasCapacity && allowedByWindow;
}
