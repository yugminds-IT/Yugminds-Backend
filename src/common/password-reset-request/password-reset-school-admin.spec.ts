import { PasswordResetRequestService } from './password-reset-request.service';

/**
 * A school admin may reset only accounts that belong to their school alone.
 * The request's schoolId is derived from profile/tenant for ANY role, so
 * "request.schoolId === my school" proves nothing about the target account.
 */
describe('PasswordResetRequestService: school-admin target rules', () => {
  const SCHOOL = 's1';

  const make = (target: {
    role: string;
    tenantId?: string | null;
    studentSchools?: string[];
    teacherSchools?: string[];
  }) => {
    const db: any = {
      passwordResetRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'r1',
          schoolId: SCHOOL,
          status: 'pending',
          userId: 9,
          user: { id: 9, role: target.role, tenantId: target.tenantId ?? null },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      studentSchool: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            (target.studentSchools ?? []).map((schoolId) => ({ schoolId })),
          ),
      },
      teacherSchool: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            (target.teacherSchools ?? []).map((schoolId) => ({ schoolId })),
          ),
      },
      user: { update: jest.fn().mockResolvedValue({}) },
      notification: {
        create: jest.fn().mockResolvedValue({
          id: 'n1',
          title: 'T',
          message: 'M',
          createdAt: new Date(),
        }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const svc = new PasswordResetRequestService(
      db,
      {
        emitNotificationNew: jest.fn(),
        emitUnreadCount: jest.fn(),
        emitDashboardStatsForUser: jest.fn().mockResolvedValue(undefined),
      } as never,
      { revokeAll: jest.fn() } as never,
      { revokeMany: jest.fn() } as never,
    );
    return { svc, db };
  };
  const approve = (svc: PasswordResetRequestService) =>
    svc.update(
      {
        id: 'r1',
        status: 'approved',
        temp_password: 'Temp1234x',
        approved_by: '1',
      },
      { restrictToSchoolId: SCHOOL },
    );

  it('allows resetting a student enrolled only in this school', async () => {
    const { svc, db } = make({ role: 'student', studentSchools: [SCHOOL] });
    await approve(svc);
    expect(db.user.update).toHaveBeenCalled();
  });

  it('allows resetting a teacher assigned only to this school', async () => {
    const { svc, db } = make({
      role: 'teacher',
      tenantId: SCHOOL,
      teacherSchools: [SCHOOL],
    });
    await approve(svc);
    expect(db.user.update).toHaveBeenCalled();
  });

  it.each([
    ['a peer school admin', { role: 'school_admin', tenantId: SCHOOL }],
    ['a platform admin', { role: 'admin' }],
    [
      'a student also enrolled in another school',
      { role: 'student', studentSchools: [SCHOOL, 's2'] },
    ],
    [
      'a student of a different school',
      { role: 'student', studentSchools: ['s2'] },
    ],
    [
      'a teacher who also teaches at another school',
      { role: 'teacher', tenantId: SCHOOL, teacherSchools: [SCHOOL, 's2'] },
    ],
    [
      'a teacher whose primary tenant is another school',
      { role: 'teacher', tenantId: 's2', teacherSchools: [SCHOOL] },
    ],
  ])('refuses to reset %s', async (_n, target) => {
    const { svc, db } = make(target);
    await expect(approve(svc)).rejects.toThrow(/permission/);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('does not restrict the platform admin (no restrictToSchoolId)', async () => {
    const { svc, db } = make({ role: 'school_admin', tenantId: SCHOOL });
    await svc.update({
      id: 'r1',
      status: 'approved',
      temp_password: 'Temp1234x',
      approved_by: '1',
    });
    expect(db.user.update).toHaveBeenCalled();
  });
});
