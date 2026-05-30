import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export interface NotificationDto {
  id: string;
  title: string;
  message: string;
  type: string | null;
  is_read: boolean;
  created_at: string;
  notification_data?: Record<string, unknown>;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  async getUnreadCount(
    userId: number,
    excludePasswordReset = false,
  ): Promise<number> {
    const where: Record<string, unknown> = {
      userId,
      readAt: null,
      deletedAt: null,
    };
    if (excludePasswordReset) {
      // Admins track password resets via a dedicated badge; exclude them from the inbox count.
      where.NOT = {
        title: { contains: 'password reset', mode: 'insensitive' },
      };
    }
    const count = await this.db.notification.count({ where });
    return count;
  }

  async getUserNotifications(
    userId: number,
    options: { filter?: string; limit?: number } = {},
  ): Promise<NotificationDto[]> {
    const { filter = 'all', limit = 50 } = options;
    const take = Math.min(Math.max(limit || 0, 1), 100);

    const where: { userId: number; deletedAt: null; readAt?: null } = {
      userId,
      deletedAt: null,
    };
    if (filter === 'unread') {
      where.readAt = null;
    }

    const list = await this.db.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
    });

    return list.map((n) => ({
      id: n.id,
      title: n.title,
      message: n.message,
      type: n.mode ?? 'general',
      is_read: n.readAt != null,
      created_at: n.createdAt.toISOString(),
    }));
  }

  async updateUserNotification(
    userId: number,
    body: {
      notification_id?: string;
      user_id?: string;
      is_read?: boolean;
      deleted?: boolean;
      mark_all?: boolean;
    },
  ): Promise<{ success: boolean; notification?: NotificationDto }> {
    const { notification_id, is_read, deleted, mark_all } = body;

    if (mark_all && is_read) {
      await this.db.notification.updateMany({
        where: { userId, deletedAt: null },
        data: { readAt: new Date() },
      });
      const unreadCount = await this.getUnreadCount(userId);
      this.realtimeGateway.emitNotificationRead(userId, {
        mark_all: true,
        read_at: new Date().toISOString(),
      });
      this.realtimeGateway.emitUnreadCount(userId, unreadCount);
      await this.realtimeGateway.emitDashboardStatsForUser(userId);
      return { success: true };
    }

    if (notification_id) {
      const n = await this.db.notification.findFirst({
        where: { id: notification_id, userId },
      });
      if (!n) {
        throw new ForbiddenException('Notification not found');
      }
      if (deleted) {
        const wasUnread = n.readAt == null;
        await this.db.notification.update({
          where: { id: notification_id },
          data: { deletedAt: new Date() },
        });
        if (wasUnread) {
          const unreadCount = await this.getUnreadCount(userId);
          this.realtimeGateway.emitUnreadCount(userId, unreadCount);
        }
        await this.realtimeGateway.emitDashboardStatsForUser(userId);
        return { success: true };
      }
      if (is_read) {
        await this.db.notification.update({
          where: { id: notification_id },
          data: { readAt: new Date() },
        });
        const unreadCount = await this.getUnreadCount(userId);
        this.realtimeGateway.emitNotificationRead(userId, {
          notification_id,
          mark_all: false,
          read_at: new Date().toISOString(),
        });
        this.realtimeGateway.emitUnreadCount(userId, unreadCount);
        await this.realtimeGateway.emitDashboardStatsForUser(userId);
        const updated = await this.db.notification.findUnique({
          where: { id: notification_id },
        });
        return {
          success: true,
          notification: updated
            ? {
                id: updated.id,
                title: updated.title,
                message: updated.message,
                type: updated.mode ?? 'general',
                is_read: updated.readAt != null,
                created_at: updated.createdAt.toISOString(),
              }
            : undefined,
        };
      }
    }

    throw new BadRequestException(
      'Provide notification_id with is_read or deleted, or mark_all with is_read',
    );
  }

  /** Get replies for a notification. Caller must be recipient or sender of the notification. */
  async getReplies(
    notificationId: string,
    currentUserId: number,
  ): Promise<
    Array<{
      id: string;
      notification_id: string;
      user_id: number;
      reply_text: string;
      created_at: string;
      updated_at: string;
      profiles?: { full_name: string | null; email: string; role: string };
    }>
  > {
    const notification = await this.db.notification.findUnique({
      where: { id: notificationId, deletedAt: null },
      select: { userId: true, senderId: true },
    });
    if (!notification) return [];
    const canAccess =
      notification.userId === currentUserId ||
      (notification.senderId != null &&
        notification.senderId === currentUserId);
    if (!canAccess) return [];

    const replies = await this.db.notificationReply.findMany({
      where: { notificationId },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { include: { profile: { select: { fullName: true } } } },
      },
    });

    return replies.map((r) => ({
      id: r.id,
      notification_id: r.notificationId,
      user_id: r.userId,
      reply_text: r.replyText,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
      profiles: {
        full_name: r.user.profile?.fullName ?? null,
        email: r.user.email,
        role: r.user.role,
      },
    }));
  }

  /** Create a reply to a notification. Caller must be recipient or sender. */
  async createReply(
    notificationId: string,
    currentUserId: number,
    replyText: string,
  ): Promise<{
    id: string;
    notification_id: string;
    user_id: number;
    reply_text: string;
    created_at: string;
    updated_at: string;
    profiles?: { full_name: string | null; email: string; role: string };
  }> {
    const notification = await this.db.notification.findUnique({
      where: { id: notificationId },
      select: { userId: true, senderId: true },
    });
    if (!notification) throw new BadRequestException('Notification not found');
    const canReply =
      notification.userId === currentUserId ||
      (notification.senderId != null &&
        notification.senderId === currentUserId);
    if (!canReply)
      throw new ForbiddenException('Cannot reply to this notification');

    const text = String(replyText ?? '').trim();
    if (!text) throw new BadRequestException('reply_text is required');

    const r = await this.db.notificationReply.create({
      data: { notificationId, userId: currentUserId, replyText: text },
      include: {
        user: { include: { profile: { select: { fullName: true } } } },
      },
    });
    return {
      id: r.id,
      notification_id: r.notificationId,
      user_id: r.userId,
      reply_text: r.replyText,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
      profiles: {
        full_name: r.user.profile?.fullName ?? null,
        email: r.user.email,
        role: r.user.role,
      },
    };
  }

  /** Create a notification for a user (e.g. from admin or system). */
  async create(
    userId: number,
    data: { title: string; message: string; type?: string; senderId?: number },
  ): Promise<NotificationDto> {
    const n = await this.db.notification.create({
      data: {
        userId,
        title: data.title,
        message: data.message,
        mode: data.type ?? 'general',
        senderId: data.senderId ?? undefined,
      },
    });
    const dto = {
      id: n.id,
      title: n.title,
      message: n.message,
      type: n.mode ?? 'general',
      is_read: false,
      created_at: n.createdAt.toISOString(),
    };
    const unreadCount = await this.getUnreadCount(userId);
    this.realtimeGateway.emitNotificationNew(userId, dto);
    this.realtimeGateway.emitUnreadCount(userId, unreadCount);
    await this.realtimeGateway.emitDashboardStatsForUser(userId);
    return dto;
  }
}
