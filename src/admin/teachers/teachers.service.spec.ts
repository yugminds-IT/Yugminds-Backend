import { BadRequestException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AdminTeachersService } from './teachers.service';
import { DatabaseService } from '../../database/database.service';
import { AuthCacheService } from '../../auth/auth-cache.service';
import { RefreshTokenStoreService } from '../../auth/refresh-token-store.service';

describe('AdminTeachersService.create — assigned_from/assigned_until', () => {
  let service: AdminTeachersService;
  let db: {
    user: { findUnique: jest.Mock; create: jest.Mock; findFirst: jest.Mock };
    profile: { upsert: jest.Mock };
    teacherSchool: { upsert: jest.Mock };
    teacherSectionAssignment: { deleteMany: jest.Mock; create: jest.Mock };
    teacherWorkingDaysHistory: { aggregate: jest.Mock; upsert: jest.Mock };
    school: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };

  const validBody = {
    email: 'new.teacher@example.test',
    password: 'ValidPass123',
    full_name: 'New Teacher',
    school_assignments: [
      {
        school_id: 'school-1',
        subjects: ['Coding'],
        working_days: [1, 2, 3, 4, 5],
        assigned_from: '2026-08-01',
        assigned_until: '2026-12-15',
      },
    ],
  };

  beforeEach(() => {
    db = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 42 }),
        findFirst: jest.fn().mockResolvedValue({ id: 42, teacherSchools: [], teacherSectionAssignments: [] }),
      },
      profile: { upsert: jest.fn().mockResolvedValue({}) },
      teacherSchool: { upsert: jest.fn().mockResolvedValue({}) },
      teacherSectionAssignment: {
        deleteMany: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
      teacherWorkingDaysHistory: {
        aggregate: jest.fn().mockResolvedValue({ _min: { effectiveFrom: null } }),
        upsert: jest.fn().mockResolvedValue({}),
      },
      school: {
        findUnique: jest.fn().mockResolvedValue({
          name: 'Test School',
          operatingDays: [1, 2, 3, 4, 5, 6],
        }),
      },
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
    };
    service = new AdminTeachersService(
      db as unknown as DatabaseService,
      {} as unknown as AuthCacheService,
      {} as unknown as RefreshTokenStoreService,
    );
  });

  it('writes assignedFrom/assignedUntil onto the TeacherSchool upsert', async () => {
    await service.create(validBody);
    const call = db.teacherSchool.upsert.mock.calls[0][0];
    expect(call.create.assignedFrom).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    expect(call.create.assignedUntil).toEqual(new Date('2026-12-15T00:00:00.000Z'));
    expect(call.update.assignedFrom).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    expect(call.update.assignedUntil).toEqual(new Date('2026-12-15T00:00:00.000Z'));
  });

  it('rejects assigned_until before assigned_from', async () => {
    const body = {
      ...validBody,
      school_assignments: [
        {
          ...validBody.school_assignments[0],
          assigned_from: '2026-12-15',
          assigned_until: '2026-08-01',
        },
      ],
    };
    await expect(service.create(body)).rejects.toThrow(BadRequestException);
    expect(db.teacherSchool.upsert).not.toHaveBeenCalled();
  });

  it('defaults both dates to null when omitted (no restriction, backward compatible)', async () => {
    const body = {
      ...validBody,
      school_assignments: [
        {
          school_id: 'school-1',
          subjects: ['Coding'],
          working_days: [1, 2, 3, 4, 5],
        },
      ],
    };
    await service.create(body);
    const call = db.teacherSchool.upsert.mock.calls[0][0];
    expect(call.create.assignedFrom).toBeNull();
    expect(call.create.assignedUntil).toBeNull();
  });
});

describe('AdminTeachersService.create — working days vs school operatingDays', () => {
  let service: AdminTeachersService;
  let db: {
    user: { findUnique: jest.Mock; create: jest.Mock; findFirst: jest.Mock };
    profile: { upsert: jest.Mock };
    teacherSchool: { upsert: jest.Mock };
    teacherSectionAssignment: { deleteMany: jest.Mock; create: jest.Mock };
    teacherWorkingDaysHistory: { aggregate: jest.Mock; upsert: jest.Mock };
    school: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };

  const bodyWithWorkingDays = (working_days: number[]) => ({
    email: 'new.teacher@example.test',
    password: 'ValidPass123',
    full_name: 'New Teacher',
    school_assignments: [
      {
        school_id: 'school-1',
        subjects: ['Coding'],
        working_days,
      },
    ],
  });

  beforeEach(() => {
    db = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 42 }),
        findFirst: jest.fn().mockResolvedValue({ id: 42, teacherSchools: [], teacherSectionAssignments: [] }),
      },
      profile: { upsert: jest.fn().mockResolvedValue({}) },
      teacherSchool: { upsert: jest.fn().mockResolvedValue({}) },
      teacherSectionAssignment: {
        deleteMany: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
      teacherWorkingDaysHistory: {
        aggregate: jest.fn().mockResolvedValue({ _min: { effectiveFrom: null } }),
        upsert: jest.fn().mockResolvedValue({}),
      },
      school: {
        // School only operates Mon-Fri (no weekend classes)
        findUnique: jest.fn().mockResolvedValue({
          name: 'Weekday-Only School',
          operatingDays: [1, 2, 3, 4, 5],
        }),
      },
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
    };
    service = new AdminTeachersService(
      db as unknown as DatabaseService,
      {} as unknown as AuthCacheService,
      {} as unknown as RefreshTokenStoreService,
    );
  });

  it('rejects a working day outside the target school operatingDays', async () => {
    await expect(service.create(bodyWithWorkingDays([1, 2, 6]))).rejects.toThrow(
      BadRequestException,
    );
    expect(db.teacherSchool.upsert).not.toHaveBeenCalled();
  });

  it('mentions the school name and the disallowed day in the error message', async () => {
    await expect(service.create(bodyWithWorkingDays([6]))).rejects.toThrow(
      /Weekday-Only School.*Saturday/,
    );
  });

  it('allows working days that are a subset of the school operatingDays', async () => {
    await service.create(bodyWithWorkingDays([1, 2, 3]));
    expect(db.teacherSchool.upsert).toHaveBeenCalled();
  });
});

describe('AdminTeachersService.list — tenant scoping', () => {
  let service: AdminTeachersService;
  let db: {
    user: { findMany: jest.Mock; count: jest.Mock };
    teacherSectionAssignment: { findMany: jest.Mock };
  };

  beforeEach(() => {
    db = {
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      teacherSectionAssignment: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new AdminTeachersService(
      db as unknown as DatabaseService,
      {} as unknown as AuthCacheService,
      {} as unknown as RefreshTokenStoreService,
    );
  });

  it('a platform admin (no currentUser scoping) can query any school via school_id, or none at all', async () => {
    await service.list('school-999', undefined, undefined, {
      id: 1,
      role: Role.admin,
    });
    const where = db.user.findMany.mock.calls[0][0].where;
    expect(where.teacherSchools).toEqual({ some: { schoolId: 'school-999' } });
  });

  it('a school_admin caller is force-scoped to their own tenantId, ignoring any school_id they pass', async () => {
    await service.list('some-other-school', undefined, undefined, {
      id: 2,
      role: Role.school_admin,
      tenantId: 'my-real-school',
    });
    const where = db.user.findMany.mock.calls[0][0].where;
    // Previously list() had no @CurrentUser() at all — a school_admin JWT
    // could pass a different school's id (or none) and read that school's
    // full teacher roster (name/email/phone/qualification).
    expect(where.teacherSchools).toEqual({ some: { schoolId: 'my-real-school' } });
  });

  it('a school_admin caller with no school_id query param still only sees their own school (not every school)', async () => {
    await service.list(undefined, undefined, undefined, {
      id: 2,
      role: Role.school_admin,
      tenantId: 'my-real-school',
    });
    const where = db.user.findMany.mock.calls[0][0].where;
    expect(where.teacherSchools).toEqual({ some: { schoolId: 'my-real-school' } });
  });

  it('rejects a school_admin caller with no tenantId assigned', async () => {
    await expect(
      service.list(undefined, undefined, undefined, {
        id: 2,
        role: Role.school_admin,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});
