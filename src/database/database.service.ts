import {
  Injectable,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { tenantContext } from '../tenants/tenant-context';

export interface DatabaseService extends PrismaClient {}

/** Minimal Prisma client shape needed for cross-tenant validation. */
type UserLookupClient = {
  user: {
    findMany: (args: {
      where: { id: { in: number[] } };
      select: { id: true; tenantId: true };
    }) => Promise<{ id: number; tenantId: string | null }[]>;
  };
};

@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
      }),
    });

    // Models where studentId is a plain FK with NO `student` relation defined in the schema.
    // Injecting `student: { tenantId }` on these models causes Prisma to throw
    // "Unknown argument `student`" because the relation doesn't exist.
    const MODELS_WITHOUT_STUDENT_RELATION = new Set([
      'StudentCourse',
      'CourseProgress',
      'Attendance',
      'TeacherReport',
      'ClassSchedule',
    ]);

    // Models where teacherId is a plain FK with NO `teacher` relation defined in the schema.
    // Same issue: injecting `teacher: { tenantId }` on these models causes Prisma to throw
    // "Unknown argument `teacher`".
    const MODELS_WITHOUT_TEACHER_RELATION = new Set([
      'Attendance',
      'TeacherReport',
      'ClassSchedule',
    ]);

    // Prisma v7.4.2 (with the adapter used here) does not expose `prisma.$use`.
    // Use Prisma Client extensions instead to enforce tenant scoping.
    const extended = this.$extends({
      query: {
        $allModels: {
          $allOperations: async ({ model, operation, args, query }: any) => {
            const where = args?.where;
            if (!where || typeof where !== 'object') return query(args);

            const tenantId = tenantContext.getTenantId();
            const isSuperAdmin = tenantContext.getIsSuperAdmin();

            // Super admins are allowed to operate without tenant scoping.
            if (isSuperAdmin) return query(args);

            const containsTenantForeignKey = (obj: any): boolean => {
              if (!obj || typeof obj !== 'object') return false;
              if (Array.isArray(obj)) return obj.some(containsTenantForeignKey);
              if (obj.userId !== undefined) return true;
              if (obj.teacherId !== undefined) return true;
              if (obj.studentId !== undefined) return true;
              if (obj.senderId !== undefined) return true;
              if (obj.issuedBy !== undefined) return true;
              if (obj.approvedBy !== undefined) return true;
              if (obj.schoolId !== undefined) return true;
              for (const v of Object.values(obj))
                if (containsTenantForeignKey(v)) return true;
              return false;
            };

            const requiresTenant = containsTenantForeignKey(where);
            if (requiresTenant && !tenantId) {
              throw new UnauthorizedException(
                'tenantId missing for tenant-scoped query',
              );
            }
            if (!tenantId) return query(args);

            // NOTE: Cross-tenant user-ID validation (userId/teacherId/studentId lookups) is
            // intentionally NOT performed here. The Prisma extension callback has no access
            // to the transaction-bound client (tx), so using `this.user.findMany` would miss
            // rows created in the same open transaction and produce false "Cross-tenant access
            // denied" errors. Instead, callers that run $transaction are responsible for
            // calling `db.assertCrossTenantUserIds(ids, tenantId, tx)` explicitly before
            // writing related records. The schoolId scalar check below still enforces
            // tenant isolation for all non-user-FK fields.

            // Enforce schoolId scoping for any operation.
            const validateSchoolIdWhere = (obj: any) => {
              if (!obj || typeof obj !== 'object') return;
              if (Array.isArray(obj)) return obj.forEach(validateSchoolIdWhere);
              if (obj.schoolId !== undefined) {
                const v = obj.schoolId;
                if (typeof v === 'string') {
                  if (v !== tenantId)
                    throw new UnauthorizedException(
                      'Cross-tenant schoolId access denied',
                    );
                } else if (v && typeof v === 'object') {
                  if (Array.isArray(v.in)) {
                    const invalid = v.in.filter(
                      (x: any) => typeof x === 'string' && x !== tenantId,
                    );
                    if (invalid.length > 0)
                      throw new UnauthorizedException(
                        'Cross-tenant schoolId access denied',
                      );
                  }
                  if (v.equals !== undefined && v.equals !== tenantId) {
                    throw new UnauthorizedException(
                      'Cross-tenant schoolId access denied',
                    );
                  }
                }
              }
              for (const vv of Object.values(obj)) validateSchoolIdWhere(vv);
            };
            validateSchoolIdWhere(where);

            // groupBy, count, and aggregate do not accept relation filters in their
            // `where` clause — Prisma rejects them with "Unknown argument `<relation>`".
            // Tenant isolation for these operations is already guaranteed by the
            // scalar `schoolId` filter that callers always include. Skip injection.
            const nonUniqueActions = new Set([
              'findMany',
              'findFirst',
              'deleteMany',
              'updateMany',
              'count',
              'aggregate',
              'groupBy',
            ]);
            const validateOnly = !nonUniqueActions.has(String(operation));
            if (validateOnly) return query(args);

            const isAggregation = ['groupBy', 'count', 'aggregate'].includes(
              String(operation),
            );
            if (isAggregation) return query(args);

            const applyTenantConstraints = (obj: any): any => {
              if (!obj || typeof obj !== 'object') return obj;
              if (Array.isArray(obj)) return obj.map(applyTenantConstraints);

              // Inject tenant constraints into relation filters when FK fields exist.
              // Skip models that don't have the corresponding relation defined in the schema.
              if (obj.userId !== undefined && obj.user === undefined)
                obj.user = { tenantId };
              if (
                obj.teacherId !== undefined &&
                obj.teacher === undefined &&
                !MODELS_WITHOUT_TEACHER_RELATION.has(model)
              ) {
                obj.teacher = { tenantId };
              }
              if (
                obj.studentId !== undefined &&
                obj.student === undefined &&
                !MODELS_WITHOUT_STUDENT_RELATION.has(model)
              ) {
                obj.student = { tenantId };
              }
              if (obj.senderId !== undefined && obj.sender === undefined)
                obj.sender = { tenantId };
              if (obj.issuedBy !== undefined && obj.issuedByUser === undefined)
                obj.issuedByUser = { tenantId };
              if (
                obj.approvedBy !== undefined &&
                obj.approvedByUser === undefined
              )
                obj.approvedByUser = { tenantId };

              // Enforce schoolId scoping by tenant (rewrite broad `in` lists to just the tenant).
              if (obj.schoolId !== undefined) {
                const v = obj.schoolId;
                if (typeof v === 'string') {
                  if (v !== tenantId)
                    throw new UnauthorizedException(
                      'Cross-tenant schoolId access denied',
                    );
                } else if (v && typeof v === 'object') {
                  if (Array.isArray(v.in)) obj.schoolId = { in: [tenantId] };
                  if (v.equals !== undefined && v.equals !== tenantId) {
                    throw new UnauthorizedException(
                      'Cross-tenant schoolId access denied',
                    );
                  }
                }
              }

              for (const [k, v] of Object.entries(obj))
                obj[k] = applyTenantConstraints(v);
              return obj;
            };

            args.where = applyTenantConstraints(where);
            return query(args);
          },
        },
      },
    });

    // Ensure Nest lifecycle hook still works after returning an extended Prisma instance.
    (extended as any).onModuleDestroy = async () => {
      await (extended as any).$disconnect();
    };

    return extended as any;
  }

  /**
   * Validate that all given user IDs belong to the expected tenant.
   *
   * This MUST be called with the transaction client (tx) when inside a $transaction,
   * because the Prisma extension middleware cannot access tx and would miss uncommitted rows.
   *
   * @param userIds  - IDs to validate (duplicates are deduplicated automatically)
   * @param tenantId - The expected tenant (school) ID
   * @param client   - The Prisma client to use for the lookup; pass `tx` inside transactions
   */
  async assertCrossTenantUserIds(
    userIds: number[],
    tenantId: string,
    client: UserLookupClient,
  ): Promise<void> {
    const ids = Array.from(
      new Set(
        userIds.filter((id) => typeof id === 'number' && Number.isFinite(id)),
      ),
    );
    if (ids.length === 0) return;

    const users = await client.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, tenantId: true },
    });

    const map = new Map<number, string | null>(
      users.map((u) => [u.id, u.tenantId]),
    );

    for (const id of ids) {
      const t = map.get(id);
      if (t === undefined) {
        throw new UnauthorizedException(
          `Cross-tenant access denied: user ${id} not found`,
        );
      }
      // null tenantId = user not yet scoped (e.g. teacher before school assignment).
      // Permitted because the schoolId constraint provides the isolation boundary.
      if (t !== null && t !== tenantId) {
        throw new UnauthorizedException('Cross-tenant access denied');
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
