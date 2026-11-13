/**
 * Weighted attendance maths shared by the admin and teacher views. A working
 * day has weight 1, or 0.5 for a half-day slot (teacher split across two
 * schools). Per-school weights on the same date are summed and capped at 1,
 * so MORNING(A)+AFTERNOON(B) = one full day, and legacy overlapping FULL
 * days still count once.
 */
export type WeightMap = Map<string, number>; // YYYY-MM-DD -> weight

export function combineWeights(maps: Iterable<WeightMap>): WeightMap {
  const out: WeightMap = new Map();
  for (const m of maps)
    for (const [d, w] of m) out.set(d, Math.min(1, (out.get(d) ?? 0) + w));
  return out;
}

/** Credit earned per date from Present rows — each school's half counts only if THAT school's report landed. */
export function presentCreditByDate(
  records: Array<{ schoolId: string; date: Date; status: string }>,
  weightsBySchool: Map<string, WeightMap>,
): WeightMap {
  const out: WeightMap = new Map();
  for (const r of records) {
    if (r.status !== 'Present') continue;
    const d = r.date.toISOString().split('T')[0];
    const w = weightsBySchool.get(r.schoolId)?.get(d) ?? 1;
    out.set(d, (out.get(d) ?? 0) + w);
  }
  return out;
}

export function weightedMetrics(o: {
  weights: WeightMap; // combined scheduled weight per working date
  presentCredit: WeightMap;
  explicitAbsent: Set<string>;
  leaveDates: Set<string>;
  reportedDates: Set<string>;
  todayStr: string;
}) {
  let present = 0,
    absent = 0,
    leave = 0,
    unreported = 0,
    late = 0,
    total = 0;
  for (const [d, w] of o.weights) {
    total += w;
    const p = Math.min(w, o.presentCredit.get(d) ?? 0);
    present += p;
    const rem = w - p;
    if (rem <= 0) continue;
    if (o.leaveDates.has(d)) leave += rem;
    else if (o.explicitAbsent.has(d) || d < o.todayStr) {
      absent += rem;
      if (o.reportedDates.has(d)) late += rem;
    } else unreported += rem;
  }
  return {
    present_days: present,
    absent_days: absent,
    leave_days: leave,
    unreported_days: unreported,
    late_report_days: late,
    total_working_days: total,
    attendance_percentage: total > 0 ? Math.round((present / total) * 100) : 0,
  };
}
