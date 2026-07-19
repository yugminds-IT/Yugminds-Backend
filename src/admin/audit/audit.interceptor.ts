import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { AuditService, sanitizePayload } from './audit.service';
import type { CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import type { Prisma } from '@prisma/client';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Admin URL prefixes whose mutations are audit-logged. */
const AUDITED_PREFIXES = ['/admin'];

/** Paths that are noisy or self-referential and not worth auditing. */
const SKIPPED_PATHS = [/^\/admin\/warm-cache/, /^\/admin\/refresh-dashboard-views/];

/** "/admin/students/42/enroll" → { entityType: "students", entityId: "42" } */
function parseEntity(path: string): { entityType: string | null; entityId: string | null } {
  const parts = path.split('?')[0].split('/').filter(Boolean); // ["admin", "students", "42", ...]
  if (parts.length < 2) return { entityType: null, entityId: null };
  return { entityType: parts[1] ?? null, entityId: parts[2] ?? null };
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<Request & { user?: CurrentUserPayload }>();
    const path = req.originalUrl ?? req.url ?? '';

    const shouldAudit =
      MUTATING_METHODS.has(req.method) &&
      AUDITED_PREFIXES.some((p) => path.startsWith(p)) &&
      !SKIPPED_PATHS.some((rx) => rx.test(path));

    if (!shouldAudit) return next.handle();

    const { entityType, entityId } = parseEntity(path);
    const base = {
      actorId: req.user?.id ?? null,
      actorEmail: req.user?.email ?? null,
      actorRole: req.user?.role ?? null,
      method: req.method,
      path: path.split('?')[0],
      entityType,
      entityId,
      payload: sanitizePayload(req.body) as Prisma.InputJsonValue,
      ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string) ?? null,
    };

    return next.handle().pipe(
      tap({
        next: () => {
          const res = context.switchToHttp().getResponse<Response>();
          this.audit.record({ ...base, statusCode: res.statusCode, success: true });
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
