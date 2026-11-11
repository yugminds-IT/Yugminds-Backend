import { MonitoringHistoryService } from './monitoring-history.service';
import { MonitoringService } from './monitoring.service';

describe('MonitoringHistoryService', () => {
  let monitoring: MonitoringService;
  let db: {
    $executeRawUnsafe: jest.Mock;
    $queryRawUnsafe: jest.Mock;
    school: { findMany: jest.Mock };
  };
  let svc: MonitoringHistoryService;
  const hourStart = () => Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const rec = (over = {}) =>
    monitoring.record({
      endpoint: '/x',
      method: 'GET',
      duration: 120,
      statusCode: 200,
      timestamp: Date.now(),
      role: 'teacher',
      schoolId: 's1',
      ...over,
    });

  beforeEach(() => {
    delete process.env.MONITORING_HISTORY;
    delete process.env.MONITORING_RETENTION_DAYS;
    monitoring = new MonitoringService();
    db = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      school: { findMany: jest.fn().mockResolvedValue([]) },
    };
    svc = new MonitoringHistoryService(db as never, monitoring);
  });

  describe('saving', () => {
    it('adds the live counts to the hourly rows (an upsert that adds, never overwrites)', async () => {
      rec();
      rec({ statusCode: 500 });
      await svc.flush();
      expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(1);
      const [sql, ...params] = db.$executeRawUnsafe.mock.calls[0];
      expect(sql).toContain(
        'ON CONFLICT ("hour","role","schoolId") DO UPDATE SET',
      );
      expect(sql).toContain(
        '"requests" = "ApiHourlyStat"."requests" + EXCLUDED."requests"',
      );
      expect(sql).toContain('GREATEST(');
      expect(params).toContain('teacher');
      expect(params).toContain(2); // requests
      expect(monitoring.drainHourly()).toEqual([]); // nothing left to save
    });

    it('does nothing when there is nothing to save', async () => {
      await svc.flush();
      expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('keeps the counts for the next try when the save fails', async () => {
      db.$executeRawUnsafe.mockRejectedValueOnce(new Error('connection lost'));
      rec();
      await svc.flush(true);
      expect(monitoring.drainHourly()).toHaveLength(1);
    });

    it('waits quietly while the table does not exist yet, and keeps counting', async () => {
      db.$executeRawUnsafe.mockRejectedValue(
        new Error('relation "ApiHourlyStat" does not exist'),
      );
      rec();
      await svc.flush();
      await svc.flush(); // paused: no second attempt
      expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(1);
      expect(monitoring.drainHourly()).toHaveLength(1); // nothing lost
    });

    it('does not run two saves at once', async () => {
      let release: () => void = () => undefined;
      db.$executeRawUnsafe.mockImplementation(
        () =>
          new Promise((r) => {
            release = () => r(1);
          }),
      );
      rec();
      const a = svc.flush();
      const b = svc.flush();
      release();
      await Promise.all([a, b]);
      expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    });

    it('can be switched off', async () => {
      process.env.MONITORING_HISTORY = 'off';
      rec();
      await svc.flush();
      expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    });
  });

  describe('auto-delete', () => {
    it('deletes rows older than 7 days by default', async () => {
      await svc.purge();
      const [sql, cutoff] = db.$executeRawUnsafe.mock.calls[0];
      expect(sql).toBe('DELETE FROM "ApiHourlyStat" WHERE "hour" < $1');
      expect(Date.now() - (cutoff as Date).getTime()).toBeGreaterThan(
        7 * 86_400_000 - 5000,
      );
      expect(Date.now() - (cutoff as Date).getTime()).toBeLessThan(
        7 * 86_400_000 + 5000,
      );
    });

    it('uses MONITORING_RETENTION_DAYS, kept between 1 and 90 days', () => {
      process.env.MONITORING_RETENTION_DAYS = '3';
      expect(
        new MonitoringHistoryService(db as never, monitoring).retentionDays,
      ).toBe(3);
      process.env.MONITORING_RETENTION_DAYS = '9999';
      expect(
        new MonitoringHistoryService(db as never, monitoring).retentionDays,
      ).toBe(90);
      process.env.MONITORING_RETENTION_DAYS = '0';
      expect(
        new MonitoringHistoryService(db as never, monitoring).retentionDays,
      ).toBe(7); // 0 or junk falls back to the default
    });
  });

  describe('history', () => {
    const row = (over = {}) => ({
      hour: new Date(hourStart()),
      role: 'teacher',
      schoolId: 's1',
      requests: 10,
      ok: 8,
      clientErrors: 1,
      serverErrors: 1,
      totalMs: 2000,
      maxMs: 900,
      under200: 6,
      under500: 2,
      under1000: 1,
      over1000: 1,
      ...over,
    });

    it('returns one point per hour, filling quiet hours with zeros', async () => {
      db.$queryRawUnsafe.mockResolvedValue([row()]);
      const r = await svc.history({ hours: 6 });
      expect(r.available).toBe(true);
      expect(r.series).toHaveLength(6);
      expect(r.series.slice(0, 5).every((p) => p.requests === 0)).toBe(true);
      expect(r.series[5]).toMatchObject({
        requests: 10,
        server_errors: 1,
        client_errors: 1,
        avg_ms: 200,
        slow: 2,
        over_1s: 1,
        max_ms: 900,
      });
    });

    it('splits totals by role and by school, with school names', async () => {
      db.$queryRawUnsafe.mockResolvedValue([
        row(),
        row({
          role: 'student',
          schoolId: 's2',
          requests: 30,
          totalMs: 3000,
          under1000: 0,
          over1000: 0,
        }),
      ]);
      db.school.findMany.mockResolvedValue([
        { id: 's1', name: 'Alpha' },
        { id: 's2', name: 'Beta' },
      ]);
      const r = await svc.history({ hours: 24 });
      expect(r.by_role.map((x) => [x.role, x.requests])).toEqual(
        [
          ['student', 30],
          ['teacher', 10],
        ].sort(
          (a, b) =>
            ['admin', 'school_admin', 'teacher', 'student', 'public'].indexOf(
              a[0] as string,
            ) -
            ['admin', 'school_admin', 'teacher', 'student', 'public'].indexOf(
              b[0] as string,
            ),
        ),
      );
      expect(r.by_school.map((x) => [x.school_name, x.requests])).toEqual([
        ['Beta', 30],
        ['Alpha', 10],
      ]);
      expect(r.totals.requests).toBe(40);
    });

    it('asks the database for the chosen role and school only', async () => {
      await svc.history({ hours: 24, role: 'teacher', schoolId: 's1' });
      const [sql, ...params] = db.$queryRawUnsafe.mock.calls[0];
      expect(sql).toContain('"role" = $2');
      expect(sql).toContain('"schoolId" = $3');
      expect(params.slice(1)).toEqual(['teacher', 's1']);
    });

    it('never looks back further than the retention period', async () => {
      const r = await svc.history({ hours: 100000 });
      expect(r.hours).toBe(7 * 24);
    });

    it('says history is not available yet when the table is missing', async () => {
      db.$queryRawUnsafe.mockRejectedValue(
        new Error('relation "ApiHourlyStat" does not exist'),
      );
      const r = await svc.history({ hours: 24 });
      expect(r.available).toBe(false);
      expect(r.series).toEqual([]);
    });

    it('saves the latest live counts first so the newest hour is included', async () => {
      rec();
      await svc.history({ hours: 1 });
      expect(db.$executeRawUnsafe).toHaveBeenCalled(); // the flush happened before the read
    });
  });
});
