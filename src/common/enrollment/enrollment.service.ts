import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class EnrollmentService {
  constructor(private readonly db: DatabaseService) {}

  private normalizeGrade(grade: string | null): string | null {
    if (!grade) return null;
    return grade.toLowerCase().replace(/\s+/g, '');
  }

  /**
   * Automatically enroll a student in all published courses that are accessible
   * to their school and grade.
   */
  async enrollStudentInRelevantCourses(
    studentId: number,
    schoolId: string,
    grade: string | null,
  ) {
    // Find all CourseAccess records for this school
    const accessRecords = await this.db.courseAccess.findMany({
      where: {
        schoolId,
        course: { isPublished: true },
      },
    });

    const normalizedStudentGrade = this.normalizeGrade(grade);

    for (const access of accessRecords) {
      const courseGrades = Array.isArray(access.grades)
        ? access.grades.filter(Boolean)
        : [];

      const normalizedCourseGrades = courseGrades.map((g) =>
        this.normalizeGrade(g),
      );

      // Enroll if the course is for all grades, or if the student's grade matches.
      const shouldEnroll =
        courseGrades.length === 0 ||
        (normalizedStudentGrade &&
          normalizedCourseGrades.includes(normalizedStudentGrade));

      if (shouldEnroll) {
        await this.db.studentCourse.upsert({
          where: {
            studentId_courseId: {
              studentId,
              courseId: access.courseId,
            },
          },
          create: {
            studentId,
            courseId: access.courseId,
          },
          update: {},
        });
      }
    }
  }

  /**
   * Enroll all students who should have access to a specific course
   * (e.g. when the course is published or its access rules change).
   */
  async enrollRelevantStudentsInCourse(courseId: string) {
    const accessRecords = await this.db.courseAccess.findMany({
      where: { courseId },
    });

    for (const access of accessRecords) {
      const courseGrades = Array.isArray(access.grades)
        ? access.grades.filter(Boolean)
        : [];

      const normalizedCourseGrades = courseGrades.map((g) =>
        this.normalizeGrade(g),
      );

      // Fetch all active students in this school
      const students = await this.db.user.findMany({
        where: {
          role: 'student',
          studentSchools: {
            some: {
              schoolId: access.schoolId,
              isActive: true,
            },
          },
        },
        select: {
          id: true,
          studentSchools: {
            where: { schoolId: access.schoolId, isActive: true },
            select: { grade: true },
          },
        },
      });

      for (const s of students) {
        const studentGrade = s.studentSchools[0]?.grade || null;
        const normalizedStudentGrade = this.normalizeGrade(studentGrade);

        const shouldEnroll =
          courseGrades.length === 0 ||
          (normalizedStudentGrade &&
            normalizedCourseGrades.includes(normalizedStudentGrade));

        if (shouldEnroll) {
          await this.db.studentCourse.upsert({
            where: { studentId_courseId: { studentId: s.id, courseId } },
            create: { studentId: s.id, courseId },
            update: {},
          });
        }
      }
    }
  }
}
