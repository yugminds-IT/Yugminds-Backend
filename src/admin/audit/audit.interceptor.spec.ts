import { of, throwError, firstValueFrom } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AuditInterceptor,
  payloadFor,
  schoolOf,
  shouldAudit,
  withImpersonator,
} from './audit.interceptor';

const SCHOOL = '11111111-2222-3333-4444-555555555555';
const OTHER = '66666666-7777-8888-9999-000000000000';
const asUser = (role?: string, method = 'POST') => ({
  method,
  user: role ? { role } : undefined,
});

describe('shouldAudit: whose changes are recorded', () => {
  it('never records reads', () => {
    expect(shouldAudit(asUser('admin', 'GET'), '/admin/students', true)).toBe(
      false,
    );
    expect(
      shouldAudit(asUser('teacher', 'GET'), '/teacher/reports', false),
    ).toBe(false);
  });

  it('always records admin-area changes, even with no user attached', () => {
    expect(
      shouldAudit(asUser(undefined, 'DELETE'), '/admin/students/5', false),
    ).toBe(true);
    expect(shouldAudit(asUser(undefined), '/somewhere/else', true)).toBe(true); // admin-gated route
  });

  it('records changes by school admins and teachers anywhere', () => {
    expect(shouldAudit(asUser('teacher'), '/teacher/reports', false)).toBe(
      true,
    );
    expect(
      shouldAudit(
        asUser('teacher', 'PATCH'),
        '/teacher/assignments/1/submissions/2/grade',
        false,
      ),
    ).toBe(true);
    expect(
      shouldAudit(
        asUser('school_admin', 'DELETE'),
        '/school-admin/students/9',
        false,
      ),
    ).toBe(true);
    expect(
      shouldAudit(
        asUser('school_admin', 'PATCH'),
        '/school-admin/reports/bulk',
        false,
      ),
    ).toBe(true);
  });

  it('records only the meaningful student actions', () => {
    expect(
      shouldAudit(asUser('student'), '/student/assignments/1/submit', false),
    ).toBe(true);
    expect(
      shouldAudit(
        asUser('student'),
        '/student/assignments/1/retake-request',
        false,
      ),
    ).toBe(true);
    expect(
      shouldAudit(asUser('student'), '/student/certificates/generate', false),
    ).toBe(true);
    expect(
      shouldAudit(asUser('student'), '/student/notifications', false),
    ).toBe(true);
    expect(shouldAudit(asUser('student'), '/notifications/reply', false)).toBe(
      true,
    );
    expect(shouldAudit(asUser('student'), '/student/profile', false)).toBe(
      false,
    ); // not on the list
  });

  it('skips autosave, sign-ins and notification housekeeping for everyone', () => {
    for (const role of ['student', 'teacher', 'school_admin', 'admin']) {
      expect(shouldAudit(asUser(role), '/student/simple-progress', false)).toBe(
        false,
      );
      expect(
        shouldAudit(asUser(role), '/student/save-chapter-progress', false),
      ).toBe(false);
      expect(shouldAudit(asUser(role), '/student/last-viewed', false)).toBe(
        false,
      );
      expect(shouldAudit(asUser(role), '/auth/login', false)).toBe(false);
      expect(shouldAudit(asUser(role), '/auth/refresh', false)).toBe(false);
      expect(
        shouldAudit(asUser(role, 'PATCH'), '/notifications/user/bulk', false),
      ).toBe(false);
    }
    expect(shouldAudit(asUser(undefined), '/contact', false)).toBe(false);
    expect(shouldAudit(asUser('admin'), '/admin/warm-cache', true)).toBe(false);
  });

  it('ignores callers who are not signed in or have no dashboard role', () => {
    expect(shouldAudit(asUser(undefined), '/teacher/reports', false)).toBe(
      false,
    );
    expect(shouldAudit(asUser('learner'), '/academy/anything', false)).toBe(
      false,
    );
  });
});

describe('schoolOf: which school an action was for', () => {
  it('uses the own school for school admins and students, whatever the request says', () => {
    expect(
      schoolOf(
        {
          user: { role: 'school_admin', tenantId: SCHOOL },
          body: { school_id: OTHER },
        },
        'students',
        null,
      ),
    ).toBe(SCHOOL);
    expect(
      schoolOf(
        { user: { role: 'student', tenantId: SCHOOL } },
        'assignments',
        '1',
      ),
    ).toBe(SCHOOL);
  });

  it('uses the school a teacher named, else their main school', () => {
    expect(
      schoolOf(
        {
          user: { role: 'teacher', tenantId: SCHOOL },
          body: { school_id: OTHER },
        },
        'reports',
        null,
      ),
    ).toBe(OTHER);
    expect(
      schoolOf(
        {
          user: { role: 'teacher', tenantId: SCHOOL },
          query: { school_id: OTHER },
        },
        'reports',
        null,
      ),
    ).toBe(OTHER);
    expect(
      schoolOf(
        { user: { role: 'teacher', tenantId: SCHOOL } },
        'reports',
        null,
      ),
    ).toBe(SCHOOL);
  });

  it('gives an admin a school only when the request names one, or the record is a school', () => {
    expect(schoolOf({ user: { role: 'admin' } }, 'students', '5')).toBeNull();
    expect(
      schoolOf(
        { user: { role: 'admin' }, body: { schoolId: SCHOOL } },
        'students',
        null,
      ),
    ).toBe(SCHOOL);
    expect(schoolOf({ user: { role: 'admin' } }, 'schools', SCHOOL)).toBe(
      SCHOOL,
    );
  });

  it('ignores anything that is not a school id', () => {
    expect(
      schoolOf(
        { user: { role: 'admin' }, body: { school_id: "x'; DROP TABLE" } },
        'students',
        null,
      ),
    ).toBeNull();
    expect(
      schoolOf(
        { user: { role: 'teacher' }, query: { school_id: ['a'] } },
        'reports',
        null,
      ),
    ).toBeNull();
  });
});

describe('payloadFor: what is stored of the request', () => {
  it('stores nothing for students', () => {
    expect(payloadFor('student', { answers: ['a'] })).toBeNull();
  });
  it('redacts passwords and tokens for everyone else', () => {
    expect(
      payloadFor('teacher', {
        name: 'x',
        password: 'secret',
        nested: { token: 't' },
      }),
    ).toEqual({
      name: 'x',
      password: '[redacted]',
      nested: { token: '[redacted]' },
    });
  });
  it('replaces a huge body with a summary of its fields', () => {
    const big = {
      students: Array.from({ length: 40 }, () => 'x'.repeat(1500)),
      other: 1,
    }; // a bulk import: far over the limit
    const out = payloadFor('school_admin', big) as {
      truncated: boolean;
      keys: string[];
    };
    expect(out.truncated).toBe(true);
    expect(out.keys).toEqual(['students', 'other']);
  });
});

describe('withImpersonator: an admin acting as someone else stays visible', () => {
  it('adds the admin to the stored payload', () => {
    expect(withImpersonator({ a: 1 }, 9)).toEqual({
      a: 1,
      _impersonatedByAdminId: 9,
    });
  });
  it('still records who it was when there is no payload (a student action)', () => {
    expect(withImpersonator(null, 9)).toEqual({ _impersonatedByAdminId: 9 });
  });
  it('leaves normal requests alone', () => {
    expect(withImpersonator({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(withImpersonator(null, undefined)).toBeNull();
  });
});

describe('AuditInterceptor', () => {
  let audit: { record: jest.Mock };
  let interceptor: AuditInterceptor;
  const ctx = (req: Record<string, unknown>, status = 200) =>
    ({
      getType: () => 'http',
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ headers: {}, ...req }),
        getResponse: () => ({ statusCode: status }),
      }),
    }) as unknown as ExecutionContext;
  beforeEach(() => {
    audit = { record: jest.fn() };
    interceptor = new AuditInterceptor(
      audit as never,
      { getAllAndOverride: () => undefined } as unknown as Reflector,
    );
  });

  it('records a teacher change with their role and school', async () => {
    const c = ctx(
      {
        method: 'POST',
        originalUrl: '/teacher/reports',
        user: { id: 7, email: 't@x.org', role: 'teacher', tenantId: SCHOOL },
        body: { topics_taught: 'Sensors' },
      },
      201,
    );
    await firstValueFrom(
      interceptor.intercept(c, { handle: () => of('ok') } as CallHandler),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 7,
        actorRole: 'teacher',
        schoolId: SCHOOL,
        entityType: 'reports',
        success: true,
        statusCode: 201,
        payload: { topics_taught: 'Sensors' },
      }),
    );
  });

  it('records a failed attempt as a failure with its status code', async () => {
    const c = ctx({
      method: 'DELETE',
      originalUrl: '/school-admin/students/9',
      user: { id: 3, role: 'school_admin', tenantId: SCHOOL },
    });
    await expect(
      firstValueFrom(
        interceptor.intercept(c, {
          handle: () => throwError(() => ({ status: 403 })),
        } as CallHandler),
      ),
    ).rejects.toBeDefined();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        statusCode: 403,
        actorRole: 'school_admin',
      }),
    );
  });

  it('records the admin behind an impersonated action', async () => {
    const c = ctx({
      method: 'DELETE',
      originalUrl: '/school-admin/students/9',
      user: {
        id: 3,
        role: 'school_admin',
        tenantId: SCHOOL,
        impersonatorId: 5149,
      },
    });
    await firstValueFrom(
      interceptor.intercept(c, { handle: () => of('ok') } as CallHandler),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 3,
        actorRole: 'school_admin',
        payload: expect.objectContaining({ _impersonatedByAdminId: 5149 }),
      }),
    );
  });

  it('keeps a student submission but not its answers', async () => {
    const c = ctx({
      method: 'POST',
      originalUrl: '/student/assignments/5/submit',
      user: { id: 9, role: 'student', tenantId: SCHOOL },
      body: { answers: ['secret answer'] },
    });
    await firstValueFrom(
      interceptor.intercept(c, { handle: () => of('ok') } as CallHandler),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRole: 'student',
        payload: null,
        entityType: 'assignments',
        entityId: '5',
      }),
    );
  });

  it('does nothing for autosave and for reads', async () => {
    for (const req of [
      {
        method: 'POST',
        originalUrl: '/student/simple-progress',
        user: { id: 9, role: 'student' },
      },
      {
        method: 'GET',
        originalUrl: '/teacher/reports',
        user: { id: 7, role: 'teacher' },
      },
    ]) {
      await firstValueFrom(
        interceptor.intercept(ctx(req), {
          handle: () => of('ok'),
        } as CallHandler),
      );
    }
    expect(audit.record).not.toHaveBeenCalled();
  });
});
