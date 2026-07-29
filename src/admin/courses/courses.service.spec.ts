import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AdminCoursesService } from './courses.service';
import { DatabaseService } from '../../database/database.service';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { EnrollmentService } from '../../common/enrollment/enrollment.service';

describe('AdminCoursesService', () => {
  let service: AdminCoursesService;
  let db: {
    course: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
    };
    user: { findMany: jest.Mock };
    schoolAdmin: { findMany: jest.Mock };
  };

  const baseCourseRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'course-1',
    title: 'Scratch Basics',
    description: null,
    thumbnailUrl: null,
    isPublished: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    chapters: [],
    courseAccess: [],
    ...overrides,
  });

  beforeEach(async () => {
    db = {
      course: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(baseCourseRow()),
        create: jest.fn().mockResolvedValue({ id: 'course-1' }),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      schoolAdmin: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminCoursesService,
        { provide: DatabaseService, useValue: db },
        {
          provide: RealtimeGateway,
          useValue: { emitDashboardStatsForUsers: jest.fn() },
        },
        {
          provide: EnrollmentService,
          useValue: { enrollRelevantStudentsInCourse: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<AdminCoursesService>(AdminCoursesService);
  });

  describe('create — name uniqueness', () => {
    it('rejects a name that collides with a live course', async () => {
      db.course.findFirst.mockResolvedValue(baseCourseRow());
      await expect(service.create({ name: 'Scratch Basics' })).rejects.toThrow(
        BadRequestException,
      );
      expect(db.course.create).not.toHaveBeenCalled();
    });

    it('allows reusing the name of a soft-deleted (trashed) course', async () => {
      // The pre-check itself filters deletedAt: null, so a trashed course
      // with the same title must not be returned by findFirst here.
      db.course.findFirst.mockResolvedValue(null);
      await service.create({ name: 'Scratch Basics' });
      expect(db.course.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null }),
        }),
      );
      expect(db.course.create).toHaveBeenCalled();
    });

    it('translates a DB-level unique-constraint violation (race condition) into a friendly error', async () => {
      db.course.findFirst.mockResolvedValue(null); // pre-check passes...
      const p2002 = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
      });
      db.course.create.mockRejectedValue(p2002); // ...but a concurrent insert wins the race.

      await expect(service.create({ name: 'Scratch Basics' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('propagates unrelated DB errors instead of masking them as a name conflict', async () => {
      db.course.findFirst.mockResolvedValue(null);
      const dbDown = new Error('connection refused');
      db.course.create.mockRejectedValue(dbDown);

      await expect(service.create({ name: 'Scratch Basics' })).rejects.toBe(dbDown);
    });
  });

  describe('list — truncation visibility', () => {
    it('reports truncated: false when the course count is under the cap', async () => {
      db.course.findMany.mockResolvedValue([baseCourseRow()]);
      const result = await service.list(5);
      expect(result.truncated).toBe(false);
      expect(result.courses).toHaveLength(1);
    });

    it('reports truncated: true and trims to the cap when more rows exist than the limit', async () => {
      const rows = Array.from({ length: 6 }, (_, i) =>
        baseCourseRow({ id: `course-${i}` }),
      );
      db.course.findMany.mockResolvedValue(rows); // 6 rows for a cap of 5 (take: cap + 1)
      const result = await service.list(5);
      expect(result.truncated).toBe(true);
      expect(result.courses).toHaveLength(5);
    });
  });
});
