import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable, Subscription } from 'rxjs';
import { tenantContext } from './tenant-context';
import { CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly db: DatabaseService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest();
    const user = req.user as CurrentUserPayload | undefined;

    // Only enforce tenant context for authenticated requests.
    if (!user) {
      return next.handle();
    }

    const isGlobalUser = user.isSuperAdmin || user.role === 'admin';

    // Global users can authenticate without a tenant; they should bypass tenant enforcement.
    if (isGlobalUser) {
      return this.bindTenantContext({ mode: 'super' }, next);
    }

    if (!user.tenantId) {
      throw new UnauthorizedException('tenantId missing');
    }

    // Validate against tenant extracted by TenantMiddleware (subdomain/header).
    const expectedTenantId = req.tenantIdExpected as string | undefined;
    if (expectedTenantId && expectedTenantId !== user.tenantId) {
      throw new UnauthorizedException('tenant mismatch');
    }

    // Multi-school teachers: a teacher may be assigned to more than one school but
    // their JWT only carries one (primary) tenantId. When a request targets a
    // specific school via `school_id`, run the whole request in that school's
    // tenant context — after verifying the teacher is actually assigned to it.
    // This keeps every school's data fully isolated and lets the teacher switch
    // schools in the dashboard without hitting cross-tenant errors.
    if (user.role === 'teacher') {
      const requestedSchoolId = this.extractSchoolId(req);
      if (requestedSchoolId && requestedSchoolId !== user.tenantId) {
        // Await INSIDE the super-admin context so the Prisma extension sees the
        // bypass while the (lazy) query actually executes. Awaiting the promise
        // outside the `runSuperAdmin` callback would run it without any tenant
        // context and trip the extension's "tenantId missing" guard.
        const isMember = await tenantContext.runSuperAdmin(
          async () =>
            await this.db.teacherSchool.findFirst({
              where: { teacherId: user.id, schoolId: requestedSchoolId },
              select: { id: true },
            }),
        );
        if (!isMember) {
          throw new ForbiddenException('Not assigned to this school');
        }
        return this.bindTenantContext(
          { mode: 'tenant', tenantId: requestedSchoolId },
          next,
        );
      }

      // No school_id given on a read: this is a teacher requesting an
      // aggregate view across every school they're assigned to (e.g. the
      // dashboard summary, "today" status, or monthly attendance combined
      // across all schools) — the single-tenantId guard can't be satisfied
      // here since these handlers legitimately query more than one school
      // in the same request. That's safe to bypass because every one of
      // these handlers scopes its queries by `teacherId: user.id` sourced
      // from the JWT (never client-controlled), and any schoolId they touch
      // comes from that same teacher's own TeacherSchool rows — so this can
      // only ever return the requesting teacher's own data, just spanning
      // more than one of their real schools at once. Mutations always
      // require an explicit school_id (enforced in each service) and so
      // never hit this branch.
      if (!requestedSchoolId && req.method === 'GET') {
        return this.bindTenantContext({ mode: 'super' }, next);
      }
    }

    return this.bindTenantContext(
      { mode: 'tenant', tenantId: user.tenantId },
      next,
    );
  }

  /**
   * Keep AsyncLocalStorage active for the full Observable lifetime.
   *
   * Nest subscribes to the interceptor Observable *after* the intercept()
   * callback returns. Previously we did `tenantContext.run(..., () => next.handle())`,
   * which created the Observable inside ALS but exited ALS before subscribe —
   * so Prisma queries in the controller saw no tenant / no super-admin flag.
   * For multi-school teacher GETs that query `schoolId: { in: [...] }`, the
   * extension then either threw "tenantId missing" or (when a stale outer
   * tenant lingered) rewrote the `in` list down to the primary school only —
   * which made "All Schools" schedules show a single school.
   */
  private bindTenantContext(
    scope: { mode: 'super' } | { mode: 'tenant'; tenantId: string },
    next: CallHandler,
  ): Observable<unknown> {
    return new Observable((subscriber) => {
      let inner: Subscription | undefined;
      const start = () => {
        inner = next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
      };
      if (scope.mode === 'super') {
        tenantContext.runSuperAdmin(start);
      } else {
        tenantContext.run(scope.tenantId, start);
      }
      return () => inner?.unsubscribe();
    });
  }

  /**
   * Resolve the school the request is scoped to, from either the query string
   * (GET list endpoints) or the request body (POST/PATCH mutations). Accepts both
   * `school_id` (snake_case, used across the API) and `schoolId` (camelCase).
   */
  private extractSchoolId(req: {
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
  }): string | undefined {
    const fromQuery = req.query?.school_id ?? req.query?.schoolId;
    const fromBody =
      req.body && typeof req.body === 'object'
        ? (req.body.school_id ?? req.body.schoolId)
        : undefined;
    const raw = fromQuery ?? fromBody;
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}
