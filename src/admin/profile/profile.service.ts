import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Role } from '@prisma/client';

@Injectable()
export class AdminProfileService {
  constructor(private readonly db: DatabaseService) {}

  async get(userId: number) {
    const user = await (this.db as any).user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const { password: _, profile: profileRow, ...rest } = user;
    return { ...rest, full_name: profileRow?.fullName ?? undefined };
  }

  async update(userId: number, body: Record<string, unknown>) {
    const user = await (this.db as any).user.findUnique({
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

      // Upsert profile for full_name
      const fullName =
        typeof body.full_name === 'string' && body.full_name.trim()
          ? body.full_name.trim()
          : undefined;
      if (fullName !== undefined) {
        await (this.db as any).profile.upsert({
          where: { userId },
          create: { userId, fullName },
          update: { fullName },
        });
      }
    } catch (err: unknown) {
      console.error('[AdminProfileService.update] DB error:', err);
      const prisma = err as { code?: string };
      if (prisma?.code === 'P2002')
        throw new ForbiddenException('Email is already in use');
      throw new InternalServerErrorException('Failed to update profile');
    }

    // Return fresh data
    const updated = await (this.db as any).user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });
    const { password: _, profile: profileRow, ...rest } = updated;
    return { ...rest, full_name: profileRow?.fullName ?? undefined };
  }
}
