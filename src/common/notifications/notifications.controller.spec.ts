import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let service: NotificationsService;

  const mockNotificationsService = {
    getUnreadCount: jest.fn().mockResolvedValue(0),
    getUserNotifications: jest.fn().mockResolvedValue([]),
    updateUserNotification: jest.fn().mockResolvedValue({ success: true }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        {
          provide: NotificationsService,
          useValue: mockNotificationsService,
        },
      ],
    }).compile();

    controller = module.get<NotificationsController>(NotificationsController);
    service = module.get<NotificationsService>(NotificationsService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getUnreadCount', () => {
    it('should return count from service using current user id', async () => {
      const user = { id: 1, role: 'student' };
      mockNotificationsService.getUnreadCount.mockResolvedValue(3);
      const result = await controller.getUnreadCount(user);
      // controller passes (userId, isAdmin) — isAdmin is false for role 'student'
      expect(service.getUnreadCount).toHaveBeenCalledWith(1, false);
      expect(result).toEqual({ count: 3 });
    });
  });

  describe('getUserNotifications', () => {
    it('should return notifications from service with user id and options', async () => {
      const user = { id: 2 };
      const list = [
        {
          id: 'a',
          title: 'T',
          message: 'M',
          type: 'general',
          is_read: false,
          created_at: new Date().toISOString(),
        },
      ];
      mockNotificationsService.getUserNotifications.mockResolvedValue(list);
      const result = await controller.getUserNotifications(
        user,
        'unread',
        '10',
      );
      expect(service.getUserNotifications).toHaveBeenCalledWith(2, {
        filter: 'unread',
        limit: 10,
      });
      expect(result).toEqual({ notifications: list });
    });

    it('should default filter to all and limit to 50 when not provided', async () => {
      const user = { id: 3 };
      mockNotificationsService.getUserNotifications.mockResolvedValue([]);
      await controller.getUserNotifications(user);
      expect(service.getUserNotifications).toHaveBeenCalledWith(3, {
        filter: 'all',
        limit: 50,
      });
    });
  });

  describe('updateUserNotifications', () => {
    it('should call service with user id and body', async () => {
      const user = { id: 4 };
      const body = { notification_id: 'n1', is_read: true };
      await controller.updateUserNotifications(user, body);
      expect(service.updateUserNotification).toHaveBeenCalledWith(4, body);
    });
  });
});
