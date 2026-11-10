/**
 * One definition of "may this account act right now": the user is active and,
 * for tenant-bound users, so is their school. Global admins are not tied to a
 * school. Used per request (JwtStrategy), on refresh, and when a multi-school
 * teacher switches into another school, so the three can never drift apart.
 */
export async function isAccountActive(
  db: {
    school: {
      findUnique(args: {
        where: { id: string };
        select: { isActive: true };
      }): Promise<{ isActive: boolean } | null>;
    };
  },
  user: {
    isActive?: boolean | null;
    role: string;
    isSuperAdmin?: boolean | null;
    tenantId?: string | null;
  },
): Promise<boolean> {
  if (user.isActive === false) return false;
  if (user.role === 'admin' || user.isSuperAdmin || !user.tenantId) return true;
  return isSchoolActive(db, user.tenantId);
}

export async function isSchoolActive(
  db: {
    school: {
      findUnique(args: {
        where: { id: string };
        select: { isActive: true };
      }): Promise<{ isActive: boolean } | null>;
    };
  },
  schoolId: string,
): Promise<boolean> {
  const school = await db.school.findUnique({
    where: { id: schoolId },
    select: { isActive: true },
  });
  return !(school && school.isActive === false);
}
