import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import { AcademyRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/database.service';
import type { AcademySignupDto } from './academy.dto';
import { SessionsService } from '../auth/sessions/sessions.service';

const PUBLIC_ACCOUNT = {
  id: true,
  email: true,
  role: true,
  fullName: true,
  phone: true,
  parentName: true,
  mustChangePassword: true,
} as const;

/** Readable one-time password for accounts an admin creates or resets. */
export function tempPassword(): string {
  return `Ac${randomBytes(6).toString('base64url')}9`;
}

@Injectable()
export class AcademyAuthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AcademyAuthService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly sessions: SessionsService,
  ) {}

  /** First Academy admin from env, like the LMS ADMIN_SEED_*. Safe to leave set. */
  async onApplicationBootstrap() {
    const email = process.env.ACADEMY_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ACADEMY_ADMIN_PASSWORD;
    if (!email || !password) return;
    try {
      const exists = await this.db.academyAccount.findUnique({
        where: { email },
      });
      if (exists) return;
      await this.db.academyAccount.create({
        data: {
          email,
          passwordHash: await bcrypt.hash(password, 12),
          role: AcademyRole.ADMIN,
          fullName: 'Academy Admin',
          mustChangePassword: true,
        },
      });
      this.logger.log(`Academy admin seeded: ${email}`);
    } catch (e) {
      this.logger.warn(`Academy admin seed skipped: ${String(e)}`);
    }
  }

  async signup(dto: AcademySignupDto) {
    const email = dto.email.trim().toLowerCase();
    try {
      return await this.db.academyAccount.create({
        data: {
          email,
          passwordHash: await bcrypt.hash(dto.password, 12),
          role: AcademyRole.LEARNER,
          fullName: dto.fullName.trim(),
          phone: dto.phone.trim(),
          parentName: dto.parentName?.trim() || null,
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new BadRequestException(
          'An account with this email already exists — please log in.',
        );
      }
      throw e;
    }
  }

  async login(emailRaw: string, password: string) {
    const account = await this.db.academyAccount.findUnique({
      where: { email: emailRaw.trim().toLowerCase() },
    });
    // Same message for every failure: no account enumeration.
    if (
      !account ||
      !account.isActive ||
      !(await bcrypt.compare(password, account.passwordHash))
    ) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return account;
  }

  /** Refresh: the token's version must still match (logout/password change revoke all). */
  async forRefresh(id: string, version: number) {
    const account = await this.db.academyAccount.findUnique({ where: { id } });
    if (!account || !account.isActive || account.tokenVersion !== version) {
      throw new UnauthorizedException('Session expired — please log in again');
    }
    return account;
  }

  async revokeAll(id: string) {
    await this.db.academyAccount.update({
      where: { id },
      data: { tokenVersion: { increment: 1 } },
    });
  }

  async me(id: string) {
    const account = await this.db.academyAccount.findUnique({
      where: { id },
      select: PUBLIC_ACCOUNT,
    });
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  async updateProfile(
    id: string,
    data: { fullName?: string; phone?: string; parentName?: string },
  ) {
    return this.db.academyAccount.update({
      where: { id },
      data,
      select: PUBLIC_ACCOUNT,
    });
  }

  /** Returns the updated account (new tokenVersion) so the caller can reissue cookies. */
  async changePassword(id: string, current: string, next: string) {
    const account = await this.db.academyAccount.findUnique({ where: { id } });
    if (!account || !(await bcrypt.compare(current, account.passwordHash))) {
      throw new BadRequestException('Current password is incorrect');
    }
    if (current === next)
      throw new BadRequestException('Choose a new password');
    return this.db.academyAccount.update({
      where: { id },
      data: {
        passwordHash: await bcrypt.hash(next, 12),
        mustChangePassword: false,
        tokenVersion: { increment: 1 },
      },
    });
  }

  /** Admin action: issue a one-time password the person must change at next login. */
  async resetPassword(id: string) {
    const password = tempPassword();
    const account = await this.db.academyAccount.update({
      where: { id },
      data: {
        passwordHash: await bcrypt.hash(password, 12),
        mustChangePassword: true,
        tokenVersion: { increment: 1 },
      },
      select: { email: true },
    });
    await this.sessions.revokeMany('academy', id);
    return { email: account.email, tempPassword: password };
  }

  async createAccount(data: {
    email: string;
    fullName: string;
    phone?: string;
    role: AcademyRole;
  }) {
    const password = tempPassword();
    try {
      const account = await this.db.academyAccount.create({
        data: {
          email: data.email.trim().toLowerCase(),
          fullName: data.fullName.trim(),
          phone: data.phone?.trim() || null,
          role: data.role,
          passwordHash: await bcrypt.hash(password, 12),
          mustChangePassword: true,
        },
      });
      return { account, tempPassword: password };
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new BadRequestException(
          'An Academy account with this email already exists',
        );
      }
      throw e;
    }
  }
}
