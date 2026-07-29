import { Test, TestingModule } from '@nestjs/testing';
import { AdminDashboardService } from './dashboard.service';
import { DatabaseService } from '../../database/database.service';
import { MonitoringService } from '../../common/monitoring/monitoring.service';
import { StudentRankingService } from '../../common/assignment/student-ranking.service';

describe('AdminDashboardService', () => {
  let service: AdminDashboardService;
  let db: {
    tenant: { count: jest.Mock; findMany: jest.Mock };
    user: { count: jest.Mock; findMany: jest.Mock };
    course: { count: jest.Mock };
    attendance: { findMany: jest.Mock };
    courseProgress: { findMany: jest.Mock };
    school: { findMany: jest.Mock };
    studentSchool: { groupBy: jest.Mock };
    studentCourse: { groupBy: jest.Mock };
    $queryRaw: jest.Mock;
  };
  let monitoring: { getSnapshot: jest.Mock };

  // Tenant/user/course .count() is called twice each: once for the current
  // (unfiltered) total, once for the "as of last month" total (where.createdAt
  // set). Discriminate on that to return different numbers for each.
  function countMock(currentTotal: number, asOfLastMonth: number) {
    return jest.fn((args?: { where?: { createdAt?: unknown } }) =>
      Promise.resolve(args?.where?.createdAt ? asOfLastMonth : currentTotal),
    );
  }

  beforeEach(async () => {
    db = {
      tenant: {
        count: countMock(3, 0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: {
        count: countMock(3, 0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      course: { count: countMock(2, 0) },
      attendance: { findMany: jest.fn().mockResolvedValue([]) },
      courseProgress: { findMany: jest.fn().mockResolvedValue([]) },
      school: { findMany: jest.fn().mockResolvedValue([]) },
      studentSchool: { groupBy: jest.fn().mockResolvedValue([]) },
      studentCourse: { groupBy: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    monitoring = {
      getSnapshot: jest.fn().mockReturnValue({
        metrics: { totalRequests: 0, successfulRequests: 0 },
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminDashboardService,
        { provide: DatabaseService, useValue: db },
        { provide: MonitoringService, useValue: monitoring },
        {
          provide: StudentRankingService,
          useValue: { getSystemLeaderboard: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();

    service = module.get<AdminDashboardService>(AdminDashboardService);
  });

  describe('trends — cumulative total vs a month ago', () => {
    it('returns null (not a flat 100) when there is no prior-month baseline', async () => {
      // All entities: 3 now, 0 as of last month — a genuine zero baseline.
      const result = (await service.getAnalytics()) as {
        trends: { schoolsChange: number | null };
      };
      expect(result.trends.schoolsChange).toBeNull();
    });

    it('computes a real percentage from two non-zero cumulative totals', async () => {
      db.tenant.count = countMock(3, 2); // 2 -> 3 is +50%, not "+100%"
      const result = (await service.getAnalytics()) as {
        trends: { schoolsChange: number | null };
      };
      expect(result.trends.schoolsChange).toBe(50);
    });

    it('does not derive trends from monthly new-signup deltas', async () => {
      // Even if monthlyGrowth (from $queryRaw) reported a huge new-signup
      // spike, the cumulative-total-based trend must ignore it and use the
      // count()-based before/after totals instead.
      db.$queryRaw.mockResolvedValue([{ month: 'Jul 26', count: BigInt(999) }]);
      db.tenant.count = countMock(3, 3); // no actual change in the total
      const result = (await service.getAnalytics()) as {
        trends: { schoolsChange: number | null };
      };
      expect(result.trends.schoolsChange).toBe(0);
    });
  });

  describe('generatedAt', () => {
    it('includes a generatedAt timestamp in the response', async () => {
      const result = (await service.getAnalytics()) as { generatedAt?: string };
      expect(typeof result.generatedAt).toBe('string');
      expect(Number.isNaN(Date.parse(result.generatedAt!))).toBe(false);
    });
  });

  describe('cache / force refresh', () => {
    it('serves cached data on a second default-range call within the TTL', async () => {
      await service.getAnalytics();
      const callsAfterFirst = db.tenant.count.mock.calls.length;

      await service.getAnalytics();
      expect(db.tenant.count.mock.calls.length).toBe(callsAfterFirst); // no new queries
    });

    it('bypasses the cache and re-queries when force=true', async () => {
      await service.getAnalytics();
      const callsAfterFirst = db.tenant.count.mock.calls.length;

      await service.getAnalytics(undefined, undefined, true);
      expect(db.tenant.count.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });

    it('does not use the cache when a date range is given', async () => {
      await service.getAnalytics();
      const callsAfterFirst = db.tenant.count.mock.calls.length;

      await service.getAnalytics('2026-01-01', '2026-01-31');
      expect(db.tenant.count.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });
});
