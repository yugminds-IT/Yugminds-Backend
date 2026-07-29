/**
 * Today's calendar date in IST, as a UTC-midnight-anchored Date — matches the
 * `dateStr + 'T00:00:00.000Z'` convention every Attendance/SchoolCalendar row
 * is keyed by. Schools operate on the IST calendar day; raw `new Date()` at
 * UTC midnight is wrong for ~5.5 hours every day (just after midnight IST,
 * UTC's calendar day hasn't turned over yet). No timezone library needed —
 * `Intl.DateTimeFormat('en-CA', ...)` already returns YYYY-MM-DD.
 */
export function getTodayIstDateOnly(): Date {
  return new Date(`${getTodayIstDateStr()}T00:00:00.000Z`);
}

/** Same as {@link getTodayIstDateOnly} but as a `YYYY-MM-DD` string. */
export function getTodayIstDateStr(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
