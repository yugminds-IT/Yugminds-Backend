import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import { SignupRole } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { Role, User } from '@prisma/client';

/** Internal user-creation options used by the service layer. Not exposed over HTTP directly. */
export interface CreateUserOptions {
  email: string;
  password: string;
  role: SignupRole;
  tenantId?: string;
  isSuperAdmin?: boolean;
}
import * as bcrypt from 'bcrypt';
import { tenantContext } from '../tenants/tenant-context';
import { tenantScopedQuery } from '../tenants/tenant-scoped-query';
import { RealtimeGateway } from '../common/realtime/realtime.gateway';

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
}

export interface AuthResponse {
  user: {
    id: number;
    email: string;
    role: Role;
    isSuperAdmin: boolean;
    mustChangePassword: boolean;
  };
  tokens: AuthTokens;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  private async hashPassword(password: string): Promise<string> {
    const saltRounds = 10;
    return bcrypt.hash(password, saltRounds);
  }

  private async validatePassword(
    password: string,
    hash: string,
  ): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  /**
   * Hash refresh tokens before storing in DB.
   * We intentionally never persist the raw refresh token value.
   */
  private async hashRefreshToken(refreshToken: string): Promise<string> {
    const saltRounds = 10;
    return bcrypt.hash(refreshToken, saltRounds);
  }

  /**
   * Parse jwt-style expiry strings (e.g. `15m`, `7d`, `30d`) into milliseconds.
   * We keep this intentionally strict to ensure DB expiry matches JWT expiry.
   */
  private parseExpiryToMs(expiry: string, envName: string): number {
    const v = String(expiry ?? '').trim();
    const match = v.match(/^(\d+)([smhd])$/i);
    if (!match) {
      throw new Error(
        `Invalid ${envName} value: "${expiry}". Expected format like 15m, 7d, 30d.`,
      );
    }
    const amount = Number(match[1]);
    const unit = String(match[2]).toLowerCase();

    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    return amount * multipliers[unit];
  }

  private async generateTokens(user: User): Promise<AuthTokens> {
    const tenantId = user.tenantId ?? undefined;
    // Global admins are allowed to authenticate without tenant scoping.
    const isGlobalUser = user.isSuperAdmin || user.role === 'admin';
    if (!tenantId && !isGlobalUser) {
      throw new UnauthorizedException('tenantId missing for user');
    }
    const basePayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      isSuperAdmin: user.isSuperAdmin,
      tenantId,
      tokenVersion: user.tokenVersion,
    };

    const accessExpiry =
      this.config.get<string>('ACCESS_TOKEN_EXPIRY') ?? '15m';
    const refreshExpiry =
      this.config.get<string>('REFRESH_TOKEN_EXPIRY') ?? '7d';

    const accessToken = await this.jwtService.signAsync(
      { ...basePayload },
      {
        secret: this.config.get<string>('JWT_ACCESS_SECRET'),
        expiresIn: accessExpiry as any,
      },
    );
    const refreshToken = await this.jwtService.signAsync(
      { ...basePayload },
      {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshExpiry as any,
      },
    );

    return { accessToken, refreshToken };
  }

  /** Store refresh token in database (call after generating tokens) */
  private async storeRefreshToken(
    userId: number,
    refreshToken: string,
  ): Promise<void> {
    const hashedRefreshToken = await this.hashRefreshToken(refreshToken);
    const refreshExpiry =
      this.config.get<string>('REFRESH_TOKEN_EXPIRY') ?? '7d';
    const refreshTtlMs = this.parseExpiryToMs(
      refreshExpiry,
      'REFRESH_TOKEN_EXPIRY',
    );
    const expiresAt = new Date(Date.now() + refreshTtlMs);

    await this.db.refreshToken.create({
      data: {
        userId,
        token: hashedRefreshToken,
        expiresAt,
      },
    });
  }

  private buildAuthResponse(user: User, tokens: AuthTokens): AuthResponse {
    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        isSuperAdmin: user.isSuperAdmin,
        mustChangePassword:
          (user as User & { mustChangePassword?: boolean })
            .mustChangePassword ?? false,
      },
      tokens,
    };
  }

  async signup(
    dto: CreateUserOptions,
    isSuperAdmin = false,
  ): Promise<AuthResponse> {
    const existing = await this.db.user.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new BadRequestException('Email is already in use');
    }

    try {
      const passwordHash = await this.hashPassword(dto.password);

      // SECURITY: Wrap user creation in transaction to prevent orphaned records
      return await this.db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: dto.email,
            password: passwordHash,
            role: dto.role,
            isSuperAdmin,
            tenantId: dto.tenantId ?? null,
          },
        });

        // Validate cross-tenant ownership using tx so the newly created user
        // (not yet committed) is visible. Only needed for tenant-scoped users.
        if (dto.tenantId) {
          await this.db.assertCrossTenantUserIds(
            [user.id],
            dto.tenantId,
            tx as any,
          );
        }

        // Create profile for the user
        await tx.profile.upsert({
          where: { userId: user.id },
          create: { userId: user.id },
          update: {},
        });

        const tokens = await this.generateTokens(user);

        // Store refresh token within transaction
        const hashedRefreshToken = await this.hashRefreshToken(
          tokens.refreshToken!,
        );
        const refreshExpiry =
          this.config.get<string>('REFRESH_TOKEN_EXPIRY') ?? '7d';
        const refreshTtlMs = this.parseExpiryToMs(
          refreshExpiry,
          'REFRESH_TOKEN_EXPIRY',
        );
        const expiresAt = new Date(Date.now() + refreshTtlMs);

        await tx.refreshToken.create({
          data: {
            userId: user.id,
            token: hashedRefreshToken,
            expiresAt,
          },
        });

        return this.buildAuthResponse(user, tokens);
      });
    } catch (err: unknown) {
      const prisma = err as { code?: string; meta?: { target?: string[] } };
      if (prisma?.code === 'P2002') {
        throw new BadRequestException('Email is already in use');
      }
      throw err;
    }
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const user = await this.db.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (user.isActive === false) {
      // Keep auth errors generic to avoid account-enumeration signals.
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await this.validatePassword(dto.password, user.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // Auto-heal teachers whose tenantId was never set (e.g. created via older code paths).
    // Use $queryRaw/$executeRaw to bypass the tenant-scoped extension — login is a public
    // endpoint with no JWT, so no tenant context is available.
    if (!user.tenantId && user.role === 'teacher') {
      const schools = await this.db.$queryRaw<Array<{ schoolId: string }>>`
        SELECT "schoolId" FROM "TeacherSchool" WHERE "teacherId" = ${user.id} LIMIT 1
      `;
      if (schools[0]?.schoolId) {
        const schoolId = schools[0].schoolId;
        await this.db.$executeRaw`
          UPDATE "User" SET "tenantId" = ${schoolId} WHERE id = ${user.id}
        `;
        user.tenantId = schoolId;
      }
    }

    // Read mustChangePassword via raw query (Prisma client may not have it until regenerated)
    const rows = await this.db.$queryRaw<
      Array<{ mustChangePassword: boolean }>
    >`
      SELECT "mustChangePassword" FROM "User" WHERE id = ${user.id} LIMIT 1
    `;
    const mustChangePassword = rows[0]?.mustChangePassword ?? false;

    const tokens = await this.generateTokens(user);
    await this.storeRefreshToken(user.id, tokens.refreshToken!);

    const response = this.buildAuthResponse(user, tokens);
    response.user.mustChangePassword = mustChangePassword;
    return response;
  }

  /** Submit a password reset request (public). Creates a pending request and notifies admins. */
  async submitPasswordResetRequest(
    email: string,
  ): Promise<{ message: string }> {
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized) {
      return { message: 'Password reset request submitted.' };
    }
    // Use $queryRaw to bypass the tenant-scoped middleware (this is a public endpoint with no JWT)
    const users = await this.db.$queryRaw<
      Array<{
        id: number;
        email: string;
        tenantId: string | null;
        role: string;
      }>
    >`
      SELECT u.id, u.email, u."tenantId", u.role,
             p."fullName", p."schoolId"
      FROM "User" u
      LEFT JOIN "Profile" p ON p."userId" = u.id
      WHERE u.email = ${normalized}
      LIMIT 1
    `;
    if (!users.length) {
      return { message: 'Password reset request submitted.' };
    }
    const user = users[0] as {
      id: number;
      email: string;
      tenantId: string | null;
      role: string;
      fullName?: string | null;
      schoolId?: string | null;
    };

    // Prevent duplicate pending requests
    const existing = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "PasswordResetRequest"
      WHERE "userId" = ${user.id} AND status = 'pending'
      LIMIT 1
    `;
    if (existing.length) {
      return { message: 'Password reset request submitted.' };
    }

    const schoolId: string | null = user.schoolId ?? null;
    await this.db.$executeRaw`
      INSERT INTO "PasswordResetRequest" (id, "userId", status, "schoolId", "requestedAt", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${user.id}, 'pending', ${schoolId}, NOW(), NOW(), NOW())
    `;

    // Route notification to the correct admin based on requester's role:
    // - students / teachers  → notify their school's school admin(s)
    // - school_admin         → notify main admin(s)
    const role = user.role ?? '';
    if (role === 'student' || role === 'teacher') {
      const routingSchoolId = schoolId ?? user.tenantId ?? null;
      if (routingSchoolId) {
        const schoolAdmins = await this.db.$queryRaw<Array<{ userId: number }>>`
          SELECT "userId" FROM "SchoolAdmin" WHERE "schoolId" = ${routingSchoolId}
        `;
        const pendingForSchool = await this.db.$queryRaw<
          Array<{ count: bigint }>
        >`
          SELECT COUNT(*) as count FROM "PasswordResetRequest"
          WHERE status = 'pending' AND "schoolId" = ${routingSchoolId}
        `;
        const schoolCount = Number(pendingForSchool[0]?.count ?? 0);
        for (const sa of schoolAdmins) {
          this.realtimeGateway.emitToUser(
            sa.userId,
            'password_reset_request:new',
            { pending_count: schoolCount },
          );
        }
      }
    } else {
      // school_admin, admin, or unknown → notify main admins
      const adminUsers = await this.db.$queryRaw<Array<{ id: number }>>`
        SELECT id FROM "User" WHERE role = 'admin' AND "isActive" = true
      `;
      const pendingCount = await this.db.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count FROM "PasswordResetRequest" WHERE status = 'pending'
      `;
      const count = Number(pendingCount[0]?.count ?? 0);
      for (const admin of adminUsers) {
        this.realtimeGateway.emitToUser(
          admin.id,
          'password_reset_request:new',
          { pending_count: count },
        );
      }
    }
    return { message: 'Password reset request submitted.' };
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token required');
    }

    let payload: {
      sub: number;
      tenantId?: string;
      isSuperAdmin?: boolean;
      role?: Role;
    };
    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const isGlobalUser =
      Boolean(payload.isSuperAdmin) || payload.role === 'admin';

    if (isGlobalUser) {
      return tenantContext.runSuperAdmin(async () => {
        // SECURITY: Do not query DB by raw token.
        // We fetch all refresh-token hashes for this user and bcrypt-compare in memory.
        const now = new Date();
        const storedTokensQuery = { where: { userId: payload.sub } };
        const storedTokens = await this.db.refreshToken.findMany({
          ...storedTokensQuery,
          include: { user: true },
        });

        if (!storedTokens.length) {
          throw new UnauthorizedException('Invalid refresh token');
        }

        let matched: { id: string; user: User } | null = null;
        for (const row of storedTokens) {
          if (!row.user) continue;
          // Enforce DB expiry even though JWT verification also enforces exp.
          if (row.expiresAt < now) continue;

          const ok = await bcrypt.compare(refreshToken, row.token);
          if (ok) {
            matched = { id: row.id, user: row.user };
            break;
          }
        }

        if (!matched) {
          throw new UnauthorizedException('Invalid refresh token');
        }

        // Rotation: delete the matched refresh token hash, store a new one.
        await this.db.refreshToken.delete({ where: { id: matched.id } });

        const tokens = await this.generateTokens(matched.user);
        await this.storeRefreshToken(matched.user.id, tokens.refreshToken!);

        return this.buildAuthResponse(matched.user, tokens);
      });
    }

    const tenantId =
      payload.tenantId ??
      (
        await this.db.user.findUnique({
          where: { id: payload.sub },
          select: { tenantId: true },
        })
      )?.tenantId;

    if (!tenantId) {
      throw new UnauthorizedException('tenantId missing');
    }

    return tenantContext.run(tenantId, async () => {
      // SECURITY: Do not query DB by raw token.
      // We fetch all refresh-token hashes for this user and bcrypt-compare in memory.
      const now = new Date();
      const storedTokensQuery = tenantScopedQuery(
        { tenantId },
        { where: { userId: payload.sub } },
      );
      const storedTokens = await this.db.refreshToken.findMany({
        ...storedTokensQuery,
        include: { user: true },
      });

      if (!storedTokens.length) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      let matched: { id: string; user: User } | null = null;
      for (const row of storedTokens) {
        if (!row.user) continue;
        // Enforce DB expiry even though JWT verification also enforces exp.
        if (row.expiresAt < now) continue;

        const ok = await bcrypt.compare(refreshToken, row.token);
        if (ok) {
          matched = { id: row.id, user: row.user };
          break;
        }
      }

      if (!matched) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      // Rotation: delete the matched refresh token hash, store a new one.
      // delete uses a unique selector; we already validated tenant via the matched user's tenantId.
      await this.db.refreshToken.delete({ where: { id: matched.id } });

      const tokens = await this.generateTokens(matched.user);
      await this.storeRefreshToken(matched.user.id, tokens.refreshToken!);

      return this.buildAuthResponse(matched.user, tokens);
    });
  }

  async verifyPassword(
    userId: number,
    currentPassword: string,
  ): Promise<{ valid: boolean }> {
    if (!userId) throw new UnauthorizedException('Authentication required');
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    const valid = await this.validatePassword(currentPassword, user.password);
    return { valid };
  }

  async updatePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    if (!userId) throw new UnauthorizedException('Authentication required');
    if (!newPassword) throw new BadRequestException('New password is required');
    if (newPassword.length < 8)
      throw new BadRequestException(
        'New password must be at least 8 characters',
      );

    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');

    // First-time login with a temporary password should not require current_password.
    if (!user.mustChangePassword) {
      if (!currentPassword)
        throw new BadRequestException('Current password is required');
      const valid = await this.validatePassword(currentPassword, user.password);
      if (!valid)
        throw new UnauthorizedException('Current password is incorrect');
    }

    const hashed = await this.hashPassword(newPassword);
    await this.db.user.update({
      where: { id: userId },
      data: { password: hashed, mustChangePassword: false } as never,
    });

    // Invalidate all refresh tokens for the user (force re-login in other sessions)
    const isGlobalUser = user.isSuperAdmin || user.role === 'admin';
    if (isGlobalUser) {
      await this.db.refreshToken.deleteMany({ where: { userId } });
    } else {
      const userTenantId = (
        await this.db.user.findUnique({
          where: { id: userId },
          select: { tenantId: true },
        })
      )?.tenantId;
      if (!userTenantId) throw new UnauthorizedException('tenantId missing');
      const q = tenantScopedQuery(
        { tenantId: userTenantId },
        { where: { userId } },
      );
      await this.db.refreshToken.deleteMany(q);
    }
  }

  /**
   * Resets the password for the currently authenticated user (no current password required).
   */
  async resetPassword(userId: number, newPassword: string): Promise<void> {
    if (!userId) throw new UnauthorizedException('Authentication required');
    if (!newPassword) throw new BadRequestException('New password is required');
    if (newPassword.length < 8)
      throw new BadRequestException(
        'New password must be at least 8 characters',
      );

    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');

    const hashed = await this.hashPassword(newPassword);
    await this.db.user.update({
      where: { id: userId },
      data: { password: hashed, mustChangePassword: false } as never,
    });

    const isGlobalUser = user.isSuperAdmin || user.role === 'admin';
    if (isGlobalUser) {
      await this.db.refreshToken.deleteMany({ where: { userId } });
    } else {
      const userTenantId = (
        await this.db.user.findUnique({
          where: { id: userId },
          select: { tenantId: true },
        })
      )?.tenantId;
      if (!userTenantId) throw new UnauthorizedException('tenantId missing');
      const q = tenantScopedQuery(
        { tenantId: userTenantId },
        { where: { userId } },
      );
      await this.db.refreshToken.deleteMany(q);
    }
  }

  async logout(userId: number, refreshToken?: string): Promise<void> {
    if (!userId) throw new UnauthorizedException('Authentication required');

    // Invalidate all previously issued access tokens immediately.
    await this.db.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });

    if (refreshToken && refreshToken.trim()) {
      const raw = refreshToken.trim();
      const user = await this.db.user.findUnique({
        where: { id: userId },
        select: { isSuperAdmin: true, tenantId: true, role: true },
      });
      if (!user) throw new UnauthorizedException('User not found');

      const isGlobalUser = user.isSuperAdmin || user.role === 'admin';
      if (isGlobalUser) {
        const storedTokens = await this.db.refreshToken.findMany({
          where: { userId },
          select: { id: true, token: true },
        });

        for (const row of storedTokens) {
          const ok = await bcrypt.compare(raw, row.token);
          if (ok) {
            await this.db.refreshToken
              .delete({ where: { id: row.id } })
              .catch(() => {});
            break;
          }
        }
        return;
      }

      const userTenantId = user.tenantId;
      if (!userTenantId) throw new UnauthorizedException('tenantId missing');
      const storedTokensQ = tenantScopedQuery(
        { tenantId: userTenantId },
        { where: { userId } },
      );
      const storedTokens = await this.db.refreshToken.findMany({
        ...storedTokensQ,
        select: { id: true, token: true },
      });

      // Best-effort: delete only the refresh token that matches the provided raw token.
      for (const row of storedTokens) {
        const ok = await bcrypt.compare(raw, row.token);
        if (ok) {
          await this.db.refreshToken
            .delete({ where: { id: row.id } })
            .catch(() => {});
          break;
        }
      }
      return;
    }
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { isSuperAdmin: true, tenantId: true, role: true },
    });
    if (!user) throw new UnauthorizedException('User not found');

    const isGlobalUser = user.isSuperAdmin || user.role === 'admin';
    if (isGlobalUser) {
      await this.db.refreshToken.deleteMany({ where: { userId } });
    } else {
      const userTenantId = user.tenantId;
      if (!userTenantId) throw new UnauthorizedException('tenantId missing');
      const q = tenantScopedQuery(
        { tenantId: userTenantId },
        { where: { userId } },
      );
      await this.db.refreshToken.deleteMany(q);
    }
  }
}
