import { Role } from '@prisma/client';
import { AdminSchoolsService } from './schools.service';
import { DatabaseService } from '../../database/database.service';
import { AuthService } from '../../auth/auth.service';
import { AuthCacheService } from '../../auth/auth-cache.service';

describe('AdminSchoolsService', () => {
  let service: AdminSchoolsService;
  let db: {
    user: { findMany: jest.Mock; deleteMany: jest.Mock };
    teacherReport: { deleteMany: jest.Mock };
    teacherLeave: { deleteMany: jest.Mock };
    school: { deleteMany: jest.Mock; findMany: jest.Mock };
    tenant: { delete: jest.Mock; count: jest.Mock; findMany: jest.Mock };
  };

  beforeEach(() => {
    db = {
      user: {
        findMany: jest.fn().mockResolvedValue([{ id: 5 }, { id: 6 }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      teacherReport: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      teacherLeave: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      school: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      tenant: {
        delete: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    service = new AdminSchoolsService(
      db as unknown as DatabaseService,
      {} as unknown as AuthService,
      {} as unknown as AuthCacheService,
    );
  });

  describe('purge', () => {
    it('deletes TeacherReport rows for the school and its teachers before hard-deleting them', async () => {
      const callOrder: string[] = [];
      db.teacherReport.deleteMany.mockImplementation(async () => {
        callOrder.push('teacherReport.deleteMany');
        return { count: 3 };
      });
      db.user.deleteMany.mockImplementation(async () => {
        callOrder.push('user.deleteMany');
        return { count: 2 };
      });
      db.school.deleteMany.mockImplementation(async () => {
        callOrder.push('school.deleteMany');
        return { count: 1 };
      });

      await service.purge('school-1');

      expect(db.teacherReport.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [{ teacherId: { in: [5, 6] } }, { schoolId: 'school-1' }],
        },
      });
      expect(callOrder).toEqual([
        'teacherReport.deleteMany',
        'user.deleteMany',
        'school.deleteMany',
      ]);
    });

    it('still scopes cleanup to the school when it has no users', async () => {
      db.user.findMany.mockResolvedValue([]);

      await service.purge('school-1');

      expect(db.teacherReport.deleteMany).toHaveBeenCalledWith({
        where: { OR: [{ schoolId: 'school-1' }] },
      });
      expect(db.user.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('pickSchoolDataFromBody — operatingDays', () => {
    const pick = (body: Record<string, unknown>) =>
      (
        service as unknown as {
          pickSchoolDataFromBody: (b: Record<string, unknown>) => Record<string, unknown>;
        }
      ).pickSchoolDataFromBody(body);

    it('normalizes operating_days (snake_case) into operatingDays', () => {
      expect(pick({ operating_days: [3, 1, 1, 5] })).toMatchObject({
        operatingDays: [1, 3, 5],
      });
    });

    it('normalizes operatingDays (camelCase)', () => {
      expect(pick({ operatingDays: [6, 0] })).toMatchObject({
        operatingDays: [0, 6],
      });
    });

    it('falls back to Mon-Sat when the provided array is empty/invalid', () => {
      expect(pick({ operating_days: [] })).toMatchObject({
        operatingDays: [1, 2, 3, 4, 5, 6],
      });
    });

    it('omits operatingDays entirely when neither key is present (leaves DB default untouched on update)', () => {
      expect(pick({ name: 'Some School' })).not.toHaveProperty('operatingDays');
    });
  });

  describe('list — studentCount scoping', () => {
    it('only counts links to active, non-trashed students (excludes deactivated/soft-deleted ones)', async () => {
      await service.list();

      // First call looks up trashed schools; the second builds the actual
      // per-school rows with the studentSchools relation this test targets.
      const schoolFindManyCalls = db.school.findMany.mock.calls;
      const mainCall = schoolFindManyCalls[schoolFindManyCalls.length - 1][0];

      expect(mainCall.include.studentSchools).toEqual({
        where: {
          isActive: true,
          student: { role: Role.student, isActive: true, deletedAt: null },
        },
        select: { id: true },
      });
    });

    it('only counts links to active, non-trashed teachers (same overcount risk as studentSchools — TeacherSchool has no isActive column of its own)', async () => {
      await service.list();

      const schoolFindManyCalls = db.school.findMany.mock.calls;
      const mainCall = schoolFindManyCalls[schoolFindManyCalls.length - 1][0];

      expect(mainCall.include.teacherSchools).toEqual({
        where: {
          teacher: { role: Role.teacher, isActive: true, deletedAt: null },
        },
        select: { id: true },
      });
    });
  });
});
