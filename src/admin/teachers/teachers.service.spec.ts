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
        findFirst: jest.fn().mockResolvedValue({
          id: 42,
          teacherSchools: [],
          teacherSectionAssignments: [],
        }),
      },
      profile: { upsert: jest.fn().mockResolvedValue({}) },
      teacherSchool: { upsert: jest.fn().mockResolvedValue({}) },
      teacherSectionAssignment: {
        deleteMany: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
      teacherWorkingDaysHistory: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _min: { effectiveFrom: null } }),
        upsert: jest.fn().mockResolvedValue({}),
      },
      school: {
        findUnique: jest.fn().mockResolvedValue({
          name: 'Test School',
          operatingDays: [1, 2, 3, 4, 5, 6],
        }),
      },
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
        callback(db),
      ),
    };
    service = new AdminTeachersService(
      db as unknown as DatabaseService,
      {} as unknown as AuthCacheService,
      {} as unknown as RefreshTokenStoreService,
      { revokeMany: jest.fn() } as never,
    );
  });

  it('writes assignedFrom/assignedUntil onto the TeacherSchool upsert', async () => {
    await service.create(validBody);
    const call = db.teacherSchool.upsert.mock.calls[0][0];
    expect(call.create.assignedFrom).toEqual(
      new Date('2026-08-01T00:00:00.000Z'),
    );
    expect(call.create.assignedUntil).toEqual(
      new Date('2026-12-15T00:00:00.000Z'),
    );
    expect(call.update.assignedFrom).toEqual(
      new Date('2026-08-01T00:00:00.000Z'),
    );
    expect(call.update.assignedUntil).toEqual(
      new Date('2026-12-15T00:00:00.000Z'),
    );
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
        findFirst: jest.fn().mockResolvedValue({
          id: 42,
          teacherSchools: [],
          teacherSectionAssignments: [],
        }),
      },
      profile: { upsert: jest.fn().mockResolvedValue({}) },
      teacherSchool: { upsert: jest.fn().mockResolvedValue({}) },
      teacherSectionAssignment: {
        deleteMany: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
      teacherWorkingDaysHistory: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _min: { effectiveFrom: null } }),
        upsert: jest.fn().mockResolvedValue({}),
      },
      school: {
        // School only operates Mon-Fri (no weekend classes)
        findUnique: jest.fn().mockResolvedValue({
          name: 'Weekday-Only School',
          operatingDays: [1, 2, 3, 4, 5],
        }),
      },
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
        callback(db),
      ),
    };
    service = new AdminTeachersService(
      db as unknown as DatabaseService,
      {} as unknown as AuthCacheService,
      {} as unknown as RefreshTokenStoreService,
      { revokeMany: jest.fn() } as never,
    );
  });

  it('rejects a working day outside the target school operatingDays', async () => {
    await expect(
      service.create(bodyWithWorkingDays([1, 2, 6])),
    ).rejects.toThrow(BadRequestException);
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
      { revokeMany: jest.fn() } as never,
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
    expect(where.teacherSchools).toEqual({
      some: { schoolId: 'my-real-school' },
    });
  });

  it('a school_admin caller with no school_id query param still only sees their own school (not every school)', async () => {
    await service.list(undefined, undefined, undefined, {
      id: 2,
      role: Role.school_admin,
      tenantId: 'my-real-school',
    });
    const where = db.user.findMany.mock.calls[0][0].where;
    expect(where.teacherSchools).toEqual({
      some: { schoolId: 'my-real-school' },
    });
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

describe('AdminTeachersService — split-day slots', () => {
  let service: AdminTeachersService;
  let db: any;
  const A = { school_id: 'school-a', subjects: ['Coding'] };
  const B = { school_id: 'school-b', subjects: ['Coding'] };
  const am = { '1': { slot: 'MORNING', start: '08:00', end: '12:30' } };
  const pm = { '1': { slot: 'AFTERNOON', start: '12:30', end: '17:00' } };
  const body = (assignments: unknown[]) => ({
    email: 'split@example.test',
    password: 'ValidPass123',
    full_name: 'Split Teacher',
    school_assignments: assignments,
  });

  beforeEach(() => {
    db = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 42 }),
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue({
          id: 42,
          teacherSchools: [],
          teacherSectionAssignments: [],
        }),
      },
      profile: { upsert: jest.fn().mockResolvedValue({}) },
      teacherSchool: {
        upsert: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        delete: jest.fn(),
      },
      teacherSectionAssignment: {
        deleteMany: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      teacherWorkingDaysHistory: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _min: { effectiveFrom: null } }),
        upsert: jest.fn().mockResolvedValue({}),
      },
      classSchedule: { findMany: jest.fn().mockResolvedValue([]) },
      period: { findMany: jest.fn().mockResolvedValue([]) },
      school: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ name: 'S', operatingDays: [1, 2, 3, 4, 5, 6] }),
        findMany: jest.fn().mockResolvedValue([
          { id: 'school-a', name: 'School A' },
          { id: 'school-b', name: 'School B' },
        ]),
      },
      $transaction: jest.fn(async (arg: unknown) =>
        typeof arg === 'function' ? arg(db) : Promise.all(arg as unknown[]),
      ),
    };
    service = new AdminTeachersService(
      db as DatabaseService,
      { invalidate: jest.fn() } as unknown as AuthCacheService,
      {} as unknown as RefreshTokenStoreService,
      { revokeAll: jest.fn(), revokeMany: jest.fn() } as never,
    );
  });

  it('create: morning at one school + afternoon at the other is allowed and stored', async () => {
    await service.create(
      body([
        { ...A, working_days: [1], day_slots: am },
        { ...B, working_days: [1], day_slots: pm },
      ]),
    );
    const stored = db.teacherSchool.upsert.mock.calls.map(
      (c: any) => c[0].create.workingDaySlots,
    );
    expect(stored[0]['1'].slot).toBe('MORNING');
    expect(stored[1]['1'].slot).toBe('AFTERNOON');
  });

  it('create: two full days on the same weekday are rejected, naming both schools', async () => {
    await expect(
      service.create(
        body([
          { ...A, working_days: [1, 2] },
          { ...B, working_days: [2, 3] },
        ]),
      ),
    ).rejects.toThrow(/Tuesday.*School A.*School B/);
    expect(db.teacherSchool.upsert).not.toHaveBeenCalled();
  });

  it('create: two morning slots on the same day are rejected', async () => {
    await expect(
      service.create(
        body([
          { ...A, working_days: [1], day_slots: am },
          { ...B, working_days: [1], day_slots: am },
        ]),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('create: a slot whose end is before its start is a 400', async () => {
    await expect(
      service.create(
        body([
          {
            ...A,
            working_days: [1],
            day_slots: {
              '1': { slot: 'MORNING', start: '12:00', end: '09:00' },
            },
          },
        ]),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  describe('update', () => {
    // Legacy data: both schools already full-day on Thursday.
    const legacy = (id: string) => ({
      teacherId: 42,
      schoolId: id,
      workingDays: [4],
      workingDaySlots: null,
    });
    beforeEach(() => {
      db.teacherSchool.findMany.mockResolvedValue([
        legacy('school-a'),
        legacy('school-b'),
      ]);
    });

    it('re-saving an unchanged legacy overlap is NOT blocked', async () => {
      await service.update('42', {
        school_assignments: [
          { ...A, working_days: [4] },
          { ...B, working_days: [4] },
        ],
      });
      expect(db.teacherSchool.upsert).toHaveBeenCalledTimes(2);
    });

    it('changing one school into the clash is blocked and writes nothing', async () => {
      await expect(
        service.update('42', {
          school_assignments: [
            { ...A, working_days: [4, 5] },
            { ...B, working_days: [4] },
          ],
        }),
      ).rejects.toThrow(/Thursday/);
      expect(db.teacherSchool.upsert).not.toHaveBeenCalled();
      expect(db.teacherSchool.delete).not.toHaveBeenCalled();
    });

    it('fixing the overlap with morning/afternoon slots succeeds and records slot history', async () => {
      const sl = (d: string, s: string, e: string, k: string) => ({
        [d]: { slot: k, start: s, end: e },
      });
      await service.update('42', {
        school_assignments: [
          {
            ...A,
            working_days: [4],
            day_slots: sl('4', '08:00', '12:30', 'MORNING'),
          },
          {
            ...B,
            working_days: [4],
            day_slots: sl('4', '12:30', '17:00', 'AFTERNOON'),
          },
        ],
      });
      const hist = db.teacherWorkingDaysHistory.upsert.mock.calls.map(
        (c: any) => c[0].create.workingDaySlots['4'].slot,
      );
      expect(hist).toEqual(['MORNING', 'AFTERNOON']);
    });

    it('primary school: the school flagged is_primary becomes the teacher tenantId (not just the first)', async () => {
      await service.update('42', {
        school_assignments: [
          { ...A, working_days: [4], is_primary: false },
          { ...B, working_days: [5], is_primary: true },
        ],
      });
      const tenantWrites = db.user.update.mock.calls
        .map((c: any) => c[0].data.tenantId)
        .filter(Boolean);
      expect(tenantWrites).toEqual(['school-b']);
    });

    it('primary school: falls back to the first assignment when none is flagged', async () => {
      await service.update('42', {
        school_assignments: [
          { ...A, working_days: [4] },
          { ...B, working_days: [5] },
        ],
      });
      const tenantWrites = db.user.update.mock.calls
        .map((c: any) => c[0].data.tenantId)
        .filter(Boolean);
      expect(tenantWrites).toEqual(['school-a']);
    });

    it('school order: each assignment is saved with its position in the list', async () => {
      await service.update('42', {
        school_assignments: [
          { ...B, working_days: [5] },
          { ...A, working_days: [4] },
        ],
      });
      const order = db.teacherSchool.upsert.mock.calls.map((c: any) => [
        c[0].create.schoolId,
        c[0].create.displayOrder,
      ]);
      expect(order).toEqual([
        ['school-b', 0],
        ['school-a', 1],
      ]);
    });

    it('warns (without blocking) when new slots leave existing classes outside the window', async () => {
      db.classSchedule.findMany.mockResolvedValue([
        {
          dayOfWeek: 4,
          periodId: 'p1',
          subject: 'Coding',
          grade: '6',
          section: 'A',
        },
        {
          dayOfWeek: 4,
          periodId: 'p2',
          subject: 'Coding',
          grade: '6',
          section: 'B',
        },
      ]);
      db.period.findMany.mockResolvedValue([
        { id: 'p1', periodNumber: 1, startTime: '09:00', endTime: '09:45' },
        { id: 'p2', periodNumber: 6, startTime: '13:15', endTime: '14:00' },
      ]);
      const res = await service.update('42', {
        school_assignments: [
          {
            ...A,
            working_days: [4],
            day_slots: {
              '4': { slot: 'MORNING', start: '08:00', end: '12:30' },
            },
          },
        ],
      });
      expect(db.teacherSchool.upsert).toHaveBeenCalled();
      expect(res.scheduleWarnings).toHaveLength(1);
      expect(res.scheduleWarnings![0]).toMatchObject({
        schoolId: 'school-a',
        count: 1,
      });
      expect(res.scheduleWarnings![0].examples[0]).toMatch(/Thu P6/);
    });

    it('no warning when every existing class still fits', async () => {
      db.classSchedule.findMany.mockResolvedValue([
        {
          dayOfWeek: 4,
          periodId: 'p1',
          subject: 'Coding',
          grade: '6',
          section: 'A',
        },
      ]);
      db.period.findMany.mockResolvedValue([
        { id: 'p1', periodNumber: 1, startTime: '09:00', endTime: '09:45' },
      ]);
      const res = await service.update('42', {
        school_assignments: [
          {
            ...A,
            working_days: [4],
            day_slots: {
              '4': { slot: 'MORNING', start: '08:00', end: '12:30' },
            },
          },
        ],
      });
      expect(res.scheduleWarnings).toBeUndefined();
    });
  });
});
