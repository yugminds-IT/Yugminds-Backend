import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { AuditService, sanitizePayload } from './audit.service';
import { IMPERSONATED_BY } from './audit.constants';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import type { CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import type { Prisma } from '@prisma/client';
import type { Role } from '../../auth/types/role.type';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Admin URL prefixes whose mutations are always audit-logged, signed in or not. */
const AUDITED_PREFIXES = ['/admin'];

/** Never audited: noise, self-referential, or already recorded somewhere better. */
const NEVER_AUDITED = [
  /^\/admin\/warm-cache/,
  /^\/admin\/refresh-dashboard-views/,
  /^\/auth\//, // sign-ins, refresh and logout have their own record (AuthActivity and sessions)
  /^\/notifications\/user/, // marking your own notifications read or deleting them is noise
  /^\/student\/(simple-progress|save-chapter-progress|last-viewed)/, // autosave while a lesson plays
  /^\/contact/, // the public website forms
];

/**
 * Students can do a lot of small things; only the ones that matter are recorded:
 * handing in work, asking for a retake, certificates, and messages to teachers.
 */
const STUDENT_AUDITED = [
  /^\/student\/(assignments|certificates|notifications)/,
  /^\/notifications\/reply/,
];

/** Roles whose changes outside the admin area are recorded. */
const SIGNED_IN_ROLES = new Set([
  'admin',
  'school_admin',
  'teacher',
  'student',
]);

const SCHOOL_ID = /^[0-9a-f-]{36}$/i;
const MAX_PAYLOAD_CHARS = 8000;

/** "/admin/students/42/enroll" → { entityType: "students", entityId: "42" } */
function parseEntity(path: string): {
  entityType: string | null;
  entityId: string | null;
} {
  const parts = path.split('?')[0].split('/').filter(Boolean); // ["admin", "students", "42", ...]
  if (parts.length < 2) return { entityType: null, entityId: null };
  return { entityType: parts[1] ?? null, entityId: parts[2] ?? null };
}

/**
 * Should this request be written to the audit log?
 * Admin-area changes always are. Anywhere else, changes by a signed-in school admin, teacher or admin are,
 * and for students only the meaningful actions (see STUDENT_AUDITED). Reads are never recorded.
 */
export function shouldAudit(
  req: { method?: string; user?: { role?: string } | null },
  path: string,
  adminGated: boolean,
): boolean {
  if (!MUTATING_METHODS.has(String(req.method))) return false;
  if (NEVER_AUDITED.some((rx) => rx.test(path))) return false;
  if (AUDITED_PREFIXES.some((p) => path.startsWith(p)) || adminGated)
    return true;
  const role = req.user?.role;
  if (!role || !SIGNED_IN_ROLES.has(role)) return false;
  return role !== 'student' || STUDENT_AUDITED.some((rx) => rx.test(path));
}

/**
 * The school an action was for. A school admin or student has one school. A teacher's is the one named in the
 * request, else their main school. An admin only has one when the request names it (or it is a school itself).
 * Anything that is not a real school id is ignored.
 */
export function schoolOf(
  req: {
    body?: unknown;
    query?: Record<string, unknown>;
    user?: { role?: string; tenantId?: string | null } | null;
  },
  entityType: string | null,
  entityId: string | null,
): string | null {
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const named =
    text(body.school_id) ||
    text(body.schoolId) ||
    text(req.query?.school_id) ||
    (entityType === 'schools' ? text(entityId) : '');
  const own = text(req.user?.tenantId);
  const role = req.user?.role;
  const pick =
    role === 'school_admin' || role === 'student'
      ? own
      : role === 'teacher'
        ? named || own
        : named;
  return SCHOOL_ID.test(pick) ? pick : null;
}

/** What gets stored of the request body: nothing for students, a cleaned and size-capped copy for everyone else. */
export function payloadFor(role: string | undefined, body: unknown): unknown {
  if (role === 'student') return null;
  const clean = sanitizePayload(body);
  const size = JSON.stringify(clean ?? null).length;
  if (size <= MAX_PAYLOAD_CHARS) return clean;
  const keys =
    clean && typeof clean === 'object' && !Array.isArray(clean)
      ? Object.keys(clean as Record<string, unknown>).slice(0, 40)
      : [];
  return { truncated: true, size, keys };
}

/** Adds the admin's id to the stored payload when the request was made while impersonating someone. */
export function withImpersonator(
  payload: unknown,
  impersonatorId?: number,
): unknown {
  if (impersonatorId == null) return payload;
  const base =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : payload == null
        ? {}
        : { value: payload };
  return { ...base, [IMPERSONATED_BY]: impersonatorId };
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly audit: AuditService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: CurrentUserPayload }>();
    const path = req.originalUrl ?? req.url ?? '';

    // Path-prefix match covers everything today, but is a silent coverage
    // gap waiting to happen — a future admin-only mutation mounted outside
    // `/admin/...` would otherwise never get audited. Also catch any route
    // whose own @Roles() metadata requires the admin role, regardless of
    // its URL, so moving/adding a controller can never quietly drop out of
    // the audit trail.
    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const isAdminGated = !!requiredRoles?.includes('admin');

    if (!shouldAudit(req, path, isAdminGated)) return next.handle();

    const { entityType, entityId } = parseEntity(path);
    const base = {
      actorId: req.user?.id ?? null,
      actorEmail: req.user?.email ?? null,
      actorRole: req.user?.role ?? null,
      schoolId: schoolOf(req, entityType, entityId),
      method: req.method,
      path: path.split('?')[0],
      entityType,
      entityId,
      payload: withImpersonator(
        payloadFor(req.user?.role, req.body),
        req.user?.impersonatorId,
      ) as Prisma.InputJsonValue,
      ipAddress:
        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
        req.ip ??
        null,
      userAgent: (req.headers['user-agent'] as string) ?? null,
    };

    return next.handle().pipe(
      tap({
        next: () => {
          const res = context.switchToHttp().getResponse<Response>();
          this.audit.record({
            ...base,
            statusCode: res.statusCode,
            success: true,
          });
        },
        error: (err: { status?: number }) => {
          this.audit.record({
            ...base,
            statusCode: typeof err?.status === 'number' ? err.status : 500,
            success: false,
          });
        },
      }),
    );
  }
}
