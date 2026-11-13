import { TeacherExtraController } from './teacher-extra.controller';

const sec = (grade: string, name: string) => ({
  schoolId: 's1',
  section: { name, grade: { name: grade } },
});

describe('TeacherExtraController.teacherStudentIds', () => {
  const make = (assigned: any[], enrolled: any[]) => {
    const db = {
      teacherSectionAssignment: {
        findMany: jest.fn().mockResolvedValue(assigned),
      },
      studentSchool: { findMany: jest.fn().mockResolvedValue(enrolled) },
    };
    return new TeacherExtraController(
      db as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
    );
  };
  const enr = (studentId: number, grade: string, section: string) => ({
    studentId,
    schoolId: 's1',
    grade,
    section,
  });

  it('is grade-aware and tolerant of "Section A" vs "A"', async () => {
    const c = make(
      [sec('Grade 5', 'Section A')],
      [
        enr(1, 'Grade 5', 'Section A'),
        enr(2, 'Grade 5', 'A'),
        enr(3, 'Grade 8', 'Section A'),
        enr(4, 'Grade 5', 'Section B'),
      ],
    );
    const out = await (c as any).teacherStudentIds(9);
    expect([...out.get('s1')].sort()).toEqual([1, 2]);
  });

  it('returns nothing when the teacher has no sections', async () => {
    const out = await (make([], []) as any).teacherStudentIds(9);
    expect(out.size).toBe(0);
  });
});
