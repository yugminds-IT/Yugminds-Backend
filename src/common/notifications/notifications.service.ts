import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { randomUUID } from 'crypto';

export interface NotificationDto {
  id: string;
  title: string;
  message: string;
  type: string | null;
  is_read: boolean;
  allow_replies: boolean;
  created_at: string;
  notification_data?: Record<string, unknown>;
}

export interface NotificationWithProfileDto extends NotificationDto {
  user_id: number;
  sender_id: number | null;
  broadcast_id: string | null;
  reply_count?: number;
  profiles?: {
    id: string;
    full_name: string | null;
    email: string;
    role: string;
  };
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  // ─── Core send ────────────────────────────────────────────────────────────

  /**
   * Batch-send notifications to multiple users.
   * Uses a single createMany INSERT then emits per-user WS events.
   * Does NOT trigger per-user dashboard stat recomputation (too expensive at scale).
   */
  async sendBroadcast(
    senderId: number,
    userIds: number[],
    data: {
      title: string;
      message: string;
      type?: string;
      allowReplies?: boolean;
    },
  ): Promise<{ sent: number }> {
    const ids = Array.from(new Set(userIds)).filter((id) => id !== senderId);
    if (ids.length === 0) return { sent: 0 };

    const now = new Date();
    const broadcastId = randomUUID();
    await this.db.notification.createMany({
      data: ids.map((uid) => ({
        userId: uid,
        senderId,
        title: data.title,
        message: data.message,
        mode: data.type ?? 'general',
        allowReplies: data.allowReplies !== false,
        broadcastId,
        createdAt: now,
      })),
    });

    // Fetch created rows so we have real IDs for WS payload.
    const created = await this.db.notification.findMany({
      where: { broadcastId },
      select: {
        id: true,
        userId: true,
        title: true,
        message: true,
        mode: true,
        allowReplies: true,
        createdAt: true,
      },
    });

    const byUser = new Map(created.map((n) => [n.userId, n]));
    for (const uid of ids) {
      const n = byUser.get(uid);
      if (!n) continue;
      this.realtimeGateway.emitNotificationNew(uid, {
        id: n.id,
        title: n.title,
        message: n.message,
        type: n.mode ?? 'general',
        is_read: false,
        allow_replies: n.allowReplies,
        created_at: n.createdAt.toISOString(),
      });
    }

    return { sent: ids.length };
  }

  /**
   * Send a single notification to one user and emit WS events.
   * Used for system-generated notifications (schedule sync, grade notifications, etc.).
   */
  async sendOne(
    senderId: number,
    userId: number,
    data: {
      title: string;
      message: string;
      type?: string;
      allowReplies?: boolean;
    },
  ): Promise<NotificationDto> {
    const n = await this.db.notification.create({
      data: {
        userId,
        senderId,
        title: data.title,
        message: data.message,
        mode: data.type ?? 'general',
        allowReplies: data.allowReplies !== false,
      },
    });
    const dto: NotificationDto = {
      id: n.id,
      title: n.title,
      message: n.message,
      type: n.mode ?? 'general',
      is_read: false,
      allow_replies: n.allowReplies,
      created_at: n.createdAt.toISOString(),
    };
    const unreadCount = await this.getUnreadCount(userId);
    this.realtimeGateway.emitNotificationNew(userId, dto);
    this.realtimeGateway.emitUnreadCount(userId, unreadCount);
    return dto;
  }

  // ─── Reading ──────────────────────────────────────────────────────────────

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
      where.NOT = {
        title: { contains: 'password reset', mode: 'insensitive' },
      };
    }
    return this.db.notification.count({ where });
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
    if (filter === 'unread') where.readAt = null;

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
      allow_replies: n.allowReplies,
      created_at: n.createdAt.toISOString(),
    }));
  }

  /**
   * List notifications with sender/recipient profiles and reply counts.
   * Used by admin, school-admin, and teacher "sent/received/all" views.
   *
   * @param allowedRecipientIds - when set, scopes "sent" view to only those recipients
   * @param excludePasswordReset - admin inbox suppresses password-reset notifications
   */
  async listWithProfiles(
    userId: number,
    opts: {
      mode: 'received' | 'sent' | 'all';
      limit: number;
      offset?: number;
      search?: string;
      status?: 'all' | 'read' | 'unread';
      allowedRecipientIds?: number[];
      excludePasswordReset?: boolean;
    },
  ): Promise<{ items: NotificationWithProfileDto[]; total: number }> {
    const {
      mode,
      limit,
      offset = 0,
      search,
      status = 'all',
      allowedRecipientIds,
      excludePasswordReset,
    } = opts;
    const take = Math.min(Math.max(limit, 1), 100);
    const skip = Math.max(offset, 0);

    const recipientFilter =
      allowedRecipientIds && allowedRecipientIds.length > 0
        ? { userId: { in: allowedRecipientIds } }
        : {};

    let where: Record<string, unknown>;
    if (mode === 'sent') {
      where = { senderId: userId, deletedAt: null, ...recipientFilter };
    } else if (mode === 'all') {
      where = {
        deletedAt: null,
        OR: [
          { userId },
          { senderId: userId, ...recipientFilter },
        ],
      };
    } else {
      where = { userId, deletedAt: null };
      if (excludePasswordReset) {
        where.NOT = {
          title: { contains: 'password reset', mode: 'insensitive' },
        };
      }
    }

    // "received" is the only mode with a per-row read state — "sent" rows
    // reflect the recipient's read state, not the sender's, so a status
    // filter there wouldn't mean what the caller expects.
    if (mode !== 'sent' && status !== 'all') {
      where.readAt = status === 'read' ? { not: null } : null;
    }

    const q = (search ?? '').trim();
    if (q) {
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { message: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [total, list] = await Promise.all([
      this.db.notification.count({ where: where as any }),
      this.db.notification.findMany({
        where: where as any,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          user: { include: { profile: { select: { fullName: true } } } },
          sender: { include: { profile: { select: { fullName: true } } } },
          _count: { select: { replies: true } },
        },
      }),
    ]);

    const isSent = mode === 'sent';
    const items = list.map((n) => {
      const profileUser = isSent ? n.user : n.sender;
      // System-generated notifications (weekly digest, auto-issued
      // certificates, etc.) have no senderId — without this fallback the
      // "From" column renders a bare, unexplained "—".
      const profiles = profileUser
        ? {
            id: String(profileUser.id),
            full_name: profileUser.profile?.fullName ?? profileUser.email,
            email: profileUser.email,
            role: profileUser.role,
          }
        : !isSent
          ? {
              id: '0',
              full_name: 'Yugminds System',
              email: 'system@yugminds.com',
              role: 'system',
            }
          : undefined;
      return {
        id: n.id,
        user_id: n.userId,
        sender_id: n.senderId ?? null,
        broadcast_id: n.broadcastId ?? null,
        title: n.title,
        message: n.message,
        type: n.mode ?? 'general',
        is_read: !!n.readAt,
        allow_replies: n.allowReplies,
        created_at: n.createdAt.toISOString(),
        reply_count: n._count?.replies ?? 0,
        profiles,
      };
    });

    return { items, total };
  }

  // ─── Updating ─────────────────────────────────────────────────────────────

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
      if (!n) throw new ForbiddenException('Notification not found');

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
                allow_replies: updated.allowReplies,
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

  /**
   * Mark one notification as read/unread or delete it.
   * Used by role-scoped PATCH endpoints (teacher, school-admin).
   * The caller must verify the notification belongs to userId before calling.
   */
  async markNotification(
    userId: number,
    notificationId: string,
    action: { is_read?: boolean; deleted?: boolean },
  ): Promise<{ success: boolean }> {
    const n = await this.db.notification.findFirst({
      where: { id: notificationId, userId },
    });
    if (!n) throw new BadRequestException('Notification not found');

    if (action.deleted) {
      await this.db.notification.update({
        where: { id: notificationId },
        data: { deletedAt: new Date() },
      });
      if (n.readAt == null) {
        const unreadCount = await this.getUnreadCount(userId);
        this.realtimeGateway.emitUnreadCount(userId, unreadCount);
      }
      return { success: true };
    }

    if (action.is_read !== undefined) {
      await this.db.notification.update({
        where: { id: notificationId },
        data: { readAt: action.is_read ? new Date() : null },
      });
      if (action.is_read) {
        const unreadCount = await this.getUnreadCount(userId);
        this.realtimeGateway.emitNotificationRead(userId, {
          notification_id: notificationId,
          mark_all: false,
          read_at: new Date().toISOString(),
        });
        this.realtimeGateway.emitUnreadCount(userId, unreadCount);
      } else {
        const unreadCount = await this.getUnreadCount(userId);
        this.realtimeGateway.emitUnreadCount(userId, unreadCount);
      }
    }

    return { success: true };
  }

  // ─── Replies ──────────────────────────────────────────────────────────────

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
      select: { userId: true, senderId: true, allowReplies: true },
    });
    if (!notification) throw new BadRequestException('Notification not found');
    const canReply =
      notification.userId === currentUserId ||
      (notification.senderId != null &&
        notification.senderId === currentUserId);
    if (!canReply)
      throw new ForbiddenException('Cannot reply to this notification');
    if (!notification.allowReplies)
      throw new ForbiddenException('Replies are disabled for this notification');

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

  // ─── Legacy compat (used by internal services: batchGrade, courses, etc.) ─

  /** @deprecated Use sendOne() instead */
  async create(
    userId: number,
    data: {
      title: string;
      message: string;
      type?: string;
      senderId?: number;
      allowReplies?: boolean;
    },
  ): Promise<NotificationDto> {
    return this.sendOne(data.senderId ?? userId, userId, data);
  }
}
