import { AuditService } from './audit.service';

describe('AuditService', () => {
  let db: {
    auditLog: Record<string, jest.Mock>;
    school: { findMany: jest.Mock };
    profile: { findMany: jest.Mock };
  };
  let svc: AuditService;
  beforeEach(() => {
    delete process.env.AUDIT_RETENTION_DAYS;
    db = {
      auditLog: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
        create: jest.fn().mockResolvedValue({}),
      },
      school: { findMany: jest.fn().mockResolvedValue([]) },
      profile: { findMany: jest.fn().mockResolvedValue([]) },
    };
    svc = new AuditService(db as never);
  });

  describe('filters', () => {
    const whereOf = async (q: object) => {
      await svc.list(q);
      return db.auditLog.count.mock.calls[0][0].where;
    };
    it('filters by role, school, person and failed attempts', async () => {
      expect(
        await whereOf({
          actorRole: 'teacher',
          schoolId: 's1',
          actorId: '42',
          success: 'false',
        }),
      ).toEqual({
        actorRole: 'teacher',
        schoolId: 's1',
        actorId: 42,
        success: false,
      });
    });
    it('"attention" means failed attempts or deletions', async () => {
      expect((await whereOf({ attention: 'true' })).AND).toEqual([
        { OR: [{ success: false }, { method: 'DELETE' }] },
      ]);
    });
    it('ignores a person id that is not a number', async () => {
      expect(await whereOf({ actorId: '1; drop' })).toEqual({});
    });
  });

  it('shows the school name on each entry', async () => {
    db.auditLog.findMany.mockResolvedValue([
      {
        id: 'a',
        actorId: 1,
        actorEmail: 't@x.org',
        actorRole: 'teacher',
        schoolId: 's1',
        method: 'POST',
        path: '/teacher/reports',
        entityType: 'reports',
        entityId: null,
        payload: null,
        statusCode: 201,
        success: true,
        ipAddress: null,
        createdAt: new Date(),
        actor: null,
      },
    ]);
    db.school.findMany.mockResolvedValue([{ id: 's1', name: 'Alpha School' }]);
    const r = await svc.list({});
    expect(r.logs[0]).toMatchObject({
      schoolId: 's1',
      schoolName: 'Alpha School',
      actorRole: 'teacher',
    });
  });

  it('names the admin behind an impersonated action', async () => {
    const row = (payload: unknown) => ({
      id: 'a',
      actorId: 3,
      actorEmail: 't@x.org',
      actorRole: 'teacher',
      schoolId: null,
      method: 'POST',
      path: '/teacher/reports',
      entityType: 'reports',
      entityId: null,
      payload,
      statusCode: 200,
      success: true,
      ipAddress: null,
      createdAt: new Date(),
      actor: null,
    });
    db.auditLog.findMany.mockResolvedValue([
      row({ _impersonatedByAdminId: 5149 }),
      row({ a: 1 }),
    ]);
    (db as unknown as { user: { findMany: jest.Mock } }).user = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 5149,
          email: 'admin@yugminds.com',
          profile: { fullName: 'Admin' },
        },
      ]),
    };
    const r = await svc.list({});
    expect(r.logs[0].impersonatedBy).toEqual({ id: 5149, name: 'Admin' });
    expect(r.logs[1].impersonatedBy).toBeNull();
  });

  it('saves the school with each entry', () => {
    svc.record({
      method: 'POST',
      path: '/teacher/reports',
      actorRole: 'teacher',
      schoolId: 's1',
    });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
      schoolId: 's1',
      actorRole: 'teacher',
    });
  });

  describe('summary: who is behind the failures and deletions', () => {
    it('adds totals, failures and deletions per person and per role, worst first', async () => {
      const row = (id: number, role: string, n: number) => ({
        actorId: id,
        actorEmail: `u${id}@x.org`,
        actorRole: role,
        _count: { _all: n },
      });
      db.auditLog.groupBy
        .mockResolvedValueOnce([
          row(1, 'teacher', 20),
          row(2, 'school_admin', 10),
          row(3, 'student', 5),
        ]) // all
        .mockResolvedValueOnce([row(1, 'teacher', 6), row(3, 'student', 1)]) // failed
        .mockResolvedValueOnce([row(2, 'school_admin', 3)]); // deleted
      db.profile.findMany.mockResolvedValue([{ userId: 1, fullName: 'Asha' }]);
      const s = await svc.summary({ actorRole: 'teacher', actorId: '9' });
      expect(s.top_people.map((p) => [p.name, p.failed, p.deleted])).toEqual([
        ['Asha', 6, 0],
        ['u2@x.org', 0, 3],
        ['u3@x.org', 1, 0],
      ]);
      expect(s.by_role.find((r) => r.role === 'teacher')).toEqual({
        role: 'teacher',
        total: 20,
        failed: 6,
        deleted: 0,
      });
      // the role/person filters are ignored so the panel always shows everyone
      expect(
        JSON.stringify(db.auditLog.groupBy.mock.calls[0][0].where),
      ).not.toContain('teacher');
    });
  });

  describe('auto-delete', () => {
    it('deletes school admin, teacher and student entries older than 90 days, and never admin-area entries', async () => {
      const n = await svc.purgeOld();
      expect(n).toBe(3);
      const where = db.auditLog.deleteMany.mock.calls[0][0].where;
      expect(where.actorRole).toEqual({
        in: ['school_admin', 'teacher', 'student'],
      });
      expect(where.NOT).toEqual({ path: { startsWith: '/admin' } });
      const age = Date.now() - where.createdAt.lt.getTime();
      expect(age).toBeGreaterThan(90 * 86_400_000 - 5000);
      expect(age).toBeLessThan(90 * 86_400_000 + 5000);
    });
    it('uses AUDIT_RETENTION_DAYS when set', () => {
      process.env.AUDIT_RETENTION_DAYS = '30';
      expect(new AuditService(db as never).retentionDays).toBe(30);
      process.env.AUDIT_RETENTION_DAYS = 'junk';
      expect(new AuditService(db as never).retentionDays).toBe(90);
    });
    it('does not throw if the cleanup fails', async () => {
      db.auditLog.deleteMany.mockRejectedValue(new Error('db down'));
      await expect(svc.purgeOld()).resolves.toBe(0);
    });
  });
});
