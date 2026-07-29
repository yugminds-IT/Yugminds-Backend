export interface WorkingDaysHistoryEntry {
  effectiveFrom: Date;
  workingDays: number[];
}

/**
 * Resolves which working-days pattern was in effect for a teacher+school on
 * a specific date — the entry with the greatest `effectiveFrom <= date`.
 * A mid-month change (e.g. Mon-Thu -> Mon-Fri effective the 16th) means
 * every day before the 16th resolves to the old pattern and every day from
 * the 16th onward resolves to the new one, instead of one flat array
 * retroactively applying to the whole month.
 *
 * Returns `[]` if `date` predates every entry — the teacher-school
 * assignment simply didn't exist yet on that date. This is safe to treat as
 * authoritative (not a data gap to guess around) because
 * `AdminTeachersService` guarantees the earliest `effectiveFrom` for a given
 * (teacherId, schoolId) pair always equals that assignment's real start
 * date: it's set once when the assignment is first created, and later
 * schedule edits are rejected if they'd insert a row earlier than it. Do NOT
 * fall back to the earliest entry's pattern here — that would retroactively
 * apply a school's schedule to dates before the teacher was ever assigned
 * there (e.g. a brand-new second-school assignment showing up on every past
 * date in a calendar view).
 */
export function resolveWorkingDaysForDate(
  history: WorkingDaysHistoryEntry[],
  date: Date,
): number[] {
  let best: WorkingDaysHistoryEntry | null = null;
  for (const entry of history) {
    if (entry.effectiveFrom > date) continue;
    if (!best || entry.effectiveFrom > best.effectiveFrom) best = entry;
  }
  return best?.workingDays ?? [];
}
