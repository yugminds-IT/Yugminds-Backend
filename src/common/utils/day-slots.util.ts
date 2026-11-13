/**
 * Half-day slots for teachers who split one weekday across two schools.
 * Stored as JSON on TeacherSchool / TeacherWorkingDaysHistory:
 *   { "1": { slot: "MORNING", start: "08:00", end: "12:30" } }
 * A weekday missing from the map is a FULL day, so every pre-existing row
 * keeps working untouched. Windows are per-assignment (each school has its
 * own period lengths), and only used to (a) stop two schools claiming the
 * same hours and (b) bound which class periods can be scheduled.
 */
export type SlotKind = 'MORNING' | 'AFTERNOON';
export type DaySlot = {
  slot: SlotKind;
  start: string; // HH:MM
  end: string; // HH:MM
};
export type DaySlots = Record<string, DaySlot>;

export const DEFAULT_SLOT_WINDOWS: Record<SlotKind, [string, string]> = {
  MORNING: ['08:00', '12:30'],
  AFTERNOON: ['12:30', '17:00'],
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Keeps only valid half-day entries for days in `workingDays`; fills default times. */
export function normalizeDaySlots(
  input: unknown,
  workingDays: number[],
): DaySlots | null {
  if (!input || typeof input !== 'object') return null;
  const out: DaySlots = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const day = Number(k);
    const e = v as Partial<DaySlot> | null;
    if (!workingDays.includes(day) || !e) continue;
    if (e.slot !== 'MORNING' && e.slot !== 'AFTERNOON') continue; // FULL = absent
    const [ds, de] = DEFAULT_SLOT_WINDOWS[e.slot];
    const start = e.start && HHMM.test(e.start) ? e.start : ds;
    const end = e.end && HHMM.test(e.end) ? e.end : de;
    if (start >= end) {
      throw new Error(`Slot end must be after start (weekday ${day})`);
    }
    out[String(day)] = { slot: e.slot, start, end };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 1 for a full day, 0.5 for a half-day slot. */
export function slotWeight(slots: unknown, day: number): number {
  return (slots as DaySlots | null)?.[String(day)] ? 0.5 : 1;
}

/** The [start,end] window a teacher is at the school on `day` (full day = whole day). */
export function slotWindow(slots: unknown, day: number): [string, string] {
  const s = (slots as DaySlots | null)?.[String(day)];
  return s ? [s.start, s.end] : ['00:00', '24:00'];
}

/** Stable comparison key used to detect "did the slots change". */
export function slotsKey(slots: unknown): string {
  const s = (slots as DaySlots | null) ?? {};
  return Object.keys(s)
    .sort()
    .map((d) => `${d}:${s[d].slot}:${s[d].start}-${s[d].end}`)
    .join('|');
}

export interface SlotAssignment {
  schoolId: string;
  workingDays: number[];
  daySlots: DaySlots | null;
  assignedFrom: Date | null;
  assignedUntil: Date | null;
}

const rangesOverlap = (a: SlotAssignment, b: SlotAssignment) =>
  (!a.assignedUntil || !b.assignedFrom || b.assignedFrom <= a.assignedUntil) &&
  (!b.assignedUntil || !a.assignedFrom || a.assignedFrom <= b.assignedUntil);

/**
 * First clash between two schools' assignments, or null. A clash is a shared
 * weekday (while both assignments are active) whose time windows overlap —
 * FULL+anything and MORNING+MORNING clash; MORNING+AFTERNOON don't.
 */
export function findSlotClash(
  a: SlotAssignment,
  b: SlotAssignment,
): { day: number; a: [string, string]; b: [string, string] } | null {
  if (!rangesOverlap(a, b)) return null;
  for (const day of a.workingDays) {
    if (!b.workingDays.includes(day)) continue;
    const wa = slotWindow(a.daySlots, day);
    const wb = slotWindow(b.daySlots, day);
    if (wa[0] < wb[1] && wb[0] < wa[1]) return { day, a: wa, b: wb };
  }
  return null;
}

const isHHMM = (t: string) => /^\d{2}:\d{2}$/.test(t);

/** True when the window is the whole day (a FULL-day teacher). */
export const isFullWindow = (w: [string, string]) =>
  w[0] === '00:00' && w[1] === '24:00';

/** Does a period (zero-padded HH:mm, the only stored form) sit fully inside the window? Non-standard times are not judged here; the write itself is rejected (400) by the DB layer. */
export function periodFitsWindow(
  start: string,
  end: string,
  window: [string, string],
): boolean {
  if (!isHHMM(start) || !isHHMM(end)) return true;
  return start >= window[0] && end <= window[1];
}

export interface ScheduledClass {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/**
 * Classes a teacher can no longer attend after their days/slots changed: on a
 * weekday they no longer work at the school, or outside that day's half-day
 * window. Used to warn (not block) when an assignment shrinks an existing
 * timetable.
 */
export function classesOutsideAvailability<T extends ScheduledClass>(
  classes: T[],
  workingDays: number[],
  slots: unknown,
): T[] {
  return classes.filter(
    (c) =>
      !workingDays.includes(c.dayOfWeek) ||
      !periodFitsWindow(c.startTime, c.endTime, slotWindow(slots, c.dayOfWeek)),
  );
}
