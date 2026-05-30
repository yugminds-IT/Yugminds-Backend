type Tenant = { tenantId: string };

/**
 * Apply tenant constraints into a Prisma `where` filter.
 *
 * Note: Most non-User tables don't have a `tenantId` column; instead they reference a `User`
 * via relations (e.g. `user`, `teacher`, `student`, `sender`, ...). This helper injects
 * `tenantId` into those relation filters.
 */
export function tenantScopedQuery<T extends Record<string, any>>(
  user: Tenant,
  query: T,
): T {
  const tenantId = user.tenantId;
  if (!tenantId) {
    throw new Error('tenantId missing');
  }

  const patchWhere = (where: any): any => {
    if (!where || typeof where !== 'object') return where;
    if (Array.isArray(where)) return where.map(patchWhere);

    // FK -> relation field mapping
    if (where.userId !== undefined && where.user === undefined)
      where.user = { tenantId };
    if (where.teacherId !== undefined && where.teacher === undefined)
      where.teacher = { tenantId };
    if (where.studentId !== undefined && where.student === undefined)
      where.student = { tenantId };
    if (where.senderId !== undefined && where.sender === undefined)
      where.sender = { tenantId };
    if (where.issuedBy !== undefined && where.issuedByUser === undefined)
      where.issuedByUser = { tenantId };
    if (where.approvedBy !== undefined && where.approvedByUser === undefined)
      where.approvedByUser = { tenantId };

    // In this schema, School.id == Tenant.id (1:1). Always overwrite schoolId with the
    // current tenant so callers cannot sneak in a different schoolId and read another tenant's data.
    if (where.schoolId !== undefined) {
      const v = where.schoolId;
      if (typeof v === 'string') {
        if (v !== tenantId) {
          throw new Error(
            `Cross-tenant access denied: requested schoolId "${v}" does not match tenant "${tenantId}"`,
          );
        }
        where.schoolId = tenantId;
      } else if (v && typeof v === 'object') {
        // Nested Prisma filter (e.g. { in: [...] }) — replace entirely with the tenant value
        // so no compound filter can smuggle in a foreign id.
        where.schoolId = tenantId;
      }
    }

    // Recurse into nested logical filters
    for (const [k, v] of Object.entries(where)) {
      where[k] = patchWhere(v);
    }
    return where;
  };

  if (query && typeof query === 'object' && 'where' in query) {
    (query as any).where = patchWhere((query as any).where);
  }

  return query;
}
