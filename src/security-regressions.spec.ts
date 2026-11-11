import { ROLES_KEY } from './auth/decorators/roles.decorator';
import { AdminTeachersController } from './admin/teachers/teachers.controller';
import { ProfileController } from './common/profile/profile.controller';
import { GetRoleController } from './common/get-role/get-role.controller';
import { TeacherExtraController } from './teacher/extra/teacher-extra.controller';

describe('security regressions (audit run-1)', () => {
  it('PUT /admin/teachers/:id is admin-only (school_admin must not inherit the class allowance)', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      AdminTeachersController.prototype.update,
    );
    expect(roles).toEqual(['admin']);
  });

  it('GET /profile ignores a client-supplied userId and returns only the caller', async () => {
    const service = { get: jest.fn().mockResolvedValue({ profile: {} }) };
    const ctl = new ProfileController(service as never);
    await (ctl.get as (u: { id: number }, extra?: unknown) => Promise<unknown>)(
      { id: 5 },
      '999', // would have been the ?userId= value in the old signature
    );
    expect(service.get).toHaveBeenCalledWith(5);
  });

  it('GET /get-role ignores a client-supplied userId and returns only the caller', async () => {
    const service = { getRole: jest.fn().mockResolvedValue({}) };
    const ctl = new GetRoleController(service as never);
    await (
      ctl.getRole as (u: { id: number }, extra?: unknown) => Promise<unknown>
    )({ id: 5 }, '999');
    expect(service.getRole).toHaveBeenCalledWith('5');
  });

  describe('teacher assignment access', () => {
    const make = (teacherSchoolIds: string[], accessibleCourse = true) => {
      const ctl: any = Object.create(TeacherExtraController.prototype);
      ctl.db = {
        teacherSchool: {
          findMany: jest
            .fn()
            .mockResolvedValue(
              teacherSchoolIds.map((schoolId) => ({ schoolId })),
            ),
        },
        chapter: { findUnique: jest.fn().mockResolvedValue(null) },
        courseAccess: {
          findFirst: jest
            .fn()
            .mockResolvedValue(accessibleCourse ? { id: 1 } : null),
        },
      };
      return ctl;
    };
    const asg = (o: Record<string, unknown>) => ({
      teacherId: null,
      schoolId: null,
      courseId: 'c1',
      chapterId: null,
      ...o,
    });

    it("denies another school's assignment even when the course is shared with the teacher's school", async () => {
      const ctl = make(['A']);
      expect(
        await ctl.canTeacherAccessAssignment(1, asg({ schoolId: 'B' })),
      ).toBe(false);
    });

    it('allows a shared (school-less) assignment through course access', async () => {
      const ctl = make(['A']);
      expect(await ctl.canTeacherAccessAssignment(1, asg({}))).toBe(true);
    });

    it("denies the creator once removed from the assignment's school, allows while a member", async () => {
      expect(
        await make([]).canTeacherAccessAssignment(
          1,
          asg({ teacherId: 1, schoolId: 'A' }),
        ),
      ).toBe(false);
      expect(
        await make(['A']).canTeacherAccessAssignment(
          1,
          asg({ teacherId: 1, schoolId: 'A' }),
        ),
      ).toBe(true);
    });

    it('stops teachers editing/deleting shared assignments they did not author', () => {
      const ctl = make(['A']);
      expect(() =>
        ctl.assertMayModifyAssignment(1, { schoolId: null, teacherId: null }),
      ).toThrow(/administrator/);
      expect(() =>
        ctl.assertMayModifyAssignment(1, { schoolId: null, teacherId: 1 }),
      ).not.toThrow();
      expect(() =>
        ctl.assertMayModifyAssignment(1, { schoolId: 'A', teacherId: 2 }),
      ).not.toThrow();
    });
  });
});
