import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import * as bcrypt from 'bcrypt';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export interface ListOptions {
  status?: string;
  limit?: number;
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
  ) {}

  private async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }

  async list(opts: ListOptions = {}) {
    const { status, limit = 100, schoolId } = opts;
    const take = Math.min(limit, 200);

    const where: any = {};

    if (status && status !== 'all') {
      where.status = status;
    }

    if (schoolId) {
      where.schoolId = schoolId;
    }

    const requests = await this.db.passwordResetRequest.findMany({
      where,
      take,
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
    });

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
        data: { password: hashedPassword, mustChangePassword: true } as never,
      });

      // Invalidate all existing sessions so the old password can't be used
      await this.db.refreshToken.deleteMany({
        where: { userId: request.userId },
      });

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

  async verifyResetToken(
    requestId: string,
    token: string,
  ): Promise<{ valid: boolean }> {
    if (!requestId || !token) return { valid: false };

    const request = await this.db.passwordResetRequest.findUnique({
      where: { id: requestId },
    });

    if (
      !request ||
      !request.resetToken ||
      !request.resetTokenExpiresAt ||
      request.status !== 'pending'
    ) {
      return { valid: false };
    }

    if (request.resetTokenExpiresAt < new Date()) {
      return { valid: false };
    }

    const matches = await bcrypt.compare(token, request.resetToken);
    return { valid: matches };
  }

  async completePasswordReset(
    requestId: string,
    token: string,
    newPassword: string,
  ): Promise<void> {
    if (!requestId || !token || !newPassword) {
      throw new BadRequestException('Missing required fields');
    }

    const hashedPassword = await this.hashPassword(newPassword);

    // Atomic: fetch, verify, and consume the token inside a single transaction.
    // This prevents a TOCTOU race where two concurrent requests both pass verify
    // but then both update the user's password.
    await this.db.$transaction(async (tx) => {
      const request = await tx.passwordResetRequest.findUnique({
        where: { id: requestId },
      });

      if (
        !request ||
        !request.resetToken ||
        !request.resetTokenExpiresAt ||
        request.status !== 'pending'
      ) {
        throw new BadRequestException('Invalid or expired reset token');
      }

      if (request.resetTokenExpiresAt < new Date()) {
        throw new BadRequestException('Invalid or expired reset token');
      }

      const matches = await bcrypt.compare(token, request.resetToken);
      if (!matches)
        throw new BadRequestException('Invalid or expired reset token');

      // Consume the token first — prevents a second concurrent request from also succeeding.
      await tx.passwordResetRequest.update({
        where: { id: requestId },
        data: {
          status: 'completed',
          resetToken: null,
          resetTokenExpiresAt: null,
        },
      });

      await tx.user.update({
        where: { id: request.userId },
        data: { password: hashedPassword, mustChangePassword: false } as never,
      });

      await tx.refreshToken.deleteMany({ where: { userId: request.userId } });
    });
  }

  async delete(id: string): Promise<void> {
    const trimmed = (id ?? '').trim();
    if (!trimmed) throw new BadRequestException('id is required');
    await this.db.passwordResetRequest
      .delete({ where: { id: trimmed } })
      .catch((e: { code?: string }) => {
        if (e?.code === 'P2025')
          throw new BadRequestException('Password reset request not found');
        throw e;
      });
  }
}
