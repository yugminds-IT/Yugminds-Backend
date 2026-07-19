import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import type { Request, Response, NextFunction } from 'express';
import { isIP } from 'net';

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
    // A bare IPv4 host (e.g. "127.0.0.1", accessed directly by IP — health
    // checks, staging-by-IP, local tooling) also has 4 dot-separated parts
    // and must NOT be mistaken for a 3+-level subdomain, or every request
    // fails with "Invalid tenant" before auth even runs.
    const hostnameParts =
      isIP(host) === 0 ? host.split('.').filter(Boolean) : [];
    const subdomainTenant = hostnameParts.length >= 3 ? hostnameParts[0] : null;

    // header tenant extraction: accept either tenantId (uuid) or tenant domain slug
    const headerTenant = req.headers[headerName]
      ? String(req.headers[headerName])
      : null;

    // Header-based tenant is an explicit, deliberate claim from the caller —
    // failing to resolve it is a real error. Subdomain-based tenant is a
    // heuristic guess (e.g. the app's own host "devbackend.yugminds.org" has
    // 3 dot-separated parts and looks exactly like "<tenant>.yugminds.org",
    // but isn't one) — failing to resolve it must NOT block the request,
    // since `TenantContextInterceptor` only ever treats this value as an
    // optional best-effort cross-check, never a requirement.
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
      if (headerTenant) {
        throw new UnauthorizedException('Invalid tenant');
      }
      // Unresolved subdomain guess — not a real tenant slug, just proceed.
      (req as any).tenantIdExpected = undefined;
      return next();
    }

    (req as any).tenantIdExpected = expectedTenantId;
    next();
  }
}
