import { Test, TestingModule } from '@nestjs/testing';
import { AdminTeacherReportsService } from './admin-teacher-reports.service';
import { DatabaseService } from '../../database/database.service';

describe('AdminTeacherReportsService', () => {
  let service: AdminTeacherReportsService;
  let db: {
    teacherReport: { findMany: jest.Mock; deleteMany: jest.Mock };
    user: { findMany: jest.Mock };
    school: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    db = {
      teacherReport: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      school: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminTeacherReportsService,
        { provide: DatabaseService, useValue: db },
      ],
    }).compile();

    service = module.get<AdminTeacherReportsService>(
      AdminTeacherReportsService,
    );
  });

  describe('list', () => {
    it('marks a report as teacher_deleted/school_deleted when the ids no longer resolve', async () => {
      db.teacherReport.findMany.mockResolvedValue([
        {
          id: 'r1',
          teacherId: 999,
          schoolId: 'missing-school',
          reportDate: new Date('2026-07-27T12:00:00Z'),
          grade: 'Grade 1',
          topicsTaught: 'Fractions',
          studentCount: null,
          durationHours: null,
          notes: null,
          adminNotes: null,
          status: 'submitted',
          createdAt: new Date(),
        },
      ]);
      db.user.findMany.mockResolvedValue([]);
      db.school.findMany.mockResolvedValue([]);

      const result = await service.list({});

      expect(result.reports[0].teacher_deleted).toBe(true);
      expect(result.reports[0].school_deleted).toBe(true);
      expect(result.reports[0].teacher_name).toBe('');
      expect(result.reports[0].school_name).toBe('');
      expect(result.reports[0].profiles).toBeNull();
    });

    it('does not flag a report whose teacher/school still exist', async () => {
      db.teacherReport.findMany.mockResolvedValue([
        {
          id: 'r1',
          teacherId: 1,
          schoolId: 'school-1',
          reportDate: new Date('2026-07-27T12:00:00Z'),
          grade: 'Grade 1',
          topicsTaught: 'Fractions',
          studentCount: 20,
          durationHours: 1,
          notes: null,
          adminNotes: null,
          status: 'submitted',
          createdAt: new Date(),
        },
      ]);
      db.user.findMany.mockResolvedValue([
        { id: 1, email: 'teacher@x.com', profile: { fullName: 'Teacher One' } },
      ]);
      db.school.findMany.mockResolvedValue([
        { id: 'school-1', name: 'Sunrise Academy', schoolCode: 'SUN' },
      ]);

      const result = await service.list({});

      expect(result.reports[0].teacher_deleted).toBe(false);
      expect(result.reports[0].school_deleted).toBe(false);
      expect(result.reports[0].teacher_name).toBe('Teacher One');
    });

    it('filters server-side by search term across teacher/school/grade/topics/notes', async () => {
      db.teacherReport.findMany.mockResolvedValue([
        {
          id: 'r1',
          teacherId: 1,
          schoolId: 'school-1',
          reportDate: new Date('2026-07-27T12:00:00Z'),
          grade: 'Grade 1',
          topicsTaught: 'Fractions',
          studentCount: 20,
          durationHours: 1,
          notes: null,
          adminNotes: null,
          status: 'submitted',
          createdAt: new Date(),
        },
      ]);
      db.user.findMany.mockResolvedValue([
        { id: 1, email: 'teacher@x.com', profile: { fullName: 'Teacher One' } },
      ]);
      db.school.findMany.mockResolvedValue([
        { id: 'school-1', name: 'Sunrise Academy', schoolCode: 'SUN' },
      ]);

      const noMatch = await service.list({ search: 'nonexistent' });
      expect(noMatch.reports).toHaveLength(0);

      const match = await service.list({ search: 'fractions' });
      expect(match.reports).toHaveLength(1);
    });
  });

  describe('cleanupOrphaned', () => {
    it('deletes only the reports whose teacher or school no longer exists', async () => {
      db.teacherReport.findMany.mockResolvedValue([
        { id: 'r1', teacherId: 1, schoolId: 'school-1' },
        { id: 'r2', teacherId: 999, schoolId: 'school-1' },
        { id: 'r3', teacherId: 1, schoolId: 'missing-school' },
      ]);
      db.user.findMany.mockResolvedValue([{ id: 1 }]);
      db.school.findMany.mockResolvedValue([{ id: 'school-1' }]);

      const result = await service.cleanupOrphaned();

      expect(result).toEqual({ success: true, deleted: 2 });
      expect(db.teacherReport.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['r2', 'r3'] } },
      });
    });

    it('does not call deleteMany when nothing is orphaned', async () => {
      db.teacherReport.findMany.mockResolvedValue([
        { id: 'r1', teacherId: 1, schoolId: 'school-1' },
      ]);
      db.user.findMany.mockResolvedValue([{ id: 1 }]);
      db.school.findMany.mockResolvedValue([{ id: 'school-1' }]);

      const result = await service.cleanupOrphaned();

      expect(result).toEqual({ success: true, deleted: 0 });
      expect(db.teacherReport.deleteMany).not.toHaveBeenCalled();
    });

    it('short-circuits with 0 when there are no reports at all', async () => {
      db.teacherReport.findMany.mockResolvedValue([]);

      const result = await service.cleanupOrphaned();

      expect(result).toEqual({ success: true, deleted: 0 });
      expect(db.user.findMany).not.toHaveBeenCalled();
    });
  });
});
