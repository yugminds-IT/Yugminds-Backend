import { MonitoringService, PerformanceMetric } from './monitoring.service';

const at = (iso: string) => new Date(iso).getTime();
const req = (over: Partial<PerformanceMetric> = {}): PerformanceMetric => ({
  endpoint: '/x',
  method: 'GET',
  duration: 100,
  statusCode: 200,
  timestamp: at('2026-11-11T10:15:00Z'),
  role: 'teacher',
  schoolId: 's1',
  ...over,
});

describe('MonitoringService', () => {
  let svc: MonitoringService;
  beforeEach(() => {
    svc = new MonitoringService();
  });

  it('counts everything together when no filter is given', () => {
    svc.record(req());
    svc.record(req({ role: 'student', schoolId: 's2' }));
    svc.record(req({ role: 'public', schoolId: '' }));
    const { metrics, byRole } = svc.getSnapshot();
    expect(metrics.totalRequests).toBe(3);
    expect(byRole).toEqual({
      admin: 0,
      school_admin: 0,
      teacher: 1,
      student: 1,
      public: 1,
    });
  });

  it('filters the numbers, the endpoint table and the recent list by role', () => {
    svc.record(req({ endpoint: '/a', duration: 100 }));
    svc.record(req({ endpoint: '/a', duration: 300, statusCode: 500 }));
    svc.record(req({ role: 'student', endpoint: '/b', duration: 900 }));
    const t = svc.getSnapshot({ role: 'teacher' });
    expect(t.metrics.totalRequests).toBe(2);
    expect(t.metrics.failedRequests).toBe(1);
    expect(t.metrics.averageResponseTime).toBe(200);
    expect(t.metrics.endpointStats.map((e) => e.endpoint)).toEqual(['/a']);
    expect(t.recent).toHaveLength(2);
    expect(t.byRole.student).toBe(1); // the role buttons still show every role
  });

  it('filters by school, and by role and school together', () => {
    svc.record(req());
    svc.record(req({ schoolId: 's2' }));
    svc.record(req({ role: 'student', schoolId: 's2' }));
    expect(svc.getSnapshot({ schoolId: 's2' }).metrics.totalRequests).toBe(2);
    expect(
      svc.getSnapshot({ role: 'teacher', schoolId: 's2' }).metrics
        .totalRequests,
    ).toBe(1);
  });

  it('treats a request with no role as public', () => {
    svc.record(req({ role: undefined, schoolId: undefined }));
    expect(svc.getSnapshot({ role: 'public' }).metrics.totalRequests).toBe(1);
  });

  it('adds up one row per hour, role and school, with speed buckets', () => {
    svc.record(req({ duration: 100 }));
    svc.record(req({ duration: 250, statusCode: 404 }));
    svc.record(req({ duration: 700, statusCode: 500 }));
    svc.record(req({ duration: 1500, timestamp: at('2026-11-11T10:59:59Z') }));
    svc.record(req({ timestamp: at('2026-11-11T11:00:00Z') })); // next hour
    const rows = svc.drainHourly();
    const h10 = rows.find(
      (r) => r.hour.toISOString() === '2026-11-11T10:00:00.000Z',
    )!;
    expect(h10).toMatchObject({
      requests: 4,
      ok: 2,
      clientErrors: 1,
      serverErrors: 1,
      totalMs: 2550,
      maxMs: 1500,
      under200: 1,
      under500: 1,
      under1000: 1,
      over1000: 1,
    });
    expect(rows).toHaveLength(2);
    expect(svc.drainHourly()).toEqual([]); // drained
  });

  it('puts counts back after a failed save, merged with anything new', () => {
    svc.record(req({ duration: 100 }));
    const rows = svc.drainHourly();
    svc.record(req({ duration: 900 })); // arrived while the save was running
    svc.restoreHourly(rows);
    const [row] = svc.drainHourly();
    expect(row).toMatchObject({
      requests: 2,
      totalMs: 1000,
      maxMs: 900,
      under200: 1,
      under1000: 1,
    });
  });
});
