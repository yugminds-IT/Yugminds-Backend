/**
 * Maps the raw 4-state TeacherReport.status ('submitted'/'reviewed'/
 * 'approved'/'rejected') to the UI status vocabulary shown to teachers and
 * school admins. Single source of truth — the teacher-facing "Recent
 * Reports" list and the school-admin "Teacher Reports" page used to have
 * independently hand-written copies of this mapping that disagreed: a
 * rejected report showed as "Flagged" to the teacher but "Rejected" to the
 * school admin, and a platform-admin-set 'reviewed' status rendered as the
 * raw lowercase string to the teacher instead of "Reviewed".
 */
export function toReportUiStatus(
  status?: string | null,
): 'Pending' | 'Reviewed' | 'Approved' | 'Rejected' {
  const v = String(status ?? 'submitted').toLowerCase();
  if (v === 'approved') return 'Approved';
  if (v === 'rejected') return 'Rejected';
  if (v === 'reviewed') return 'Reviewed';
  return 'Pending';
}
