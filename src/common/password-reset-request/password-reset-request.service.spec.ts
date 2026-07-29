import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PasswordResetRequestService } from './password-reset-request.service';
import { DatabaseService } from '../../database/database.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { RefreshTokenStoreService } from '../../auth/refresh-token-store.service';

describe('PasswordResetRequestService', () => {
  let service: PasswordResetRequestService;
  let db: {
    passwordResetRequest: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      count: jest.Mock;
    };
    school: { findMany: jest.Mock };
    user: { update: jest.Mock };
    notification: { create: jest.Mock; count: jest.Mock };
  };
  let realtimeGateway: {
    emitNotificationNew: jest.Mock;
    emitUnreadCount: jest.Mock;
    emitDashboardStatsForUser: jest.Mock;
  };
  let refreshTokenStore: { revokeAll: jest.Mock };

  beforeEach(async () => {
    db = {
      passwordResetRequest: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      school: { findMany: jest.fn().mockResolvedValue([]) },
      user: { update: jest.fn().mockResolvedValue({}) },
      notification: {
        create: jest.fn().mockResolvedValue({
          id: 'n1',
          title: 'T',
          message: 'M',
          createdAt: new Date(),
        }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    realtimeGateway = {
      emitNotificationNew: jest.fn(),
      emitUnreadCount: jest.fn(),
      emitDashboardStatsForUser: jest.fn().mockResolvedValue(undefined),
    };
    refreshTokenStore = { revokeAll: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordResetRequestService,
        { provide: DatabaseService, useValue: db },
        { provide: RealtimeGateway, useValue: realtimeGateway },
        { provide: RefreshTokenStoreService, useValue: refreshTokenStore },
      ],
    }).compile();

    service = module.get<PasswordResetRequestService>(
      PasswordResetRequestService,
    );
  });

  describe('list', () => {
    it('paginates using offset/limit and returns the total row count', async () => {
      db.passwordResetRequest.count.mockResolvedValue(42);
      db.passwordResetRequest.findMany.mockResolvedValue([]);

      const { total } = await service.list({ limit: 20, offset: 20 });

      expect(total).toBe(42);
      expect(db.passwordResetRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 20 }),
      );
    });

    it('treats status="resolved" as "anything but pending" (for the History tab)', async () => {
      await service.list({ status: 'resolved', limit: 20 });

      expect(db.passwordResetRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: { not: 'pending' } }),
        }),
      );
    });

    it('applies a plain status filter unchanged', async () => {
      await service.list({ status: 'approved', limit: 20 });

      expect(db.passwordResetRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'approved' }),
        }),
      );
    });

    it('does not filter by status when status is "all"', async () => {
      await service.list({ status: 'all', limit: 20 });

      const where = db.passwordResetRequest.findMany.mock.calls[0][0].where;
      expect(where.status).toBeUndefined();
    });

    it('builds a role/email/school search filter server-side when search is provided', async () => {
      db.school.findMany.mockResolvedValue([{ id: 'school-1', name: 'Sunrise Academy' }]);

      await service.list({ search: 'teach', limit: 20 });

      const where = db.passwordResetRequest.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual(
        expect.arrayContaining([
          { user: { role: { in: ['teacher'] } } },
        ]),
      );
    });
  });

  describe('delete', () => {
    it('throws and does not delete when the request is still pending', async () => {
      db.passwordResetRequest.findUnique.mockResolvedValue({ status: 'pending' });

      await expect(service.delete('r1')).rejects.toThrow(BadRequestException);
      expect(db.passwordResetRequest.delete).not.toHaveBeenCalled();
    });

    it('deletes a resolved (non-pending) request', async () => {
      db.passwordResetRequest.findUnique.mockResolvedValue({ status: 'rejected' });

      await service.delete('r1');

      expect(db.passwordResetRequest.delete).toHaveBeenCalledWith({
        where: { id: 'r1' },
      });
    });

    it('throws when the request does not exist', async () => {
      db.passwordResetRequest.findUnique.mockResolvedValue(null);

      await expect(service.delete('missing')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('update (approve)', () => {
    it('rejects a temp password shorter than 6 characters', async () => {
      db.passwordResetRequest.findUnique.mockResolvedValue({
        id: 'r1',
        userId: 5,
        status: 'pending',
        user: { email: 'a@b.com', profile: { fullName: 'A B' } },
      });

      await expect(
        service.update({ id: 'r1', status: 'approved', temp_password: 'abc' }),
      ).rejects.toThrow(BadRequestException);
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it('hashes and sets the real password, forces a password change, and revokes sessions', async () => {
      db.passwordResetRequest.findUnique.mockResolvedValue({
        id: 'r1',
        userId: 5,
        status: 'pending',
        user: { email: 'a@b.com', profile: { fullName: 'A B' } },
      });

      const result = await service.update({
        id: 'r1',
        status: 'approved',
        temp_password: 'temp1234',
      });

      expect(result.success).toBe(true);
      expect(db.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 5 },
          data: expect.objectContaining({ mustChangePassword: true }),
        }),
      );
      expect(refreshTokenStore.revokeAll).toHaveBeenCalledWith(5);
      expect(db.notification.create).toHaveBeenCalled();
    });

    it('rejects updating a request that is not pending', async () => {
      db.passwordResetRequest.findUnique.mockResolvedValue({
        id: 'r1',
        userId: 5,
        status: 'approved',
        user: { email: 'a@b.com', profile: null },
      });

      await expect(
        service.update({ id: 'r1', status: 'rejected' }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
