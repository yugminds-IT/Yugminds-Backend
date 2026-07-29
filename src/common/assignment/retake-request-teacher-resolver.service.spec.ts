import { Test, TestingModule } from '@nestjs/testing';
import { RetakeRequestTeacherResolver } from './retake-request-teacher-resolver.service';
import { DatabaseService } from '../../database/database.service';

describe('RetakeRequestTeacherResolver', () => {
  let resolver: RetakeRequestTeacherResolver;
  let db: {
    studentSchool: { findFirst: jest.Mock; findMany: jest.Mock };
    section: { findFirst: jest.Mock };
    teacherSectionAssignment: { findMany: jest.Mock };
    teacherSchool: { findMany: jest.Mock };
    chapter: { findUnique: jest.Mock };
    courseAccess: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    db = {
      studentSchool: { findFirst: jest.fn(), findMany: jest.fn() },
      section: { findFirst: jest.fn() },
      teacherSectionAssignment: { findMany: jest.fn() },
      teacherSchool: { findMany: jest.fn() },
      chapter: { findUnique: jest.fn() },
      courseAccess: { findMany: jest.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetakeRequestTeacherResolver,
        { provide: DatabaseService, useValue: db },
      ],
    }).compile();
    resolver = module.get<RetakeRequestTeacherResolver>(RetakeRequestTeacherResolver);
  });

  it('returns the assignment teacher directly when one is set, skipping section resolution', async () => {
    const result = await resolver.resolve(1, {
      teacherId: 42,
      schoolId: 'school-a',
    });
    expect(result).toEqual({ schoolId: 'school-a', teacherIds: [42] });
    expect(db.studentSchool.findFirst).not.toHaveBeenCalled();
  });

  it('resolves the section-mapped teacher(s) when the assignment already has a schoolId', async () => {
    db.studentSchool.findFirst.mockResolvedValue({ grade: 'Grade 4', section: 'A' });
    db.section.findFirst.mockResolvedValue({ id: 'section-1' });
    db.teacherSectionAssignment.findMany.mockResolvedValue([
      { teacherId: 7 },
      { teacherId: 8 },
      { teacherId: 7 }, // duplicate, should be deduped
    ]);

    const result = await resolver.resolve(1, { teacherId: null, schoolId: 'school-a' });

    expect(result).toEqual({ schoolId: 'school-a', teacherIds: [7, 8] });
    expect(db.section.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: 'A', grade: { schoolId: 'school-a', name: 'Grade 4' } },
      }),
    );
  });

  it('resolves the school from the course when the assignment has no schoolId (course-chapter assignment)', async () => {
    db.chapter.findUnique.mockResolvedValue({ courseId: 'course-1' });
    db.courseAccess.findMany.mockResolvedValue([
      { schoolId: 'school-x' },
      { schoolId: 'school-a' },
    ]);
    db.studentSchool.findMany.mockResolvedValue([{ schoolId: 'school-a' }]);
    db.studentSchool.findFirst.mockResolvedValue({ grade: 'Grade 4', section: 'A' });
    db.section.findFirst.mockResolvedValue({ id: 'section-1' });
    db.teacherSectionAssignment.findMany.mockResolvedValue([{ teacherId: 9 }]);

    const result = await resolver.resolve(1, {
      teacherId: null,
      schoolId: null,
      chapterId: 'chapter-1',
      courseId: null,
    });

    expect(db.chapter.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'chapter-1' } }),
    );
    expect(result).toEqual({ schoolId: 'school-a', teacherIds: [9] });
  });

  it('returns no school/teachers when the course has no access matching any of the student\'s schools', async () => {
    db.courseAccess.findMany.mockResolvedValue([{ schoolId: 'school-x' }]);
    db.studentSchool.findMany.mockResolvedValue([{ schoolId: 'school-a' }]);

    const result = await resolver.resolve(1, {
      teacherId: null,
      schoolId: null,
      courseId: 'course-1',
    });

    expect(result).toEqual({ schoolId: null, teacherIds: [] });
  });

  it('falls back to any teacher at the school when no section mapping exists', async () => {
    db.studentSchool.findFirst.mockResolvedValue({ grade: 'Grade 4', section: 'A' });
    db.section.findFirst.mockResolvedValue(null); // no matching Section row
    db.teacherSchool.findMany.mockResolvedValue([{ teacherId: 11 }, { teacherId: 12 }]);

    const result = await resolver.resolve(1, { teacherId: null, schoolId: 'school-a' });

    expect(result).toEqual({ schoolId: 'school-a', teacherIds: [11, 12] });
  });

  it('falls back to any teacher at the school when the student has no enrollment record', async () => {
    db.studentSchool.findFirst.mockResolvedValue(null);
    db.teacherSchool.findMany.mockResolvedValue([{ teacherId: 99 }]);

    const result = await resolver.resolve(1, { teacherId: null, schoolId: 'school-a' });

    expect(result).toEqual({ schoolId: 'school-a', teacherIds: [99] });
    expect(db.section.findFirst).not.toHaveBeenCalled();
  });

  it('returns nothing when the assignment has no teacher, no schoolId and no course/chapter to resolve from', async () => {
    const result = await resolver.resolve(1, { teacherId: null, schoolId: null });
    expect(result).toEqual({ schoolId: null, teacherIds: [] });
  });
});
