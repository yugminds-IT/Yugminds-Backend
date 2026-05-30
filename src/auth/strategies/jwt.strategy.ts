import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { DatabaseService } from '../../database/database.service';
import { Role } from '../types/role.type';

export interface JwtPayload {
  sub: number;
  email: string;
  role: Role;
  isSuperAdmin: boolean;
  tokenVersion?: number;
  tenantId?: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
  ) {
    const accessSecret = config.get<string>('JWT_ACCESS_SECRET');
    if (!accessSecret || !String(accessSecret).trim()) {
      throw new Error('Missing required env var: JWT_ACCESS_SECRET');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: String(accessSecret),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await (this.db as any).user.findUnique({
      where: { id: payload.sub },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Strict multi-tenant requirement: non-global users must have tenantId.
    // Global admins are allowed to authenticate without tenant scoping.
    const isGlobalUser = user.isSuperAdmin || user.role === 'admin';
    if (!user.tenantId && !isGlobalUser) {
      throw new UnauthorizedException('tenantId missing');
    }

    // Enforce access-token invalidation via tokenVersion.
    // Missing claim (old tokens) is treated as version 0.
    const jwtTokenVersion = payload.tokenVersion ?? 0;
    if (jwtTokenVersion !== user.tokenVersion) {
      throw new UnauthorizedException('Access token invalidated');
    }
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      isSuperAdmin: user.isSuperAdmin,
      tenantId: user.tenantId ?? undefined,
    };
  }
}
