import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

/**
 * A course's grant for one school: which grades, and (optionally) which
 * sections within each grade. `sectionNames` empty for a grade = the whole
 * grade (every section) — this is how every course created before section
 * targeting existed continues to behave.
 */
export interface CourseGradeGrant {
  gradeName: string;
  sectionNames: string[];
}

@Injectable()
export class EnrollmentService {
  constructor(private readonly db: DatabaseService) {}

  private normalize(value: string | null): string | null {
    if (!value) return null;
    return value.toLowerCase().replace(/\s+/g, '');
  }

  /**
   * Whether a student in `studentGrade`/`studentSection` should be enrolled
   * given a course's per-grade grants for their school:
   *  - no grants at all       → whole school (enroll)
   *  - grade must match a grant by normalized name
   *  - if that grant lists sections → studentSection must be one of them
   *  - if it lists no sections      → grade-wide (enroll)
   */
  shouldEnroll(
    courseGrades: CourseGradeGrant[],
    studentGrade: string | null,
    studentSection: string | null,
  ): boolean {
    if (courseGrades.length === 0) return true;

    const normStudentGrade = this.normalize(studentGrade);
    if (!normStudentGrade) return false;

    const matchedGrade = courseGrades.find(
      (g) => this.normalize(g.gradeName) === normStudentGrade,
    );
    if (!matchedGrade) return false;

    if (matchedGrade.sectionNames.length === 0) return true; // grade-wide

    const normStudentSection = this.normalize(studentSection);
    if (!normStudentSection) return false;
    return matchedGrade.sectionNames.some(
      (s) => this.normalize(s) === normStudentSection,
    );
  }

  /** Maps a CourseAccess's grade junction rows to the grant shape shouldEnroll expects. */
  private toGrants(
    gradeAccess: Array<{
      gradeName: string;
      sectionAccess?: Array<{ sectionName: string }>;
    }>,
  ): CourseGradeGrant[] {
    return gradeAccess.map((g) => ({
      gradeName: g.gradeName,
      sectionNames: (g.sectionAccess ?? []).map((s) => s.sectionName),
    }));
  }

  /**
   * Automatically enroll a student in all published courses that are accessible
   * to their school, grade and section. Filtering uses the CourseAccessGrade /
   * CourseAccessSection junction tables.
   */
  async enrollStudentInRelevantCourses(
    studentId: number,
    schoolId: string,
    grade: string | null,
    section: string | null = null,
  ) {
    const accessRecords = await this.db.courseAccess.findMany({
      where: {
        schoolId,
        course: { isPublished: true },
      },
      include: { gradeAccess: { include: { sectionAccess: true } } },
    });

    const courseIdsToEnroll: string[] = [];
    for (const access of accessRecords) {
      if (this.shouldEnroll(this.toGrants(access.gradeAccess), grade, section)) {
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
      include: { gradeAccess: { include: { sectionAccess: true } } },
    });

    let inserted = 0;

    for (const access of accessRecords) {
      const grants = this.toGrants(access.gradeAccess);

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
            select: { grade: true, section: true },
          },
        },
      });

      const rows: { studentId: number; courseId: string }[] = [];
      for (const s of students) {
        const studentGrade = s.studentSchools[0]?.grade ?? null;
        const studentSection = s.studentSchools[0]?.section ?? null;
        if (this.shouldEnroll(grants, studentGrade, studentSection)) {
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
    // Enrollment rule per (student, course):
    //   COUNT(grade rows) = 0                    → whole school
    //   OR the student's grade matches a granted grade AND
    //      (that grade has no section rows OR the student's section is listed)
    // The section sub-condition is a NOT EXISTS / EXISTS pair on
    // CourseAccessSection scoped to the matching grade grant.
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
          GROUP BY u.id, co.id, ss.grade, ss.section, ca.id
          HAVING
            COUNT(cag.id) = 0
            OR BOOL_OR(
              lower(replace(cag."gradeName", ' ', '')) = lower(replace(ss.grade, ' ', ''))
              AND (
                NOT EXISTS (
                  SELECT 1 FROM "CourseAccessSection" cas WHERE cas."courseAccessGradeId" = cag.id
                )
                OR EXISTS (
                  SELECT 1 FROM "CourseAccessSection" cas
                  WHERE cas."courseAccessGradeId" = cag.id
                    AND lower(replace(cas."sectionName", ' ', '')) = lower(replace(ss.section, ' ', ''))
                )
              )
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
          GROUP BY u.id, co.id, ss.grade, ss.section, ca.id
          HAVING
            COUNT(cag.id) = 0
            OR BOOL_OR(
              lower(replace(cag."gradeName", ' ', '')) = lower(replace(ss.grade, ' ', ''))
              AND (
                NOT EXISTS (
                  SELECT 1 FROM "CourseAccessSection" cas WHERE cas."courseAccessGradeId" = cag.id
                )
                OR EXISTS (
                  SELECT 1 FROM "CourseAccessSection" cas
                  WHERE cas."courseAccessGradeId" = cag.id
                    AND lower(replace(cas."sectionName", ' ', '')) = lower(replace(ss.section, ' ', ''))
                )
              )
            )
          ON CONFLICT ("studentId", "courseId") DO NOTHING
        `;

    return typeof result === 'number' ? result : 0;
  }
}
