import { MonitoringMiddleware, whoOf } from './monitoring.middleware';
import { MonitoringService } from './monitoring.service';

const SCHOOL = '11111111-2222-3333-4444-555555555555';
const OTHER = '66666666-7777-8888-9999-000000000000';

describe('MonitoringMiddleware', () => {
  let monitoring: { record: jest.Mock };
  let mw: MonitoringMiddleware;
  beforeEach(() => {
    monitoring = { record: jest.fn() };
    mw = new MonitoringMiddleware(monitoring as unknown as MonitoringService);
  });

  /** Runs one request through the middleware; `finish()` plays the moment the response is sent. */
  function run(
    over: {
      method?: string;
      url?: string;
      route?: string | null;
      user?: any;
      status?: number;
      query?: any;
    } = {},
  ) {
    const handlers: Array<() => void> = [];
    const res: any = {
      statusCode: over.status ?? 200,
      on: jest.fn(
        (e: string, cb: () => void) => e === 'finish' && handlers.push(cb),
      ),
    };
    const req: any = {
      method: over.method ?? 'GET',
      originalUrl: over.url ?? '/some/path',
      user: over.user,
      query: over.query ?? {},
      route:
        over.route === null
          ? undefined
          : { path: over.route ?? over.url ?? '/some/path' },
    };
    const next = jest.fn();
    mw.use(req, res, next);
    return { req, res, next, finish: () => handlers.forEach((h) => h()) };
  }

  it('always lets the request carry on', () => {
    const { next } = run();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('records the final status code once the response is sent, not before', () => {
    const { res, finish } = run({ url: '/admin/users' });
    expect(monitoring.record).not.toHaveBeenCalled();
    res.statusCode = 201;
    finish();
    expect(monitoring.record).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: '/admin/users',
        method: 'GET',
        statusCode: 201,
      }),
    );
  });

  it('counts requests the security guards turned away (the gap an interceptor leaves)', () => {
    run({ url: '/admin/teachers', status: 401 }).finish();
    run({
      url: '/admin/teachers',
      status: 403,
      user: { id: 7, role: 'teacher' },
    }).finish();
    run({ url: '/x', status: 429 }).finish();
    expect(monitoring.record.mock.calls.map((c) => c[0].statusCode)).toEqual([
      401, 403, 429,
    ]);
    expect(monitoring.record.mock.calls[1][0]).toMatchObject({
      role: 'teacher',
      userId: '7',
    });
  });

  it('labels by the matched route template, and folds unmatched paths into one bucket', () => {
    run({ url: '/students/42?x=1', route: '/students/:id' }).finish();
    run({ url: '/wp-login.php', route: null, status: 404 }).finish();
    expect(monitoring.record.mock.calls[0][0].endpoint).toBe('/students/:id');
    expect(monitoring.record.mock.calls[1][0].endpoint).toBe('(unmatched)');
  });

  it("leaves out the monitoring page's own polling and browser preflights", () => {
    run({ url: '/admin/monitoring-dashboard?role=teacher' }).finish();
    run({ url: '/admin/monitoring-history?hours=24' }).finish();
    run({ method: 'OPTIONS', url: '/teacher/reports' }).finish();
    expect(monitoring.record).not.toHaveBeenCalled();
  });

  it('records a non-negative duration', () => {
    run().finish();
    expect(monitoring.record.mock.calls[0][0].duration).toBeGreaterThanOrEqual(
      0,
    );
  });

  it('records the role and school of a signed-in caller, public otherwise', () => {
    run({ user: { id: 5, role: 'teacher', tenantId: SCHOOL } }).finish();
    run().finish();
    expect(monitoring.record.mock.calls[0][0]).toMatchObject({
      role: 'teacher',
      schoolId: SCHOOL,
      userId: '5',
    });
    expect(monitoring.record.mock.calls[1][0]).toMatchObject({
      role: 'public',
      schoolId: '',
    });
  });
});

describe('whoOf: which role and school a request is for', () => {
  it('marks anyone who is not signed in as public, with no school', () => {
    expect(whoOf({})).toEqual({ role: 'public', schoolId: '' });
    expect(whoOf({ user: undefined, query: { school_id: SCHOOL } })).toEqual({
      role: 'public',
      schoolId: '',
    });
  });
  it('uses the role from the signed-in user', () => {
    for (const role of ['admin', 'school_admin', 'teacher', 'student'])
      expect(whoOf({ user: { role } }).role).toBe(role);
    expect(whoOf({ user: { role: 'something_else' } }).role).toBe('public');
  });
  it('gives school admins and students their own school, whatever the request asks for', () => {
    expect(
      whoOf({
        user: { role: 'school_admin', tenantId: SCHOOL },
        query: { school_id: OTHER },
      }).schoolId,
    ).toBe(SCHOOL);
    expect(
      whoOf({ user: { role: 'student', tenantId: SCHOOL } }).schoolId,
    ).toBe(SCHOOL);
  });
  it('gives a teacher the school they asked for, else their main school', () => {
    expect(
      whoOf({
        user: { role: 'teacher', tenantId: SCHOOL },
        query: { school_id: OTHER },
      }).schoolId,
    ).toBe(OTHER);
    expect(
      whoOf({ user: { role: 'teacher', tenantId: SCHOOL }, query: {} })
        .schoolId,
    ).toBe(SCHOOL);
  });
  it('gives an admin a school only when the request names one', () => {
    expect(whoOf({ user: { role: 'admin' } }).schoolId).toBe('');
    expect(
      whoOf({ user: { role: 'admin' }, query: { school_id: SCHOOL } }).schoolId,
    ).toBe(SCHOOL);
  });
  it('ignores a school value that is not a real school id, so labels cannot be invented', () => {
    expect(
      whoOf({ user: { role: 'admin' }, query: { school_id: 'x'.repeat(500) } })
        .schoolId,
    ).toBe('');
    expect(
      whoOf({ user: { role: 'teacher' }, query: { school_id: ['a', 'b'] } })
        .schoolId,
    ).toBe('');
  });
});
