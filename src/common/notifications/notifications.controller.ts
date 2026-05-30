import {
  Controller,
  Get,
  Patch,
  Post,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** Lightweight unread count for badge. */
  @SkipThrottle({ default: true })
  @Get('unread-count')
  async getUnreadCount(@CurrentUser() user: { id: number; role: string }) {
    const isAdmin = user.role === 'admin' || user.role === 'super_admin';
    const count = await this.notifications.getUnreadCount(user.id, isAdmin);
    return { count };
  }

  /** List notifications for the current user (filter=all|unread, limit=1..100). */
  @Get('user')
  async getUserNotifications(
    @CurrentUser() user: { id: number },
    @Query('filter') filter?: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit
      ? Math.min(100, Math.max(1, parseInt(limit, 10) || 50))
      : 50;
    const notifications = await this.notifications.getUserNotifications(
      user.id,
      {
        filter: filter === 'unread' ? 'unread' : 'all',
        limit: limitNum,
      },
    );
    return { notifications };
  }

  /** Mark one as read, mark all as read, or soft-delete one. */
  @Patch('user')
  async updateUserNotifications(
    @CurrentUser() user: { id: number },
    @Body()
    body: {
      notification_id?: string;
      user_id?: string;
      is_read?: boolean;
      deleted?: boolean;
      mark_all?: boolean;
    },
  ) {
    return this.notifications.updateUserNotification(user.id, body);
  }

  /** List replies for a notification (caller must be recipient or sender). */
  @Get('reply')
  async getReplies(
    @CurrentUser() user: { id: number },
    @Query('notification_id') notificationId: string,
  ) {
    const replies = await this.notifications.getReplies(
      notificationId ?? '',
      user.id,
    );
    return { replies };
  }

  /** Create a reply to a notification. */
  @Post('reply')
  async createReply(
    @CurrentUser() user: { id: number },
    @Body() body: { notification_id?: string; reply_text?: string },
  ) {
    const reply = await this.notifications.createReply(
      body.notification_id ?? '',
      user.id,
      body.reply_text ?? '',
    );
    return { reply, replies: [reply] };
  }
}
