import {
  Injectable,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { tenantContext } from '../tenants/tenant-context';
import { normalizeEmail } from '../common/utils/email.util';
import {
  parseGrade,
  parseStatus,
  parseSubject,
  parseTime,
} from '../common/utils/data-standards.util';
import { parsePhone } from '../common/utils/phone.util';
import { parseSection } from '../common/utils/section-name.util';

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
    // Use an explicit pg.Pool so we control connection pool size.
    // Default Prisma pool (10) is exhausted at ~200 concurrent requests.
    // Rule of thumb: (2 × CPU cores) + effective_spindle_count, capped at 100.
    // DB_POOL_SIZE env lets ops tune without a redeploy.
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_SIZE ?? 25),
      idleTimeoutMillis: 30_000, // release idle connections after 30 s
      connectionTimeoutMillis: 5_000, // fail fast if no connection available
    });

    super({
      adapter: new PrismaPg(pool),
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

    // Multi-school support: a teacher can be assigned to several schools, but
    // User.tenantId only stores ONE (their primary) school. These models DO define
    // a `teacher` relation, but they are already isolated by their own `schoolId`
    // scalar column (the tenant scalar check below enforces it). Injecting
    // `teacher: { tenantId }` here would wrongly filter out a multi-school teacher's
    // rows in any school other than their primary one. Skip the relation injection
    // and rely on the `schoolId` scalar for isolation.
    const MODELS_SKIP_TEACHER_TENANT_INJECTION = new Set([
      'TeacherSchool',
      'TeacherSectionAssignment',
      'TeacherLeave',
      'Assignment',
      'TeacherWorkingDaysHistory',
    ]);

    // Same rationale for the student relation: these models are isolated by their
    // own `schoolId` scalar. (Students normally belong to one school, but this keeps
    // join-table reads consistent with the teacher handling above.)
    const MODELS_SKIP_STUDENT_TENANT_INJECTION = new Set(['StudentSchool']);

    // Notifications are user-to-user objects with NO `schoolId` column. Every
    // controller query pins `userId`/`senderId` to the authenticated user, which IS
    // the isolation boundary. A multi-school teacher's notifications must remain
    // visible regardless of which school they are currently viewing, so injecting
    // `user: { tenantId }` / `sender: { tenantId }` (which would filter by the
    // recipient's primary tenant) is both redundant and harmful here.
    const MODELS_SKIP_USER_TENANT_INJECTION = new Set([
      'Notification',
      'NotificationReply',
    ]);

    // Section names have ONE stored form ("Section A"). Every section value
    // WRITTEN (StudentSchool.section, ClassSchedule.section, TeacherReport.section,
    // CourseAccessSection.sectionName — including nested writes) is validated
    // here and rejected (400) if not standard, so no code path (import, form,
    // API, script) can store "A" / "sec a". Nothing is converted, and filters
    // are not touched: callers must filter by the standard "Section A".
    const JSON_COLUMNS = new Set([
      'answers',
      'attachments',
      'cornerPillars',
      'impactStats',
      'metadata',
      'options',
      'payload',
      'quiz',
      'sectionColors',
      'sectionEnabled',
      'sectionTitles',
      'snapshot',
      'socialLinks',
      'state',
      'workingDaySlots',
    ]);
    // Phones have ONE stored form too ("+919876543210", "-"/blank → null):
    // normalized in place on every write to a phone column, nested writes
    // included. Unparseable numbers are rejected (400) like bad sections.
    const PHONE_KEYS = new Set(['phone', 'parentPhone']);
    // Grades ("Grade 4"), times ("09:05", 24h) and subjects (fixed list) are
    // validated the same way: any string written under these keys, nested
    // writes included, must be exactly the standard or the write is rejected.
    const VALIDATE_KEYS: Record<string, (v: string) => unknown> = {
      section: parseSection,
      sectionName: parseSection,
      grade: parseGrade,
      gradeName: parseGrade,
      startTime: parseTime,
      endTime: parseTime,
      subject: parseSubject,
    };
    const validateSectionIn = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(validateSectionIn);
      for (const [k, v] of Object.entries(node)) {
        if (JSON_COLUMNS.has(k)) continue;
        if (typeof v === 'string' && VALIDATE_KEYS[k]) VALIDATE_KEYS[k](v);
        else if (PHONE_KEYS.has(k) && typeof v === 'string')
          node[k] = parsePhone(v);
        else if (PHONE_KEYS.has(k) && v && typeof (v as any).set === 'string')
          (v as any).set = parsePhone((v as any).set);
        else validateSectionIn(v);
      }
    };
    // `status` columns are enums-in-spirit (see STATUSES); Grade.name and
    // TeacherSchool.subjects are model-specific, so only top-level data is
    // checked here.
    const validateModelFields = (model: string, d: any): void => {
      if (!d || typeof d !== 'object') return;
      if (Array.isArray(d))
        return d.forEach((x) => validateModelFields(model, x));
      const val = (x: any) =>
        x && typeof x === 'object' && !Array.isArray(x) ? x.set : x;
      if (typeof val(d.status) === 'string') parseStatus(model, val(d.status));
      if (model === 'Grade' && typeof val(d.name) === 'string')
        parseGrade(val(d.name));
      if (model === 'TeacherSchool' && Array.isArray(val(d.subjects)))
        val(d.subjects).forEach((x: unknown) => parseSubject(x));
    };

    // Email has ONE stored form (trimmed, lowercase). Applied to every write
    // and to every equality lookup on these models, so login / reset / create
    // duplicate-checks all see the same value no matter how it was typed.
    // (AuthActivity is a historical log and is left as recorded.)
    const EMAIL_MODELS = new Set([
      'User',
      'School',
      'ContactSubmission',
      'AcademyAccount',
    ]);
    const normalizeUserEmailWrite = (d: any): void => {
      if (Array.isArray(d)) return d.forEach(normalizeUserEmailWrite);
      if (d && typeof d.email === 'string') d.email = normalizeEmail(d.email);
    };
    const normalizeUserEmailWhere = (w: any): void => {
      if (!w || typeof w !== 'object') return;
      for (const k of ['AND', 'OR', 'NOT']) {
        const v = w[k];
        if (Array.isArray(v)) v.forEach(normalizeUserEmailWhere);
        else normalizeUserEmailWhere(v);
      }
      const e = w.email;
      if (typeof e === 'string') w.email = normalizeEmail(e);
      else if (e && typeof e === 'object') {
        if (typeof e.equals === 'string') e.equals = normalizeEmail(e.equals);
        if (Array.isArray(e.in)) e.in = e.in.map(normalizeEmail);
      }
    };

    // Prisma v7.4.2 (with the adapter used here) does not expose `prisma.$use`.
    // Use Prisma Client extensions instead to enforce tenant scoping.
    const extended = this.$extends({
      query: {
        $allModels: {
          $allOperations: ({ model, operation, args, query }: any) => {
            if (args && EMAIL_MODELS.has(model)) {
              normalizeUserEmailWrite(args.data);
              normalizeUserEmailWrite(args.create);
              normalizeUserEmailWrite(args.update);
              normalizeUserEmailWhere(args.where);
            }
            if (args) {
              validateSectionIn(args.data);
              validateSectionIn(args.create);
              validateSectionIn(args.update);
              validateModelFields(model, args.data);
              validateModelFields(model, args.create);
              validateModelFields(model, args.update);
            }
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
              // Skip models that don't have the corresponding relation defined in the
              // schema, and models that are isolated by their own `schoolId` scalar
              // (see MODELS_SKIP_* sets above — required for multi-school teachers).
              if (
                obj.userId !== undefined &&
                obj.user === undefined &&
                !MODELS_SKIP_USER_TENANT_INJECTION.has(model)
              )
                obj.user = { tenantId };
              if (
                obj.teacherId !== undefined &&
                obj.teacher === undefined &&
                !MODELS_WITHOUT_TEACHER_RELATION.has(model) &&
                !MODELS_SKIP_TEACHER_TENANT_INJECTION.has(model)
              ) {
                obj.teacher = { tenantId };
              }
              if (
                obj.studentId !== undefined &&
                obj.student === undefined &&
                !MODELS_WITHOUT_STUDENT_RELATION.has(model) &&
                !MODELS_SKIP_STUDENT_TENANT_INJECTION.has(model)
              ) {
                obj.student = { tenantId };
              }
              if (
                obj.senderId !== undefined &&
                obj.sender === undefined &&
                !MODELS_SKIP_USER_TENANT_INJECTION.has(model)
              )
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
