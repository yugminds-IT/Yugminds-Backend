/** What a teacher can say they taught on a daily report. "Other" covers exams, invigilation, orientation and similar. */
export const TEACHING_SUBJECTS = [
  'Robotics',
  'Coding',
  'AI/ML',
  'Python',
] as const;
export const REPORT_SUBJECTS = [...TEACHING_SUBJECTS, 'Other'] as const;
