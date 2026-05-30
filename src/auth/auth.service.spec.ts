import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { DatabaseService } from '../database/database.service';
import { RealtimeGateway } from '../common/realtime/realtime.gateway';

describe('AuthService', () => {
  let service: AuthService;

  const mockDb = {};
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DatabaseService, useValue: mockDb },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: RealtimeGateway, useValue: mockRealtimeGateway },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
