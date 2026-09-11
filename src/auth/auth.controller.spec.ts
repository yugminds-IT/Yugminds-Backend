import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  let controller: AuthController;

  const mockAuthService = {
    signup: jest.fn(),
    login: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn(),
  };
  const mockConfigService = {
    get: jest.fn((key: string) =>
      key === 'REFRESH_TOKEN_EXPIRY' ? '7d' : undefined,
    ),
  };

  const mockRes = () => ({ cookie: jest.fn(), clearCookie: jest.fn() });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockConfigService.get.mockImplementation((key: string) =>
      key === 'REFRESH_TOKEN_EXPIRY' ? '7d' : undefined,
    );
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('login', () => {
    it('sets an httpOnly refresh cookie and omits refreshToken from the JSON body', async () => {
      mockAuthService.login.mockResolvedValue({
        user: { id: 1, email: 'a@b.c', role: 'admin' },
        tokens: { accessToken: 'access', refreshToken: 'secret-refresh' },
      });
      const res = mockRes();

      const result = await controller.login(
        { email: 'a@b.c', password: 'x' } as never,
        res as never,
      );

      expect(res.cookie).toHaveBeenCalledWith(
        'refresh_token',
        'secret-refresh',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
          maxAge: 7 * 24 * 60 * 60 * 1000,
        }),
      );
      expect(result.tokens).toEqual({ accessToken: 'access' });
      expect(
        (result.tokens as { refreshToken?: string }).refreshToken,
      ).toBeUndefined();
    });
  });

  describe('refresh', () => {
    const rotated = {
      tokens: { accessToken: 'new-access', refreshToken: 'rotated-refresh' },
    };

    it('accepts a token in the body when the cookie is missing', async () => {
      mockAuthService.refresh.mockResolvedValue(rotated);
      const req = { cookies: {}, body: { refreshToken: 'old-refresh' } };
      const res = mockRes();

      await controller.refresh(req as never, res as never);

      expect(mockAuthService.refresh).toHaveBeenCalledWith('old-refresh');
      expect(res.cookie).toHaveBeenCalledWith(
        'refresh_token',
        'rotated-refresh',
        expect.objectContaining({ httpOnly: true }),
      );
    });

    it('accepts snake_case refresh_token in the body (BFF payload)', async () => {
      mockAuthService.refresh.mockResolvedValue(rotated);
      const req = { cookies: {}, body: { refresh_token: 'from-bff' } };
      const res = mockRes();

      await controller.refresh(req as never, res as never);

      expect(mockAuthService.refresh).toHaveBeenCalledWith('from-bff');
    });

    it('prefers the cookie over a body token', async () => {
      mockAuthService.refresh.mockResolvedValue(rotated);
      const req = {
        cookies: { refresh_token: 'from-cookie' },
        body: { refreshToken: 'from-body' },
      };
      const res = mockRes();

      await controller.refresh(req as never, res as never);

      expect(mockAuthService.refresh).toHaveBeenCalledWith('from-cookie');
    });

    it('rejects and clears the cookie when neither cookie nor body has a token', async () => {
      const req = { cookies: {}, body: {} };
      const res = mockRes();

      await expect(
        controller.refresh(req as never, res as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mockAuthService.refresh).not.toHaveBeenCalled();
      expect(res.clearCookie).toHaveBeenCalledWith(
        'refresh_token',
        expect.objectContaining({ httpOnly: true }),
      );
    });

    it('clears the cookie when rotation fails', async () => {
      mockAuthService.refresh.mockRejectedValue(
        new UnauthorizedException('Invalid refresh token'),
      );
      const req = { cookies: { refresh_token: 'stale' }, body: {} };
      const res = mockRes();

      await expect(
        controller.refresh(req as never, res as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(res.clearCookie).toHaveBeenCalled();
    });
  });
});
