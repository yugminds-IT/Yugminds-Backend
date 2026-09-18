import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Role } from '@prisma/client';

function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

@Injectable()
export class AdminProfileService {
  constructor(private readonly db: DatabaseService) {}

  async get(userId: number) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const { password: _, profile: profileRow, ...rest } = user;
    return {
      ...rest,
      full_name: profileRow?.fullName ?? undefined,
      system_alerts: profileRow?.systemAlerts ?? true,
      teacher_leave_requests: profileRow?.teacherLeaveRequests ?? true,
    };
  }

  async update(userId: number, body: Record<string, unknown>) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.role !== Role.admin && !user.isSuperAdmin) {
      throw new ForbiddenException('Admin access required');
    }

    try {
      // Email is intentionally immutable — the settings UI shows it locked
      // with "Email is fixed and cannot be changed"; any `body.email` is
      // silently ignored rather than honored, so a direct API call can't
      // bypass what the UI claims is enforced.

      const profilePatch: Record<string, unknown> = {};
      const fullName =
        typeof body.full_name === 'string' && body.full_name.trim()
          ? body.full_name.trim()
          : undefined;
      if (fullName !== undefined) profilePatch.fullName = fullName;

      const systemAlerts =
        asBool(body.system_alerts) ?? asBool(body.systemAlerts);
      const teacherLeaveRequests =
        asBool(body.teacher_leave_requests) ??
        asBool(body.teacherLeaveRequests);
      if (typeof systemAlerts === 'boolean')
        profilePatch.systemAlerts = systemAlerts;
      if (typeof teacherLeaveRequests === 'boolean')
        profilePatch.teacherLeaveRequests = teacherLeaveRequests;

      if (Object.keys(profilePatch).length > 0) {
        await this.db.profile.upsert({
          where: { userId },
          create: { userId, ...profilePatch } as never,
          update: profilePatch as never,
        });
      }
    } catch (err: unknown) {
      console.error('[AdminProfileService.update] DB error:', err);
      const prisma = err as { code?: string };
      if (prisma?.code === 'P2002')
        throw new ForbiddenException('Email is already in use');
      throw new InternalServerErrorException('Failed to update profile');
    }

    const updated = await this.db.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });
    if (!updated) throw new NotFoundException('User not found');
    const { password: _, profile: profileRow, ...rest } = updated;
    return {
      ...rest,
      full_name: profileRow?.fullName ?? undefined,
      system_alerts: profileRow?.systemAlerts ?? true,
      teacher_leave_requests: profileRow?.teacherLeaveRequests ?? true,
    };
  }
}
