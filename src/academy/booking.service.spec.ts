import { generateSlots, BOOKING_LEAD_MS } from './booking.service';

// Monday 2026-11-02 00:00 IST = 2026-11-01T18:30Z
const MON_MIDNIGHT_IST = Date.UTC(2026, 10, 1, 18, 30);
const ist = (dayOffset: number, hh: number, mm = 0) =>
  new Date(MON_MIDNIGHT_IST + dayOffset * 86_400_000 + (hh * 60 + mm) * 60_000);

describe('generateSlots', () => {
  const monday10to12 = [{ dayOfWeek: 1, startTime: '10:00', endTime: '12:00' }];
  // "now" = the Saturday before, 09:00 IST — far enough ahead of the 12h lead.
  const now = ist(-2, 9);

  it('cuts IST windows into fixed-length slots, in UTC', () => {
    const slots = generateSlots(monday10to12, [], 60, now);
    expect(slots.map((s) => s.toISOString()).slice(0, 2)).toEqual([
      '2026-11-02T04:30:00.000Z', // 10:00 IST
      '2026-11-02T05:30:00.000Z', // 11:00 IST
    ]);
  });

  it('drops slots that overlap a live booking (any length)', () => {
    const busy = [{ startsAt: ist(0, 10, 30), endsAt: ist(0, 11) }];
    const slots = generateSlots(monday10to12, busy, 60, now, 3);
    expect(slots.map((s) => s.getTime())).toEqual([ist(0, 11).getTime()]);
  });

  it('respects the booking lead time', () => {
    const justBefore = new Date(
      ist(0, 10).getTime() - BOOKING_LEAD_MS + 60_000,
    );
    const slots = generateSlots(monday10to12, [], 60, justBefore, 1);
    expect(slots.map((s) => s.getTime())).toEqual([ist(0, 11).getTime()]);
  });

  it('never emits a slot that runs past the window end', () => {
    const slots = generateSlots(monday10to12, [], 45, now, 3);
    // 10:00, 10:45 fit; 11:30 would end 12:15.
    expect(slots.map((s) => s.getTime())).toEqual([
      ist(0, 10).getTime(),
      ist(0, 10, 45).getTime(),
    ]);
  });
});
