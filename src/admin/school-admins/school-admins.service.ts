import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DatabaseService } from '../../database/database.service';
import { AuthService, CreateUserOptions } from '../../auth/auth.service';
import { ok } from '../../common/api-response';
import { validatePasswordStrength } from '../../common/utils/password.util';

@Injectable()
export class AdminSchoolAdminsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authService: AuthService,
  ) {}

  async list(params?: { search?: string; status?: string; schoolId?: string }) {
    const where: Record<string, unknown> = {
      user: { role: 'school_admin' },
    };
    if (params?.schoolId && params.schoolId !== 'all') {
      where.schoolId = params.schoolId;
    }
    if (params?.search?.trim()) {
      const q = params.search.trim();
      where.user = {
        role: 'school_admin',
        OR: [
          { email: { contains: q, mode: 'insensitive' } },
          { profile: { fullName: { contains: q, mode: 'insensitive' } } },
          { profile: { phone: { contains: q, mode: 'insensitive' } } },
        ],
      };
    }

    const list = await this.db.schoolAdmin.findMany({
      where,
      include: {
        user: { include: { profile: true } },
        school: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const schoolAdmins = list.map((sa) => {
      const user = sa.user;
      const school = sa.school;
      return {
        id: String(user.id),
        profile_id: user.profile?.id ?? null,
        email: user.email,
        full_name: user.profile?.fullName ?? null,
        phone: user.profile?.phone ?? null,
        school_id: sa.schoolId,
        school_name: school?.name ?? null,
        schools: school
          ? {
              id: school.id,
              name: school.name,
              city: school.city ?? null,
              state: school.state ?? null,
            }
          : null,
        is_active: user.isActive,
        created_at: sa.createdAt.toISOString(),
        updated_at: (sa.user.profile?.updatedAt ?? sa.createdAt).toISOString(),
      };
    });

    // Optional status filter: active = user.isActive === true, inactive = false
    let filtered = schoolAdmins;
    if (params?.status && params.status !== 'all') {
      if (params.status === 'active') {
        filtered = schoolAdmins.filter((a) => a.is_active === true);
      } else if (params.status === 'inactive') {
        filtered = schoolAdmins.filter((a) => a.is_active === false);
      }
    }

    return ok({ items: filtered }, { total: filtered.length });
  }

  async create(body: Record<string, unknown>) {
    const email = String(body.email ?? '').trim();
    const password = String(body.temp_password ?? body.password ?? '').trim();
    const schoolId = String(body.school_id ?? '').trim();
    const fullName =
      body.full_name != null ? String(body.full_name).trim() : '';
    const phone = body.phone != null ? String(body.phone).trim() : '';

    if (!email) throw new BadRequestException('Email is required');
    if (!password) throw new BadRequestException('Password is required');
    validatePasswordStrength(password);
    if (!schoolId) throw new BadRequestException('School is required');

    const school = await this.resolveSchoolId(schoolId);
    if (!school) throw new BadRequestException('School not found');

    const result = await this.authService.signup({
      email,
      password,
      role: 'school_admin' as CreateUserOptions['role'],
      tenantId: school.id,
    });

    const userId = result.user.id;

    await this.db.schoolAdmin.create({
      data: { userId, schoolId: school.id },
    });

    await this.db.profile.upsert({
      where: { userId },
      create: {
        userId,
        fullName: fullName || null,
        phone: phone || null,
        schoolId: school.id,
      },
      update: {
        fullName: fullName || undefined,
        phone: phone || undefined,
        schoolId: school.id,
      },
    });

    return {
      success: true,
      user: result.user,
      message: 'School admin created successfully',
    };
  }

  async update(body: Record<string, unknown>) {
    const id = body.id ?? body.school_admin_id;
    if (!id || typeof id !== 'string')
      throw new BadRequestException('id required');

    // Frontend sends user id (number as string); support SchoolAdmin uuid or user id
    const userIdNum = Number(id);
    const byUser =
      Number.isInteger(userIdNum) && String(userIdNum) === id
        ? await this.db.schoolAdmin.findFirst({
            where: { userId: userIdNum },
            include: { user: { include: { profile: true } }, school: true },
          })
        : null;
    const byPk =
      id.length === 36
        ? await this.db.schoolAdmin.findUnique({
            where: { id },
            include: { user: { include: { profile: true } }, school: true },
          })
        : null;
    const sa = byUser ?? byPk;
    if (!sa) throw new BadRequestException('School admin not found');
    if (sa.user.role !== 'school_admin')
      throw new ForbiddenException('Target user is not a school admin');

    const fullName =
      body.full_name != null ? String(body.full_name).trim() : undefined;
    const phone = body.phone != null ? String(body.phone).trim() : undefined;
    const schoolId =
      body.school_id != null ? String(body.school_id).trim() : undefined;
    const isActive =
      body.is_active !== undefined ? Boolean(body.is_active) : undefined;

    let resolvedSchoolId: string | undefined = undefined;
    if (schoolId !== undefined && schoolId !== sa.schoolId) {
      const school = await this.resolveSchoolId(schoolId);
      if (!school) throw new BadRequestException('School not found');
      resolvedSchoolId = school.id;
      await Promise.all([
        this.db.schoolAdmin.update({
          where: { id: sa.id },
          data: { schoolId: resolvedSchoolId },
        }),
        // Keep tenant scoping aligned with school assignment.
        this.db.user.update({
          where: { id: sa.userId },
          data: { tenantId: resolvedSchoolId },
        }),
      ]);
    }

    if (
      fullName !== undefined ||
      phone !== undefined ||
      resolvedSchoolId !== undefined
    ) {
      await this.db.profile.upsert({
        where: { userId: sa.userId },
        create: {
          userId: sa.userId,
          fullName: fullName ?? null,
          phone: phone ?? null,
          schoolId: resolvedSchoolId ?? sa.schoolId,
        },
        update: {
          ...(fullName !== undefined && { fullName }),
          ...(phone !== undefined && { phone }),
          ...(resolvedSchoolId !== undefined && { schoolId: resolvedSchoolId }),
        },
      });
    }

    // Password change — only when explicitly requested with a non-empty password
    const changePassword = body.change_password === true;
    const rawPassword =
      body.temp_password != null ? String(body.temp_password).trim() : '';
    if (changePassword && rawPassword) {
      validatePasswordStrength(rawPassword);
      const hashed = await bcrypt.hash(rawPassword, 10);
      await this.db.user.update({
        where: { id: sa.userId },
        data: { password: hashed, mustChangePassword: false } as never,
      });
      // Invalidate all existing sessions so stale tokens can't be used
      await this.db.refreshToken.deleteMany({ where: { userId: sa.userId } });
    }

    // School admin status is user-level activation.
    let updatedIsActive: boolean | undefined;
    if (isActive !== undefined) {
      await this.db.user.update({
        where: { id: sa.userId },
        data: { isActive },
      });
      updatedIsActive = isActive;
    } else {
      updatedIsActive = sa.user.isActive;
    }

    return {
      success: true,
      message:
        changePassword && rawPassword
          ? 'Password updated successfully'
          : 'School admin updated',
      schoolAdmin:
        updatedIsActive !== undefined
          ? { id: String(sa.userId), is_active: updatedIsActive }
          : undefined,
    };
  }

  async delete(id: string) {
    // Frontend list returns user id as "id" (User.id); SchoolAdmin has its own uuid. Support both.
    const byPk = await this.db.schoolAdmin.findUnique({ where: { id } });
    if (byPk) {
      await this.db.user.delete({ where: { id: byPk.userId } });
      return { success: true };
    }
    const userId = Number(id);
    if (!Number.isInteger(userId)) {
      throw new BadRequestException('School admin not found');
    }
    // Delete by user id: list shows User.id so frontend sends that
    const user = await this.db.user.findFirst({
      where: { id: userId, role: 'school_admin' },
    });
    if (!user) {
      throw new BadRequestException('School admin not found');
    }
    // Delete SchoolAdmin record first (cascade handles related data), then User
    await this.db.schoolAdmin.deleteMany({ where: { userId: user.id } });
    try {
      await this.db.user.delete({ where: { id: user.id } });
    } catch (err: unknown) {
      // P2025 = record already deleted — treat as success
      if ((err as { code?: string })?.code !== 'P2025') throw err;
    }
    return { success: true };
  }

  /**
   * Resolve frontend "school" id to a School record.
   * The admin schools list returns Tenants, so the dropdown sends Tenant ids.
   * We accept either a School id or a Tenant id; if Tenant, ensure a School exists (upsert).
   */
  private async resolveSchoolId(
    id: string,
  ): Promise<{ id: string; name: string } | null> {
    const school = await this.db.school.findUnique({ where: { id } });
    if (school) return school;

    const tenant = await this.db.tenant.findUnique({ where: { id } });
    if (!tenant) return null;

    await this.db.school.upsert({
      where: { id: tenant.id },
      create: {
        id: tenant.id,
        name: tenant.name,
      },
      update: { name: tenant.name },
    });
    return { id: tenant.id, name: tenant.name };
  }
}
