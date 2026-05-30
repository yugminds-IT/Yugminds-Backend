import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import type { Request, Response, NextFunction } from 'express';

/**
 * Extract tenant identifier from:
 * - subdomain (e.g. tenant.example.com -> tenant)
 * - header (TENANT_HEADER, default configured in Yugminds Backend/.env)
 *
 * It does NOT validate against the user directly (that happens later in `TenantContextInterceptor`,
 * once `request.user` exists via JWT).
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const headerName = String(
      this.config.get<string>('TENANT_HEADER') ?? 'x-tenant-id',
    ).trim();

    const hostHeader = req.headers.host ?? '';
    const host = String(hostHeader).split(':')[0]; // strip port

    // subdomain extraction: tenant.example.com => tenant
    const hostnameParts = host.split('.').filter(Boolean);
    const subdomainTenant = hostnameParts.length >= 3 ? hostnameParts[0] : null;

    // header tenant extraction: accept either tenantId (uuid) or tenant domain slug
    const headerTenant = req.headers[headerName]
      ? String(req.headers[headerName])
      : null;

    const tenantKey = (headerTenant ?? subdomainTenant ?? '').trim();
    if (!tenantKey) {
      // Leave undefined; interceptor will decide how strict to be.
      (req as any).tenantIdExpected = undefined;
      return next();
    }

    // If it looks like a UUID, treat it as tenantId directly.
    const looksLikeUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        tenantKey,
      );

    const expectedTenantId = looksLikeUuid
      ? tenantKey
      : (
          await this.db.tenant.findUnique({
            where: { domain: tenantKey },
            select: { id: true },
          })
        )?.id;

    if (!expectedTenantId) {
      throw new UnauthorizedException('Invalid tenant');
    }

    (req as any).tenantIdExpected = expectedTenantId;
    next();
  }
}
