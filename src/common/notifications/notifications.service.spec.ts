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
      createMany: jest.Mock;
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
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
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

  describe('listWithProfiles', () => {
    const baseRow = {
      id: 'n1',
      userId: 1,
      senderId: null as number | null,
      title: 'Weekly platform digest — Jul 27',
      message: 'This week on Yugminds...',
      mode: 'system_alert',
      allowReplies: false,
      readAt: null as Date | null,
      broadcastId: null as string | null,
      createdAt: new Date('2026-07-27T08:00:00Z'),
      user: { id: 1, email: 'admin@yugminds.com', role: 'admin', profile: { fullName: 'Admin' } },
      sender: null as unknown,
      _count: { replies: 0 },
    };

    it('paginates using offset/limit and returns the total row count', async () => {
      db.notification.count.mockResolvedValue(42);
      db.notification.findMany.mockResolvedValue([baseRow]);

      const { items, total } = await service.listWithProfiles(1, {
        mode: 'received',
        limit: 20,
        offset: 20,
      });

      expect(total).toBe(42);
      expect(items).toHaveLength(1);
      expect(db.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 20 }),
      );
    });

    it('applies a search filter across title and message server-side', async () => {
      db.notification.findMany.mockResolvedValue([]);

      await service.listWithProfiles(1, { mode: 'received', limit: 20, search: 'digest' });

      expect(db.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { title: { contains: 'digest', mode: 'insensitive' } },
              { message: { contains: 'digest', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('applies a read/unread status filter for received mode', async () => {
      db.notification.findMany.mockResolvedValue([]);

      await service.listWithProfiles(1, { mode: 'received', limit: 20, status: 'unread' });

      expect(db.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ readAt: null }) }),
      );
    });

    it('falls back to a synthetic "System" sender profile for null-sender received notifications', async () => {
      db.notification.findMany.mockResolvedValue([{ ...baseRow, sender: null }]);

      const { items } = await service.listWithProfiles(1, { mode: 'received', limit: 20 });

      expect(items[0].profiles).toEqual(
        expect.objectContaining({ full_name: 'Yugminds System', role: 'system' }),
      );
    });

    it('does not synthesize a sender profile in sent mode (recipient profile always exists)', async () => {
      db.notification.findMany.mockResolvedValue([{ ...baseRow, user: null as unknown }]);

      const { items } = await service.listWithProfiles(1, { mode: 'sent', limit: 20 });

      expect(items[0].profiles).toBeUndefined();
    });

    it('exposes broadcast_id on each row for client-side fan-out grouping', async () => {
      db.notification.findMany.mockResolvedValue([{ ...baseRow, broadcastId: 'b-1' }]);

      const { items } = await service.listWithProfiles(1, { mode: 'sent', limit: 20 });

      expect(items[0].broadcast_id).toBe('b-1');
    });
  });

  describe('sendBroadcast', () => {
    it('stamps every created row with the same broadcastId', async () => {
      db.notification.findMany.mockResolvedValue([
        { id: 'a', userId: 2, title: 'T', message: 'M', mode: 'general', allowReplies: true, createdAt: new Date() },
        { id: 'b', userId: 3, title: 'T', message: 'M', mode: 'general', allowReplies: true, createdAt: new Date() },
      ]);

      await service.sendBroadcast(1, [2, 3], { title: 'T', message: 'M' });

      const createManyArg = db.notification.createMany.mock.calls[0][0];
      const broadcastIds = new Set(
        (createManyArg.data as Array<{ broadcastId: string }>).map((d) => d.broadcastId),
      );
      expect(broadcastIds.size).toBe(1);
      expect([...broadcastIds][0]).toEqual(expect.any(String));
    });
  });
});
