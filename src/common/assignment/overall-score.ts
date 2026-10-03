/**
 * Overall = course 60% + daily 40%. When a student only has graded work of
 * one kind, overall is that score alone — otherwise a school without course
 * assignments caps every student at 40% (and no one can earn a badge).
 * Pass `null` for a component with no graded work.
 */
export function overallScore(
  coursePercent: number | null,
  dailyPercent: number | null,
): number {
  let overall: number;
  if (coursePercent != null && dailyPercent != null) {
    overall = coursePercent * 0.6 + dailyPercent * 0.4;
  } else {
    overall = coursePercent ?? dailyPercent ?? 0;
  }
  return Number(overall.toFixed(2));
}
