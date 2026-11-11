/** What a teacher can say they taught on a daily report. "Other" covers exams, invigilation, orientation and similar. */
export const TEACHING_SUBJECTS = [
  'Robotics',
  'Coding',
  'AI/ML',
  'Python',
] as const;
export const REPORT_SUBJECTS = [...TEACHING_SUBJECTS, 'Other'] as const;

const MAX_LENGTH = 60;

/**
 * The subject to store: the canonical spelling for a known one ("coding" becomes "Coding"), otherwise the
 * trimmed text, so a school's own timetable subject still works. Empty, non-text or too long gives null.
 */
export function normalizeSubject(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > MAX_LENGTH) return null;
  return (
    REPORT_SUBJECTS.find((s) => s.toLowerCase() === text.toLowerCase()) ?? text
  );
}
