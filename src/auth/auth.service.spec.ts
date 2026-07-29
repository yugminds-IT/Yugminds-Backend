import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { DatabaseService } from '../database/database.service';
import { RealtimeGateway } from '../common/realtime/realtime.gateway';
import { AuthCacheService } from './auth-cache.service';
import { RefreshTokenStoreService } from './refresh-token-store.service';
import { SystemControlsService } from '../admin/system-controls/system-controls.service';

describe('AuthService', () => {
  let service: AuthService;

  const mockDb: {
    user: { findUnique: jest.Mock; update: jest.Mock };
  } = {
    user: { findUnique: jest.fn(), update: jest.fn() },
  };
  const mockJwtService = {
    sign: jest.fn(),
    signAsync: jest.fn(),
    verify: jest.fn(),
    verifyAsync: jest.fn(),
  };
  const mockConfigService = {
    get: jest.fn((key: string) =>
      key === 'JWT_ACCESS_SECRET' ? 'test-secret' : undefined,
    ),
  };
  const mockRealtimeGateway = {
    emitDashboardStatsForUser: jest.fn(),
    emitDashboardStatsForUsers: jest.fn(),
    emitNotificationNew: jest.fn(),
    emitNotificationRead: jest.fn(),
    emitUnreadCount: jest.fn(),
  };
  const mockAuthCache = {
    get: jest.fn(),
    set: jest.fn(),
    invalidate: jest.fn(),
  };
  const mockRefreshTokenStore = {
    store: jest.fn(),
    findMatch: jest.fn(),
    revoke: jest.fn(),
    revokeAll: jest.fn(),
  };
  const mockSystemControls = {
    isMaintenanceActive: jest.fn().mockResolvedValue({ active: false, message: '' }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DatabaseService, useValue: mockDb },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: RealtimeGateway, useValue: mockRealtimeGateway },
        { provide: AuthCacheService, useValue: mockAuthCache },
        { provide: RefreshTokenStoreService, useValue: mockRefreshTokenStore },
        { provide: SystemControlsService, useValue: mockSystemControls },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('updatePassword — server-side complexity enforcement', () => {
    const userId = 1;
    let currentPasswordHash: string;

    beforeEach(async () => {
      currentPasswordHash = await bcrypt.hash('CurrentPass1', 10);
      mockDb.user.findUnique.mockReset().mockResolvedValue({
        id: userId,
        password: currentPasswordHash,
        mustChangePassword: false,
      });
      mockDb.user.update.mockReset().mockResolvedValue({});
    });

    it('accepts a password satisfying all complexity rules', async () => {
      await expect(
        service.updatePassword(userId, 'CurrentPass1', 'NewPass123'),
      ).resolves.toBeUndefined();
      expect(mockDb.user.update).toHaveBeenCalled();
      expect(mockRefreshTokenStore.revokeAll).toHaveBeenCalledWith(userId);
    });

    it('rejects a password missing an uppercase letter (matches client-side rule)', async () => {
      await expect(
        service.updatePassword(userId, 'CurrentPass1', 'newpass123'),
      ).rejects.toThrow(BadRequestException);
      expect(mockDb.user.update).not.toHaveBeenCalled();
    });

    it('rejects a password missing a lowercase letter', async () => {
      await expect(
        service.updatePassword(userId, 'CurrentPass1', 'NEWPASS123'),
      ).rejects.toThrow(BadRequestException);
      expect(mockDb.user.update).not.toHaveBeenCalled();
    });

    it('rejects a password missing a digit', async () => {
      await expect(
        service.updatePassword(userId, 'CurrentPass1', 'NewPassword'),
      ).rejects.toThrow(BadRequestException);
      expect(mockDb.user.update).not.toHaveBeenCalled();
    });

    it('still rejects an incorrect current password before complexity is even relevant', async () => {
      await expect(
        service.updatePassword(userId, 'WrongCurrent1', 'NewPass123'),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockDb.user.update).not.toHaveBeenCalled();
    });
  });
});
