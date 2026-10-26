import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AcademyBookingStatus, AcademyRole } from '@prisma/client';
import { DatabaseService } from '../database/database.service';
import { AcademyAuthService } from './academy-auth.service';
import type {
  AvailabilityWindowDto,
  CreateTutorDto,
  TutorProfileDto,
  UpdateBookingDto,
} from './academy.dto';

// India has no DST, so IST is a fixed offset. ponytail: single timezone; store a
// tz per tutor and use Intl if tutors outside India are ever added.
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
export const BOOKING_LEAD_MS = 12 * 3_600_000; // earliest bookable: 12h from now
export const BOOKING_HORIZON_DAYS = 14;
export const FREE_CANCEL_MS = 24 * 3_600_000;
const LIVE: AcademyBookingStatus[] = ['CONFIRMED', 'COMPLETED', 'NO_SHOW'];

type Window = { dayOfWeek: number; startTime: string; endTime: string };
type Busy = { startsAt: Date; endsAt: Date };

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Bookable session starts (UTC) for one tutor: weekly IST windows cut into
 * `minutes`-long slots, minus anything overlapping a live booking, inside
 * [now + lead, now + horizon].
 */
export function generateSlots(
  windows: Window[],
  busy: Busy[],
  minutes: number,
  now: Date,
  horizonDays = BOOKING_HORIZON_DAYS,
): Date[] {
  const earliest = now.getTime() + BOOKING_LEAD_MS;
  const latest = now.getTime() + horizonDays * DAY_MS;
  // Midnight IST of "today", expressed in UTC ms.
  const istMidnight =
    Math.floor((now.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS -
    IST_OFFSET_MS;
  const slots: Date[] = [];
  for (let d = 0; d <= horizonDays; d++) {
    const dayStart = istMidnight + d * DAY_MS;
    const weekday = new Date(dayStart + IST_OFFSET_MS).getUTCDay();
    for (const w of windows) {
      if (w.dayOfWeek !== weekday) continue;
      const end = minutesOf(w.endTime);
      for (let m = minutesOf(w.startTime); m + minutes <= end; m += minutes) {
        const start = dayStart + m * 60_000;
        const stop = start + minutes * 60_000;
        if (start < earliest || start > latest) continue;
        const clash = busy.some(
          (b) => b.startsAt.getTime() < stop && b.endsAt.getTime() > start,
        );
        if (!clash) slots.push(new Date(start));
      }
    }
  }
  return slots.sort((a, b) => a.getTime() - b.getTime());
}

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AcademyAuthService,
  ) {}

  // ─── Public ──────────────────────────────────────────────────────────────

  async listTutors() {
    const tutors = await this.db.academyTutorProfile.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        accountId: true,
        headline: true,
        bio: true,
        subjects: true,
        photoUrl: true,
      },
    });
    const names = await this.namesOf(tutors.map((t) => t.accountId));
    return tutors.map(({ accountId, ...t }) => ({
      ...t,
      name: names.get(accountId) ?? 'Tutor',
    }));
  }

  async getTutor(id: string) {
    const tutor = (await this.listTutors()).find((t) => t.id === id);
    if (!tutor) throw new NotFoundException('Tutor not found');
    return tutor;
  }

  async slots(tutorProfileId: string, minutes: number) {
    const tutor = await this.db.academyTutorProfile.findFirst({
      where: { id: tutorProfileId, isActive: true },
      include: { availability: true },
    });
    if (!tutor) throw new NotFoundException('Tutor not found');
    const now = new Date();
    const busy = await this.db.academyBooking.findMany({
      where: {
        tutorId: tutor.accountId,
        status: { in: LIVE },
        endsAt: { gt: now },
        startsAt: {
          lt: new Date(now.getTime() + (BOOKING_HORIZON_DAYS + 1) * DAY_MS),
        },
      },
      select: { startsAt: true, endsAt: true },
    });
    return generateSlots(tutor.availability, busy, minutes, now);
  }

  // ─── Learner ─────────────────────────────────────────────────────────────

  async myCredits(learnerId: string) {
    const credits = await this.db.academySessionCredit.findMany({
      where: { learnerId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, total: true, used: true, minutes: true },
    });
    return credits.map((c) => ({
      ...c,
      remaining: Math.max(c.total - c.used, 0),
    }));
  }

  async myBookings(learnerId: string) {
    const rows = await this.db.academyBooking.findMany({
      where: { learnerId },
      orderBy: { startsAt: 'desc' },
      take: 100,
    });
    const names = await this.namesOf(rows.map((r) => r.tutorId));
    return rows.map(({ tutorNotes: _private, ...b }) => ({
      ...b,
      tutorName: names.get(b.tutorId) ?? 'Tutor',
    }));
  }

  async book(learnerId: string, tutorProfileId: string, startsAtIso: string) {
    const startsAt = new Date(startsAtIso);
    const credit = (await this.myCredits(learnerId)).find(
      (c) => c.remaining > 0,
    );
    if (!credit)
      throw new BadRequestException(
        'No class credits left — buy a class pack first',
      );

    const tutor = await this.db.academyTutorProfile.findFirst({
      where: { id: tutorProfileId, isActive: true },
    });
    if (!tutor) throw new NotFoundException('Tutor not found');
    const open = await this.slots(tutorProfileId, credit.minutes);
    if (!open.some((s) => s.getTime() === startsAt.getTime())) {
      throw new BadRequestException('That slot is no longer available');
    }
    const endsAt = new Date(startsAt.getTime() + credit.minutes * 60_000);

    try {
      return await this.db.$transaction(async (tx) => {
        const took = await tx.$executeRaw`
          UPDATE "AcademySessionCredit" SET "used" = "used" + 1
          WHERE "id" = ${credit.id} AND "used" < "total"`;
        if (took === 0) throw new BadRequestException('No class credits left');
        // ponytail: overlap re-check + the partial unique index on (tutor, start) cover
        // same-start races; mixed-length overlapping races need an exclusion constraint.
        const clash = await tx.academyBooking.findFirst({
          where: {
            tutorId: tutor.accountId,
            status: { in: LIVE },
            startsAt: { lt: endsAt },
            endsAt: { gt: startsAt },
          },
        });
        if (clash) throw new BadRequestException('That slot was just booked');
        return tx.academyBooking.create({
          data: {
            tutorId: tutor.accountId,
            learnerId,
            creditId: credit.id,
            startsAt,
            endsAt,
            meetingLink: tutor.defaultMeetingLink,
          },
        });
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002')
        throw new BadRequestException('That slot was just booked');
      throw e;
    }
  }

  /**
   * Learners get the credit back when cancelling ≥24h ahead; a tutor or admin
   * cancelling always returns it.
   */
  async cancel(
    actor: { id: string; as: 'learner' | 'tutor' | 'admin' },
    bookingId: string,
  ) {
    const b = await this.db.academyBooking.findUnique({
      where: { id: bookingId },
    });
    if (!b) throw new NotFoundException('Booking not found');
    if (actor.as === 'learner' && b.learnerId !== actor.id)
      throw new NotFoundException('Booking not found');
    if (actor.as === 'tutor' && b.tutorId !== actor.id)
      throw new NotFoundException('Booking not found');
    if (b.status !== 'CONFIRMED')
      throw new BadRequestException('Only upcoming classes can be cancelled');
    if (b.startsAt.getTime() <= Date.now())
      throw new BadRequestException('This class has already started');

    const refund =
      actor.as !== 'learner' ||
      b.startsAt.getTime() - Date.now() >= FREE_CANCEL_MS;
    await this.db.$transaction(async (tx) => {
      const done = await tx.academyBooking.updateMany({
        where: { id: b.id, status: 'CONFIRMED' },
        data: { status: 'CANCELLED', cancelledBy: actor.id },
      });
      if (done.count && refund) {
        await tx.$executeRaw`UPDATE "AcademySessionCredit" SET "used" = GREATEST("used" - 1, 0) WHERE "id" = ${b.creditId}`;
      }
    });
    return { ok: true, creditReturned: refund };
  }

  // ─── Tutor ───────────────────────────────────────────────────────────────

  /** Tutor endpoints need an admin-created, active profile. */
  async requireTutor(accountId: string) {
    const t = await this.db.academyTutorProfile.findUnique({
      where: { accountId },
      include: { availability: true },
    });
    if (!t || !t.isActive)
      throw new ForbiddenException('Not an active Academy tutor');
    return t;
  }

  async setAvailability(accountId: string, windows: AvailabilityWindowDto[]) {
    const tutor = await this.requireTutor(accountId);
    for (const w of windows) {
      if (minutesOf(w.startTime) >= minutesOf(w.endTime)) {
        throw new BadRequestException(
          'Each time range must end after it starts',
        );
      }
    }
    await this.db.$transaction([
      this.db.academyTutorAvailability.deleteMany({
        where: { tutorId: tutor.id },
      }),
      this.db.academyTutorAvailability.createMany({
        data: windows.map(({ dayOfWeek, startTime, endTime }) => ({
          tutorId: tutor.id,
          dayOfWeek,
          startTime,
          endTime,
        })),
      }),
    ]);
    return (await this.requireTutor(accountId)).availability;
  }

  async updateOwnProfile(accountId: string, dto: TutorProfileDto) {
    const tutor = await this.requireTutor(accountId);
    const { isActive: _adminOnly, ...data } = dto;
    return this.db.academyTutorProfile.update({
      where: { id: tutor.id },
      data,
    });
  }

  async tutorBookings(
    tutorId: string,
    scope: 'upcoming' | 'past' | 'all' = 'upcoming',
  ) {
    const now = new Date();
    const rows = await this.db.academyBooking.findMany({
      where: {
        tutorId,
        ...(scope === 'upcoming'
          ? { endsAt: { gte: now }, status: 'CONFIRMED' }
          : {}),
        ...(scope === 'past'
          ? { OR: [{ endsAt: { lt: now } }, { status: { not: 'CONFIRMED' } }] }
          : {}),
      },
      orderBy: { startsAt: scope === 'upcoming' ? 'asc' : 'desc' },
      take: 200,
    });
    return this.withLearners(rows);
  }

  async updateBooking(
    tutorId: string,
    bookingId: string,
    dto: UpdateBookingDto,
  ) {
    const b = await this.db.academyBooking.findUnique({
      where: { id: bookingId },
    });
    if (!b || b.tutorId !== tutorId)
      throw new NotFoundException('Booking not found');
    if (dto.status === 'CANCELLED')
      throw new BadRequestException('Use cancel to cancel a class');
    if (
      dto.status &&
      dto.status !== 'CONFIRMED' &&
      b.startsAt.getTime() > Date.now()
    ) {
      throw new BadRequestException(
        'A class can be marked done only after it starts',
      );
    }
    return this.db.academyBooking.update({ where: { id: b.id }, data: dto });
  }

  // ─── Admin ───────────────────────────────────────────────────────────────

  async adminTutors() {
    const tutors = await this.db.academyTutorProfile.findMany({
      orderBy: { createdAt: 'asc' },
      include: { availability: true },
    });
    const accounts = await this.db.academyAccount.findMany({
      where: { id: { in: tutors.map((t) => t.accountId) } },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        isActive: true,
      },
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return tutors.map((t) => ({
      ...t,
      account: byId.get(t.accountId) ?? null,
    }));
  }

  /** New tutor = TUTOR account + profile. Returns a one-time password. */
  async createTutor(dto: CreateTutorDto) {
    const { fullName, email, phone, ...profile } = dto;
    const { account, tempPassword } = await this.auth.createAccount({
      email,
      fullName,
      phone,
      role: AcademyRole.TUTOR,
    });
    await this.db.academyTutorProfile.create({
      data: { accountId: account.id, ...profile },
    });
    return { accountId: account.id, email: account.email, tempPassword };
  }

  adminUpdateTutor(id: string, dto: TutorProfileDto) {
    return this.db.academyTutorProfile.update({ where: { id }, data: dto });
  }

  async adminBookings(from?: string, to?: string) {
    const rows = await this.db.academyBooking.findMany({
      where: {
        startsAt: {
          gte: from ? new Date(from) : new Date(Date.now() - 7 * DAY_MS),
          ...(to ? { lt: new Date(to) } : {}),
        },
      },
      orderBy: { startsAt: 'asc' },
      take: 500,
    });
    const [withLearners, tutors] = await Promise.all([
      this.withLearners(rows),
      this.namesOf(rows.map((r) => r.tutorId)),
    ]);
    return withLearners.map((b) => ({
      ...b,
      tutorName: tutors.get(b.tutorId) ?? 'Tutor',
    }));
  }

  /** Classes that ended without the tutor marking them get closed automatically. */
  @Cron('*/15 * * * *')
  async closeFinishedClasses() {
    try {
      await this.db.academyBooking.updateMany({
        where: {
          status: 'CONFIRMED',
          endsAt: { lt: new Date(Date.now() - 30 * 60_000) },
        },
        data: { status: 'COMPLETED' },
      });
    } catch (e) {
      this.logger.warn(`Academy booking cleanup failed: ${String(e)}`);
    }
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  private async namesOf(accountIds: string[]) {
    const accounts = await this.db.academyAccount.findMany({
      where: { id: { in: [...new Set(accountIds)] } },
      select: { id: true, fullName: true },
    });
    return new Map(accounts.map((a) => [a.id, a.fullName]));
  }

  private async withLearners<T extends { learnerId: string }>(rows: T[]) {
    const learners = await this.db.academyAccount.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.learnerId))] } },
      select: { id: true, fullName: true, phone: true, parentName: true },
    });
    const byId = new Map(learners.map((l) => [l.id, l]));
    return rows.map((r) => ({ ...r, learner: byId.get(r.learnerId) ?? null }));
  }
}
