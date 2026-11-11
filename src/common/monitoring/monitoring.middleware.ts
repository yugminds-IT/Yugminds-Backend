import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MonitoringRole, MonitoringService } from './monitoring.service';

function sanitizePath(path: string): string {
  // Strip query string
  const base = (path || '').split('?')[0] || '/';
  // Collapse IDs (numbers/uuids) to reduce cardinality
  return base
    .replace(/\b\d+\b/g, ':id')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      ':uuid',
    );
}

// The monitoring page's own polling would inflate the very traffic it is watching. Excluded by sanitized
// path, not raw path, so query strings don't let it slip through.
const EXCLUDED_ENDPOINTS = new Set([
  '/admin/monitoring-dashboard',
  '/admin/monitoring-history',
]);

const DASHBOARD_ROLES: Record<string, MonitoringRole> = {
  admin: 'admin',
  school_admin: 'school_admin',
  teacher: 'teacher',
  student: 'student',
};
const SCHOOL_ID = /^[0-9a-f-]{36}$/i;

/**
 * Who is asking, and for which school. Anyone without a signed-in dashboard user is "public" (login, the
 * website, the contact form). A teacher's school is the one they asked for, else their main school; school
 * admins and students have one school. Anything that is not a real school id is ignored, so a caller cannot
 * invent new labels.
 */
export function whoOf(req: any): { role: MonitoringRole; schoolId: string } {
  const role = DASHBOARD_ROLES[String(req?.user?.role ?? '')] ?? 'public';
  if (role === 'public') return { role, schoolId: '' };
  const asked =
    typeof req?.query?.school_id === 'string' ? req.query.school_id : '';
  const own = typeof req?.user?.tenantId === 'string' ? req.user.tenantId : '';
  const pick =
    role === 'admin' ? asked : role === 'teacher' ? asked || own : own;
  return { role, schoolId: SCHOOL_ID.test(pick) ? pick : '' };
}

/**
 * Counts every request the API answers. This is a middleware, not an interceptor, on purpose: interceptors
 * run after the security guards, so requests the guards turn away (expired sessions, the wrong role, rate
 * limits) and requests for pages that do not exist would never be counted, and those are exactly the
 * failures worth seeing.
 *
 * The request is recorded when the response has really been sent ('finish'), so the status code is the final
 * one. By then the guards have attached the user, so the role and school are known.
 */
@Injectable()
export class MonitoringMiddleware implements NestMiddleware {
  constructor(private readonly monitoring: MonitoringService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const method = String(req.method || 'GET');
    const url = String(req.originalUrl || req.url || '/');
    // Browser preflight checks are not real traffic, and the monitoring page's own polling is left out.
    if (method === 'OPTIONS' || EXCLUDED_ENDPOINTS.has(sanitizePath(url))) {
      return next();
    }

    const start = Date.now();
    res.on('finish', () => {
      const r = req as Request & { user?: { id?: number | string } };
      const { role, schoolId } = whoOf(r);
      // Label by the matched route template (bounded set), never by raw path text:
      // anonymous clients control the raw path and could otherwise mint unlimited keys.
      const routePath = r.route?.path;
      this.monitoring.record({
        endpoint: routePath ? String(routePath) : '(unmatched)',
        method,
        duration: Date.now() - start,
        statusCode: Number(res.statusCode) || 200,
        timestamp: Date.now(),
        userId: r.user?.id != null ? String(r.user.id) : undefined,
        role,
        schoolId,
      });
    });
    next();
  }
}
