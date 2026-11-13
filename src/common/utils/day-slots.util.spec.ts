import {
  classesOutsideAvailability,
  periodFitsWindow,
  findSlotClash,
  normalizeDaySlots,
  slotWeight,
  SlotAssignment,
} from './day-slots.util';

const asg = (
  schoolId: string,
  workingDays: number[],
  daySlots: SlotAssignment['daySlots'] = null,
): SlotAssignment => ({
  schoolId,
  workingDays,
  daySlots,
  assignedFrom: null,
  assignedUntil: null,
});

describe('day slots', () => {
  it('fills default times and drops FULL / off-day entries', () => {
    const s = normalizeDaySlots(
      { 1: { slot: 'MORNING' }, 2: { slot: 'FULL' }, 6: { slot: 'MORNING' } },
      [1, 2],
    );
    expect(s).toEqual({
      '1': { slot: 'MORNING', start: '08:00', end: '12:30' },
    });
  });

  it('weights half slots at 0.5 and full days at 1', () => {
    const s = normalizeDaySlots({ 1: { slot: 'AFTERNOON' } }, [1, 2]);
    expect(slotWeight(s, 1)).toBe(0.5);
    expect(slotWeight(s, 2)).toBe(1);
  });

  it('allows MORNING + AFTERNOON on the same day, even with different period lengths', () => {
    const m = normalizeDaySlots({ 1: { slot: 'MORNING' } }, [1]);
    const a = normalizeDaySlots({ 1: { slot: 'AFTERNOON' } }, [1]);
    expect(findSlotClash(asg('A', [1], m), asg('B', [1], a))).toBeNull();
  });

  it('rejects FULL+FULL, FULL+half and MORNING+MORNING on a shared day', () => {
    const m = normalizeDaySlots({ 1: { slot: 'MORNING' } }, [1]);
    expect(findSlotClash(asg('A', [1]), asg('B', [1]))).not.toBeNull();
    expect(findSlotClash(asg('A', [1]), asg('B', [1], m))).not.toBeNull();
    expect(findSlotClash(asg('A', [1], m), asg('B', [1], m))).not.toBeNull();
  });

  it('ignores different weekdays and non-overlapping assignment dates', () => {
    expect(findSlotClash(asg('A', [1]), asg('B', [2]))).toBeNull();
    const a = { ...asg('A', [1]), assignedUntil: new Date('2026-01-31') };
    const b = { ...asg('B', [1]), assignedFrom: new Date('2026-02-01') };
    expect(findSlotClash(a, b)).toBeNull();
  });
});

describe('period windows', () => {
  const am: [string, string] = ['08:00', '12:30'];
  it('fits inside, and exactly on the edges', () => {
    expect(periodFitsWindow('09:00', '09:45', am)).toBe(true);
    expect(periodFitsWindow('08:00', '12:30', am)).toBe(true);
  });
  it('rejects a period outside or straddling the window', () => {
    expect(periodFitsWindow('13:15', '14:00', am)).toBe(false);
    expect(periodFitsWindow('12:10', '12:50', am)).toBe(false);
  });
  it('does not judge non-standard times (the write is rejected elsewhere)', () => {
    expect(periodFitsWindow('9:00', '9:40', am)).toBe(true);
    expect(periodFitsWindow('9:00 AM', '9:45 AM', am)).toBe(true);
  });
  it('flags classes on a dropped weekday or outside the half-day window', () => {
    const slots = normalizeDaySlots({ 4: { slot: 'MORNING' } }, [1, 4]);
    const classes = [
      { dayOfWeek: 1, startTime: '09:00', endTime: '09:45' }, // fine (full day Mon)
      { dayOfWeek: 4, startTime: '09:00', endTime: '09:45' }, // fine (Thu AM)
      { dayOfWeek: 4, startTime: '14:00', endTime: '14:40' }, // outside Thu AM
      { dayOfWeek: 5, startTime: '09:00', endTime: '09:45' }, // Friday no longer worked
    ];
    expect(classesOutsideAvailability(classes, [1, 4], slots)).toEqual([
      classes[2],
      classes[3],
    ]);
  });
});
