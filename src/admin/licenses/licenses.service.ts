import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import {
  generateActivationNumber,
  readActivationNumber,
  getLicenseSecret,
  getBuildLicenseNumber,
} from './license-crypto';

interface GenerateBody {
  schoolId?: string;
  systemLabel?: string;
  machineId?: string;
  durationDays?: number;
  startDate?: string; // optional YYYY-MM-DD; defaults to today (UTC)
  notes?: string | null;
}

interface ImportBody {
  schoolId?: string;
  systemLabel?: string;
  machineId?: string; // optional — if given, must match the key it is imported with
  activationKey?: string;
  notes?: string | null;
}

interface UpdateBody {
  systemLabel?: string;
  machineId?: string;
  durationDays?: number;
  startDate?: string;
  notes?: string | null;
  isActive?: boolean;
  regenerate?: boolean;
}

type LicenseRow = {
  id: string;
  schoolId: string;
  systemLabel: string;
  machineId: string;
  licenseNumber: number;
  startDate: Date;
  expiryDate: Date;
  durationDays: number;
  activationKey: string;
  notes: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const DAY_MS = 86400000;

@Injectable()
export class AdminLicensesService {
  constructor(private readonly db: DatabaseService) {}

  /** UTC midnight for "today" so the encoded day index matches the desktop app. */
  private todayUtc(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  private toIsoDate(d: Date): string {
    return d.toISOString().split('T')[0];
  }

  /**
   * Whole days from today through expiry, inclusive (today == expiry -> 1,
   * not 0 — today is still a valid day). Computed entirely from UTC-midnight
   * values so it never disagrees with `is_expired`/`not_yet_active`, which
   * use the same clock — mixing in wall-clock `Date.now()` here previously
   * made "days remaining" hit 0 on the expiry day while `is_expired` still
   * (correctly) read false.
   */
  private daysRemainingInclusive(expiryMs: number, todayMs: number): number {
    return Math.max(0, Math.round((expiryMs - todayMs) / DAY_MS) + 1);
  }

  private serialize(row: LicenseRow) {
    const expiryMs = row.expiryDate.getTime();
    const todayMs = this.todayUtc().getTime();
    const daysRemaining = this.daysRemainingInclusive(expiryMs, todayMs);
    const buildNumber = getBuildLicenseNumber();
    return {
      id: row.id,
      school_id: row.schoolId,
      system_label: row.systemLabel,
      machine_id: row.machineId,
      license_number: row.licenseNumber,
      // The desktop app rejects any key whose license number differs from the build it
      // ships with. Flag mismatches so the UI can warn that the key won't activate.
      expected_license_number: buildNumber,
      key_build_mismatch: row.licenseNumber !== buildNumber,
      start_date: this.toIsoDate(row.startDate),
      expiry_date: this.toIsoDate(row.expiryDate),
      duration_days: row.durationDays,
      activation_key: row.activationKey,
      notes: row.notes,
      is_active: row.isActive,
      days_remaining: daysRemaining,
      is_expired: todayMs > expiryMs,
      not_yet_active: todayMs < row.startDate.getTime(),
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  async list(opts: { schoolId?: string; status?: string; search?: string } = {}) {
    const { schoolId, status, search } = opts;
    const where: Record<string, unknown> = {};
    if (schoolId) where.schoolId = schoolId;

    const today = this.todayUtc();
    if (status === 'active') {
      where.isActive = true;
      where.startDate = { lte: today };
      where.expiryDate = { gte: today };
    } else if (status === 'expired') {
      where.expiryDate = { lt: today };
    } else if (status === 'pending') {
      where.startDate = { gt: today };
    } else if (status === 'inactive') {
      where.isActive = false;
    }

    const q = (search ?? '').trim();
    if (q) {
      where.OR = [
        { systemLabel: { contains: q, mode: 'insensitive' } },
        { machineId: { contains: q, mode: 'insensitive' } },
        { activationKey: { contains: q, mode: 'insensitive' } },
      ];
    }

    const rows = (await this.db.robocodersLicense.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })) as LicenseRow[];
    return { licenses: rows.map((r) => this.serialize(r)) };
  }

  private async validateSchool(id: string) {
    const school = await this.db.school.findUnique({ where: { id } });
    if (school) return school;
    const tenant = await this.db.tenant.findUnique({ where: { id } });
    if (!tenant) return null;
    return this.db.school.findUnique({ where: { id: tenant.id } });
  }

  private normalizeMachineId(raw: unknown): string {
    const id = String(raw ?? '').trim().toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(id)) {
      throw new BadRequestException(
        'Machine ID must be exactly 16 hex characters (copy it from the desktop app)',
      );
    }
    return id;
  }

  private normalizeDays(raw: unknown): number {
    const days = Math.floor(Number(raw));
    if (!Number.isFinite(days) || days < 1 || days > 20000) {
      throw new BadRequestException('Number of days must be an integer between 1 and 20000');
    }
    return days;
  }

  async generate(body: GenerateBody) {
    const schoolId = String(body.schoolId ?? '').trim();
    const systemLabel = String(body.systemLabel ?? '').trim();
    if (!schoolId) throw new BadRequestException('schoolId is required');
    if (!systemLabel) throw new BadRequestException('systemLabel is required');

    const school = await this.validateSchool(schoolId);
    if (!school) throw new BadRequestException('School not found for given id');

    const machineId = this.normalizeMachineId(body.machineId);
    const durationDays = this.normalizeDays(body.durationDays);

    const start = body.startDate
      ? new Date(Date.parse(body.startDate + 'T00:00:00Z'))
      : this.todayUtc();
    if (Number.isNaN(start.getTime())) {
      throw new BadRequestException('Invalid start date');
    }
    // Expiry is inclusive of the start day, so N days => start + (N-1).
    const expiry = new Date(start.getTime() + (durationDays - 1) * DAY_MS);

    // Without this, an admin can end up with several active license rows for
    // the same physical machine — confusing in the table and wasteful, since
    // only one activation key is ever entered on that machine anyway.
    const existingActive = (await this.db.robocodersLicense.findFirst({
      where: {
        schoolId,
        machineId,
        isActive: true,
        expiryDate: { gte: this.todayUtc() },
      },
    })) as LicenseRow | null;
    if (existingActive) {
      throw new BadRequestException(
        `This machine already has an active license ("${existingActive.systemLabel}", expires ${this.toIsoDate(existingActive.expiryDate)}). Edit that license instead of generating a new one.`,
      );
    }

    const licenseNumber = getBuildLicenseNumber();

    let activationKey: string;
    try {
      activationKey = generateActivationNumber({
        machineId,
        startDate: this.toIsoDate(start),
        expiryDate: this.toIsoDate(expiry),
        licenseNumber,
        secret: getLicenseSecret(),
      });
    } catch (e) {
      throw new BadRequestException('Failed to generate key: ' + (e as Error).message);
    }

    const row = (await this.db.robocodersLicense.create({
      data: {
        schoolId,
        systemLabel,
        machineId,
        licenseNumber,
        startDate: start,
        expiryDate: expiry,
        durationDays,
        activationKey,
        notes: body.notes ? String(body.notes) : null,
        isActive: true,
      },
    })) as LicenseRow;

    return { license: this.serialize(row) };
  }

  /** Canonical grouped form of a pasted key (strip spaces/dashes, upper-case, regroup in 7s). */
  private canonicalKey(raw: string): string {
    const clean = raw.replace(/[\s-]/g, '').toUpperCase();
    return clean.match(/.{1,7}/g)?.join('-') ?? clean;
  }

  /**
   * Import a license that was generated previously (e.g. via the admin portal) so it
   * appears in the table. The activation key is the source of truth: we decode + verify
   * it and derive the machine ID, dates and license number from it — the key itself is
   * stored verbatim and is NEVER regenerated.
   */
  async import(body: ImportBody) {
    const schoolId = String(body.schoolId ?? '').trim();
    const systemLabel = String(body.systemLabel ?? '').trim();
    const activationKey = String(body.activationKey ?? '').trim();
    if (!schoolId) throw new BadRequestException('schoolId is required');
    if (!systemLabel) throw new BadRequestException('systemLabel is required');
    if (!activationKey) throw new BadRequestException('activationKey is required');

    const school = await this.validateSchool(schoolId);
    if (!school) throw new BadRequestException('School not found for given id');

    const decoded = readActivationNumber(activationKey, getLicenseSecret());
    if (!decoded.valid) {
      throw new BadRequestException(
        'Activation key is invalid: ' + (decoded.reason ?? 'unknown reason'),
      );
    }

    // The key only carries the first 3 bytes (6 hex chars) of the machine ID, so it
    // cannot recover the full 16-char ID on its own. Require the admin to supply the
    // full machine ID (matching how generated licenses store it) and verify that its
    // 6-char prefix matches the one baked into the key.
    const machineId = this.normalizeMachineId(body.machineId);
    if (machineId.slice(0, 6) !== decoded.machineId) {
      throw new BadRequestException(
        `Machine ID does not match this key — the key is bound to a machine whose ID starts with ${decoded.machineId}`,
      );
    }

    const canonical = this.canonicalKey(activationKey);

    // Avoid importing the exact same key twice for a school.
    const dup = await this.db.robocodersLicense.findFirst({
      where: { schoolId, activationKey: canonical },
    });
    if (dup) {
      throw new BadRequestException('This activation key is already stored for this school');
    }

    const start = new Date(Date.parse(decoded.startDate! + 'T00:00:00Z'));
    const expiry = new Date(Date.parse(decoded.expiryDate! + 'T00:00:00Z'));
    const durationDays = Math.round((expiry.getTime() - start.getTime()) / DAY_MS) + 1;

    const row = (await this.db.robocodersLicense.create({
      data: {
        schoolId,
        systemLabel,
        machineId,
        licenseNumber: decoded.licenseNumber!,
        startDate: start,
        expiryDate: expiry,
        durationDays,
        activationKey: canonical,
        notes: body.notes ? String(body.notes) : null,
        isActive: true,
      },
    })) as LicenseRow;

    return { license: this.serialize(row) };
  }

  async update(id: string, body: UpdateBody) {
    if (!id) throw new BadRequestException('id is required');
    const existing = (await this.db.robocodersLicense.findUnique({
      where: { id },
    })) as LicenseRow | null;
    if (!existing) throw new NotFoundException('License not found');

    const data: Record<string, unknown> = {};
    if (body.systemLabel !== undefined) {
      const label = String(body.systemLabel).trim();
      if (!label) throw new BadRequestException('systemLabel cannot be empty');
      data.systemLabel = label;
    }
    if (body.notes !== undefined) data.notes = body.notes ? String(body.notes) : null;
    if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);

    // Any change to machine id / duration / start date (or an explicit regenerate)
    // re-issues the activation key, because all three are baked into the key.
    const machineId =
      body.machineId !== undefined
        ? this.normalizeMachineId(body.machineId)
        : existing.machineId;
    const durationDays =
      body.durationDays !== undefined
        ? this.normalizeDays(body.durationDays)
        : existing.durationDays;
    const start =
      body.startDate !== undefined
        ? new Date(Date.parse(body.startDate + 'T00:00:00Z'))
        : existing.startDate;
    if (Number.isNaN(start.getTime())) {
      throw new BadRequestException('Invalid start date');
    }

    const keyAffectingChange =
      body.machineId !== undefined ||
      body.durationDays !== undefined ||
      body.startDate !== undefined ||
      body.regenerate === true;

    if (keyAffectingChange) {
      const expiry = new Date(start.getTime() + (durationDays - 1) * DAY_MS);
      let activationKey: string;
      try {
        activationKey = generateActivationNumber({
          machineId,
          startDate: this.toIsoDate(start),
          expiryDate: this.toIsoDate(expiry),
          licenseNumber: getBuildLicenseNumber(),
          secret: getLicenseSecret(),
        });
      } catch (e) {
        throw new BadRequestException('Failed to regenerate key: ' + (e as Error).message);
      }
      data.machineId = machineId;
      data.durationDays = durationDays;
      data.startDate = start;
      data.expiryDate = expiry;
      data.activationKey = activationKey;
      data.licenseNumber = getBuildLicenseNumber();
    }

    if (Object.keys(data).length === 0) {
      return { license: this.serialize(existing) };
    }

    const row = (await this.db.robocodersLicense.update({
      where: { id },
      data,
    })) as LicenseRow;
    return { license: this.serialize(row) };
  }

  async remove(id: string) {
    if (!id) throw new BadRequestException('id is required');
    const existing = await this.db.robocodersLicense.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('License not found');
    await this.db.robocodersLicense.delete({ where: { id } });
    return { success: true };
  }

  /** Decode/inspect an arbitrary activation key (verifies the tamper seal). */
  decode(activationKey: string) {
    const key = String(activationKey ?? '').trim();
    if (!key) throw new BadRequestException('activationKey is required');
    const result = readActivationNumber(key, getLicenseSecret());
    if (!result.valid) {
      return { valid: false, reason: result.reason };
    }
    const expiryMs = Date.parse(result.expiryDate! + 'T00:00:00Z');
    const todayUtc = this.todayUtc();
    const todayIso = this.toIsoDate(todayUtc);
    const buildNumber = getBuildLicenseNumber();
    return {
      valid: true,
      machine_id: result.machineId,
      start_date: result.startDate,
      expiry_date: result.expiryDate,
      license_number: result.licenseNumber,
      expected_license_number: buildNumber,
      key_build_mismatch: result.licenseNumber !== buildNumber,
      days_remaining: this.daysRemainingInclusive(expiryMs, todayUtc.getTime()),
      is_expired: todayIso > result.expiryDate!,
      not_yet_active: todayIso < result.startDate!,
    };
  }
}
