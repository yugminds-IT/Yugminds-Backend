import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { DatabaseService } from '../../database/database.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let db: {
    notification: {
      count: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
    };
  };

  beforeEach(async () => {
    db = {
      notification: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({
          id: 'new-1',
          title: 'T',
          message: 'M',
          mode: 'general',
          readAt: null,
          createdAt: new Date(),
        }),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: DatabaseService, useValue: db },
        {
          provide: RealtimeGateway,
          useValue: {
            emitNotificationNew: jest.fn(),
            emitNotificationRead: jest.fn(),
            emitUnreadCount: jest.fn(),
            emitDashboardStats: jest.fn(),
            emitDashboardStatsForUser: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getUnreadCount', () => {
    it('should count notifications where userId matches and readAt/deletedAt are null', async () => {
      db.notification.count.mockResolvedValue(2);
      const count = await service.getUnreadCount(1);
      expect(db.notification.count).toHaveBeenCalledWith({
        where: { userId: 1, readAt: null, deletedAt: null },
      });
      expect(count).toBe(2);
    });
  });

  describe('getUserNotifications', () => {
    it('should filter by unread when filter=unread', async () => {
      await service.getUserNotifications(1, { filter: 'unread', limit: 5 });
      expect(db.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 1, deletedAt: null, readAt: null },
          take: 5,
        }),
      );
    });

    it('should cap limit at 100', async () => {
      await service.getUserNotifications(1, { limit: 200 });
      expect(db.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });

  describe('updateUserNotification', () => {
    it('should throw BadRequestException when no valid action in body', async () => {
      await expect(service.updateUserNotification(1, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should update many when mark_all and is_read', async () => {
      await service.updateUserNotification(1, {
        mark_all: true,
        is_read: true,
      });
      expect(db.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: 1, deletedAt: null },
        data: { readAt: expect.any(Date) },
      });
    });

    it('should throw ForbiddenException when notification_id not found for user', async () => {
      db.notification.findFirst.mockResolvedValue(null);
      await expect(
        service.updateUserNotification(1, {
          notification_id: 'n1',
          is_read: true,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
