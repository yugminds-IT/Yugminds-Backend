import { of, throwError, firstValueFrom } from 'rxjs';
import { CallHandler, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { MonitoringInterceptor } from './monitoring.interceptor';
import { MonitoringService } from './monitoring.service';

describe('MonitoringInterceptor', () => {
  let monitoring: { record: jest.Mock };
  let interceptor: MonitoringInterceptor;

  function makeContext(overrides: {
    method?: string;
    url?: string;
    userId?: string;
    /** Express route template; pass null for an unmatched request. */
    route?: string | null;
  } = {}) {
    const finishHandlers: Array<() => void> = [];
    const res: any = {
      statusCode: 200,
      on: jest.fn((event: string, cb: () => void) => {
        if (event === 'finish') finishHandlers.push(cb);
      }),
    };
    const req: any = {
      method: overrides.method ?? 'GET',
      originalUrl: overrides.url ?? '/some/path',
      user: overrides.userId ? { id: overrides.userId } : undefined,
      route:
        overrides.route === null
          ? undefined
          : { path: overrides.route ?? overrides.url ?? '/some/path' },
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    } as unknown as ExecutionContext;

    return { context, res, fireFinish: () => finishHandlers.forEach((cb) => cb()) };
  }

  beforeEach(() => {
    monitoring = { record: jest.fn() };
    interceptor = new MonitoringInterceptor(monitoring as unknown as MonitoringService);
  });

  it('records the real final status code for a plain success response', async () => {
    const { context, res, fireFinish } = makeContext({ url: '/admin/users' });
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    const result$ = interceptor.intercept(context, handler);
    await firstValueFrom(result$);

    res.statusCode = 200;
    fireFinish();

    expect(monitoring.record).toHaveBeenCalledTimes(1);
    expect(monitoring.record.mock.calls[0][0]).toMatchObject({
      endpoint: '/admin/users',
      method: 'GET',
      statusCode: 200,
    });
  });

  it('records the real thrown-error status code, not 200', async () => {
    const { context, res, fireFinish } = makeContext({ url: '/admin/secret' });
    const err = new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    const handler: CallHandler = { handle: () => throwError(() => err) };

    const result$ = interceptor.intercept(context, handler);
    await expect(firstValueFrom(result$)).rejects.toBe(err);

    // Nest's exception filter sets the real status on the response AFTER the
    // interceptor pipeline rejects — simulate that, then the 'finish' event.
    res.statusCode = 403;
    fireFinish();

    expect(monitoring.record).toHaveBeenCalledTimes(1);
    expect(monitoring.record.mock.calls[0][0]).toMatchObject({
      endpoint: '/admin/secret',
      statusCode: 403,
      error: 'Forbidden',
    });
  });

  it('never records requests to the excluded monitoring-dashboard endpoint (no feedback loop)', async () => {
    const { context, res, fireFinish } = makeContext({ url: '/admin/monitoring-dashboard' });
    const handler: CallHandler = { handle: () => of({ metrics: {} }) };

    const result$ = interceptor.intercept(context, handler);
    await firstValueFrom(result$);

    fireFinish();

    // res.on('finish', ...) should never even have been registered for this path.
    expect(res.on).not.toHaveBeenCalled();
    expect(monitoring.record).not.toHaveBeenCalled();
  });

  it('captures a non-negative duration', async () => {
    const { context, res, fireFinish } = makeContext({ url: '/admin/reports' });
    const handler: CallHandler = { handle: () => of({}) };

    const result$ = interceptor.intercept(context, handler);
    await firstValueFrom(result$);
    fireFinish();

    const recorded = monitoring.record.mock.calls[0][0];
    expect(typeof recorded.duration).toBe('number');
    expect(recorded.duration).toBeGreaterThanOrEqual(0);
  });

  it('labels metrics by the matched route template, never the raw path', async () => {
    const { context, fireFinish } = makeContext({
      url: '/admin/courses/42/students/9f8b2b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b',
      route: '/admin/courses/:courseId/students/:studentId',
    });
    const handler: CallHandler = { handle: () => of({}) };

    await firstValueFrom(interceptor.intercept(context, handler));
    fireFinish();

    expect(monitoring.record.mock.calls[0][0].endpoint).toBe(
      '/admin/courses/:courseId/students/:studentId',
    );
  });

  it('folds unmatched (attacker-chosen) paths into one fixed bucket', async () => {
    const { context, fireFinish } = makeContext({
      url: '/verify/ZZZZ0001',
      route: null,
    });
    const handler: CallHandler = { handle: () => of({}) };

    await firstValueFrom(interceptor.intercept(context, handler));
    fireFinish();

    expect(monitoring.record.mock.calls[0][0].endpoint).toBe('(unmatched)');
  });
});
