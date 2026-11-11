import type { DatabaseService } from '../database/database.service';

/**
 * Newest sign-in per user: the later of a successful login record and a device session.
 * Either source can be missing for older accounts, so both are checked.
 */
export async function lastLoginByUser(
  db: DatabaseService,
  userIds: number[],
): Promise<Map<number, Date>> {
  const out = new Map<number, Date>();
  if (!userIds.length) return out;
  const [logins, sessions] = await Promise.all([
    db.authActivity.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, action: 'login', success: true },
      _max: { createdAt: true },
    }),
    db.loginSession.groupBy({
      by: ['subjectId'],
      where: { subjectType: 'lms', subjectId: { in: userIds.map(String) } },
      _max: { createdAt: true },
    }),
  ]);
  const seen = (id: number, d?: Date | null) => {
    if (d && (!out.get(id) || d > out.get(id)!)) out.set(id, d);
  };
  for (const l of logins)
    if (l.userId != null) seen(l.userId, l._max.createdAt);
  for (const l of sessions) seen(Number(l.subjectId), l._max.createdAt);
  return out;
}
