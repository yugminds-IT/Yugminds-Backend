import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class EnrollmentService {
  constructor(private readonly db: DatabaseService) {}

  private normalizeGrade(grade: string | null): string | null {
    if (!grade) return null;
    return grade.toLowerCase().replace(/\s+/g, '');
  }

  private shouldEnrollForGrade(
    courseGrades: string[],
    studentGrade: string | null,
  ): boolean {
    const normalizedStudentGrade = this.normalizeGrade(studentGrade);
    const normalizedCourseGrades = courseGrades.map((g) =>
      this.normalizeGrade(g),
    );
    return (
      courseGrades.length === 0 ||
      (!!normalizedStudentGrade &&
        normalizedCourseGrades.includes(normalizedStudentGrade))
    );
  }

  /**
   * Automatically enroll a student in all published courses that are accessible
   * to their school and grade. Grade filtering uses the CourseAccessGrade
   * junction table instead of the old CourseAccess.grades string array.
   */
  async enrollStudentInRelevantCourses(
    studentId: number,
    schoolId: string,
    grade: string | null,
  ) {
    const accessRecords = await this.db.courseAccess.findMany({
      where: {
        schoolId,
        course: { isPublished: true },
      },
      include: { gradeAccess: true },
    });

    const courseIdsToEnroll: string[] = [];
    for (const access of accessRecords) {
      const courseGrades = access.gradeAccess.map((g) => g.gradeName);
      if (this.shouldEnrollForGrade(courseGrades, grade)) {
        courseIdsToEnroll.push(access.courseId);
      }
    }

    if (courseIdsToEnroll.length === 0) return;

    await this.db.studentCourse.createMany({
      data: courseIdsToEnroll.map((courseId) => ({ studentId, courseId })),
      skipDuplicates: true,
    });
  }

  /**
   * Enroll all students who should have access to a specific course
   * (e.g. when the course is published or its access rules change).
   * Grade filtering uses the CourseAccessGrade junction table.
   */
  async enrollRelevantStudentsInCourse(
    courseId: string,
    schoolIdFilter?: string,
  ): Promise<number> {
    const accessRecords = await this.db.courseAccess.findMany({
      where: {
        courseId,
        ...(schoolIdFilter ? { schoolId: schoolIdFilter } : {}),
      },
      include: { gradeAccess: true },
    });

    let inserted = 0;

    for (const access of accessRecords) {
      const courseGrades = access.gradeAccess.map((g) => g.gradeName);

      const students = await this.db.user.findMany({
        where: {
          role: 'student',
          isActive: true,
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

      const rows: { studentId: number; courseId: string }[] = [];
      for (const s of students) {
        const studentGrade = s.studentSchools[0]?.grade ?? null;
        if (this.shouldEnrollForGrade(courseGrades, studentGrade)) {
          rows.push({ studentId: s.id, courseId });
        }
      }

      if (rows.length > 0) {
        const result = await this.db.studentCourse.createMany({
          data: rows,
          skipDuplicates: true,
        });
        inserted += result.count;
      }
    }

    return inserted;
  }

  /**
   * Bulk-enroll all active students into every published course they can access.
   * Uses a single INSERT…SELECT for speed (2000+ students × multiple courses).
   */
  async bulkSyncPublishedEnrollments(schoolId?: string): Promise<number> {
    const result = schoolId
      ? await this.db.$executeRaw`
          INSERT INTO "StudentCourse" ("id", "studentId", "courseId", "enrolledAt")
          SELECT gen_random_uuid(), u.id, co.id, NOW()
          FROM "User" u
          JOIN "StudentSchool" ss ON ss."studentId" = u.id AND ss."isActive" = true
          JOIN "CourseAccess" ca ON ca."schoolId" = ss."schoolId"
          JOIN "Course" co ON co.id = ca."courseId" AND co."isPublished" = true
          LEFT JOIN "CourseAccessGrade" cag ON cag."courseAccessId" = ca.id
          WHERE u.role = 'student' AND u."isActive" = true
            AND ss."schoolId" = ${schoolId}
          GROUP BY u.id, co.id, ss.grade, ca.id
          HAVING
            COUNT(cag.id) = 0
            OR BOOL_OR(
              lower(replace(cag."gradeName", ' ', '')) = lower(replace(ss.grade, ' ', ''))
            )
          ON CONFLICT ("studentId", "courseId") DO NOTHING
        `
      : await this.db.$executeRaw`
          INSERT INTO "StudentCourse" ("id", "studentId", "courseId", "enrolledAt")
          SELECT gen_random_uuid(), u.id, co.id, NOW()
          FROM "User" u
          JOIN "StudentSchool" ss ON ss."studentId" = u.id AND ss."isActive" = true
          JOIN "CourseAccess" ca ON ca."schoolId" = ss."schoolId"
          JOIN "Course" co ON co.id = ca."courseId" AND co."isPublished" = true
          LEFT JOIN "CourseAccessGrade" cag ON cag."courseAccessId" = ca.id
          WHERE u.role = 'student' AND u."isActive" = true
          GROUP BY u.id, co.id, ss.grade, ca.id
          HAVING
            COUNT(cag.id) = 0
            OR BOOL_OR(
              lower(replace(cag."gradeName", ' ', '')) = lower(replace(ss.grade, ' ', ''))
            )
          ON CONFLICT ("studentId", "courseId") DO NOTHING
        `;

    return typeof result === 'number' ? result : 0;
  }
}
