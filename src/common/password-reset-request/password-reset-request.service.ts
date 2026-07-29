import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import * as bcrypt from 'bcrypt';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { RefreshTokenStoreService } from '../../auth/refresh-token-store.service';

export interface ListOptions {
  status?: string;
  limit?: number;
  offset?: number;
  search?: string;
  schoolId?: string | null;
}

export interface UpdatePayload {
  id: string;
  status: string;
  notes?: string;
  approved_by?: string;
  temp_password?: string;
}

export interface UpdateOptions {
  restrictToSchoolId?: string | null;
}

@Injectable()
export class PasswordResetRequestService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly refreshTokenStore: RefreshTokenStoreService,
  ) {}

  private async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }

  async list(opts: ListOptions = {}) {
    const { status, limit = 100, offset = 0, search, schoolId } = opts;
    const take = Math.min(limit, 200);
    const skip = Math.max(offset, 0);

    const where: any = {};

    // 'resolved' is a sentinel meaning "anything but pending" — used by the
    // History tab, which has no single matching status of its own.
    if (status === 'resolved') {
      where.status = { not: 'pending' };
    } else if (status && status !== 'all') {
      where.status = status;
    }

    if (schoolId) {
      where.schoolId = schoolId;
    }

    const q = (search ?? '').trim();
    if (q) {
      // Role is an enum, so it can't take a `contains` filter — instead match
      // against whichever enum values textually contain the search term
      // (e.g. "teach" -> ['teacher']), and OR that in alongside the other
      // free-text matches (requester email/name, approver email/name, school name).
      const ROLES = ['admin', 'school_admin', 'teacher', 'student'] as const;
      const matchedRoles = ROLES.filter((r) =>
        r.replace(/_/g, ' ').toLowerCase().includes(q.toLowerCase()),
      );
      const matchingSchools = await this.db.school.findMany({
        where: { name: { contains: q, mode: 'insensitive' } },
        select: { id: true },
      });
      const schoolIdMatches = matchingSchools.map((s) => s.id);

      where.OR = [
        { user: { email: { contains: q, mode: 'insensitive' } } },
        { user: { profile: { fullName: { contains: q, mode: 'insensitive' } } } },
        { approvedByUser: { email: { contains: q, mode: 'insensitive' } } },
        {
          approvedByUser: {
            profile: { fullName: { contains: q, mode: 'insensitive' } },
          },
        },
        ...(matchedRoles.length > 0
          ? [{ user: { role: { in: matchedRoles as any } } }]
          : []),
        ...(schoolIdMatches.length > 0
          ? [{ schoolId: { in: schoolIdMatches } }]
          : []),
      ];
    }

    const [total, requests] = await Promise.all([
      this.db.passwordResetRequest.count({ where }),
      this.db.passwordResetRequest.findMany({
        where,
        take,
        skip,
        orderBy: { requestedAt: 'desc' },
        include: {
          user: {
            include: {
              profile: true,
            },
          },
          approvedByUser: {
            include: {
              profile: true,
            },
          },
        },
      }),
    ]);

    const schoolIds = [
      ...new Set(requests.map((r) => r.schoolId).filter(Boolean)),
    ] as string[];
    const schools =
      schoolIds.length > 0
        ? await this.db.school.findMany({
            where: { id: { in: schoolIds } },
            select: { id: true, name: true },
          })
        : [];

    const schoolMap = new Map(schools.map((s) => [s.id, s.name]));

    return {
      requests: requests.map((r) => ({
        id: r.id,
        user_id: r.userId,
        email: r.user.email,
        user_role: r.user.role,
        status: r.status,
        requested_at: r.requestedAt.toISOString(),
        approved_at: r.approvedAt?.toISOString(),
        approved_by: r.approvedBy != null ? String(r.approvedBy) : undefined,
        approved_by_name:
          r.approvedByUser?.profile?.fullName ??
          r.approvedByUser?.email ??
          undefined,
        school_id: r.schoolId ?? undefined,
        notes: r.notes ?? undefined,
        created_at: r.createdAt.toISOString(),
        updated_at: r.updatedAt.toISOString(),
        profiles: {
          id: r.user.profile?.id ?? '',
          full_name: r.user.profile?.fullName ?? undefined,
          email: r.user.email,
          role: r.user.role,
          school_id: r.user.profile?.schoolId ?? undefined,
        },
        schools:
          r.schoolId && schoolMap.has(r.schoolId)
            ? { id: r.schoolId, name: schoolMap.get(r.schoolId)! }
            : undefined,
      })),
      total,
    };
  }

  async update(
    payload: UpdatePayload,
    opts?: UpdateOptions,
  ): Promise<{ success: boolean; message: string }> {
    const id = (payload?.id ?? '').trim();
    const status = (payload?.status ?? '').trim().toLowerCase();
    if (!id || !status)
      throw new BadRequestException('id and status are required');

    const request = await this.db.passwordResetRequest.findUnique({
      where: { id },
      include: { user: { include: { profile: true } } },
    });
    if (!request)
      throw new BadRequestException('Password reset request not found');
    if (
      opts?.restrictToSchoolId != null &&
      request.schoolId !== opts.restrictToSchoolId
    ) {
      throw new BadRequestException(
        'You do not have permission to update this request',
      );
    }
    if (request.status !== 'pending') {
      throw new BadRequestException(`Request is already ${request.status}`);
    }

    const notes =
      typeof payload.notes === 'string'
        ? payload.notes.trim() || undefined
        : undefined;
    let approvedBy: number | null = null;
    if (payload.approved_by != null) {
      const parsed = parseInt(String(payload.approved_by), 10);
      if (!Number.isNaN(parsed)) approvedBy = parsed;
    }

    if (status === 'approved') {
      const tempPassword = (payload.temp_password ?? '').trim();
      if (!tempPassword) {
        throw new BadRequestException(
          'A temporary password is required to approve a password reset request',
        );
      }
      if (tempPassword.length < 6) {
        throw new BadRequestException(
          'Temporary password must be at least 6 characters',
        );
      }

      const hashedPassword = await this.hashPassword(tempPassword);

      // Set new password and force password change on next login
      await this.db.user.update({
        where: { id: request.userId },
        data: {
          password: hashedPassword,
          mustChangePassword: true,
          initialPassword: tempPassword,
        } as never,
      });

      // Invalidate all existing sessions so the old password can't be used
      await this.refreshTokenStore.revokeAll(request.userId);

      // Mark request as approved
      await this.db.passwordResetRequest.update({
        where: { id },
        data: {
          status: 'approved',
          approvedAt: new Date(),
          approvedBy,
          notes,
        },
      });

      // Notify the user via in-app notification
      const userName = request.user.profile?.fullName || request.user.email;
      const userNotif = await this.db.notification.create({
        data: {
          userId: request.userId,
          title: 'Your password has been reset',
          message: `Hi ${userName},\n\nYour password reset request has been approved. Your administrator has set a temporary password for your account.\n\nPlease log in using the temporary password provided to you directly by your administrator. You will be required to set a new password immediately after logging in.\n\nIf you did not request a password reset, please contact your administrator immediately.`,
          mode: 'general',
        },
      });

      const unreadCount = await this.db.notification.count({
        where: { userId: request.userId, readAt: null, deletedAt: null },
      });

      this.realtimeGateway.emitNotificationNew(request.userId, {
        id: userNotif.id,
        title: userNotif.title,
        message: userNotif.message,
        type: 'general',
        is_read: false,
        created_at: userNotif.createdAt.toISOString(),
      });
      this.realtimeGateway.emitUnreadCount(request.userId, unreadCount);
      await this.realtimeGateway.emitDashboardStatsForUser(request.userId);

      return {
        success: true,
        message: `Password reset approved. Temporary password set. User has been notified.`,
      };
    }

    if (status === 'rejected') {
      await this.db.passwordResetRequest.update({
        where: { id },
        data: {
          status: 'rejected',
          notes,
          approvedAt: new Date(),
          approvedBy,
        },
      });

      const userName = request.user.profile?.fullName || request.user.email;
      const rejectNotif = await this.db.notification.create({
        data: {
          userId: request.userId,
          title: 'Password reset request rejected',
          message: `Hi ${userName},\n\nYour password reset request has been reviewed and rejected.${notes ? `\n\nReason: ${notes}` : '\n\nPlease contact your administrator for assistance.'}`,
          mode: 'general',
        },
      });
      const unreadCount = await this.db.notification.count({
        where: { userId: request.userId, readAt: null, deletedAt: null },
      });
      this.realtimeGateway.emitNotificationNew(request.userId, {
        id: rejectNotif.id,
        title: rejectNotif.title,
        message: rejectNotif.message,
        type: 'general',
        is_read: false,
        created_at: rejectNotif.createdAt.toISOString(),
      });
      this.realtimeGateway.emitUnreadCount(request.userId, unreadCount);

      return {
        success: true,
        message: 'Request rejected. User has been notified.',
      };
    }

    throw new BadRequestException('status must be "approved" or "rejected"');
  }

  async delete(id: string): Promise<void> {
    const trimmed = (id ?? '').trim();
    if (!trimmed) throw new BadRequestException('id is required');

    const request = await this.db.passwordResetRequest.findUnique({
      where: { id: trimmed },
      select: { status: true },
    });
    if (!request)
      throw new BadRequestException('Password reset request not found');
    // A pending request must be approved or rejected first — both paths
    // notify the requester — rather than silently discarded via delete,
    // which the requester would never learn happened.
    if (request.status === 'pending') {
      throw new BadRequestException(
        'Cannot delete a pending request — approve or reject it first',
      );
    }

    await this.db.passwordResetRequest
      .delete({ where: { id: trimmed } })
      .catch((e: { code?: string }) => {
        if (e?.code === 'P2025')
          throw new BadRequestException('Password reset request not found');
        throw e;
      });
  }
}
