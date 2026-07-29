import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { tenantContext } from '../../tenants/tenant-context';

export interface RetakeRequestRoutingResult {
  schoolId: string | null;
  teacherIds: number[];
}

/**
 * Resolves which teacher(s) should see a student's retake request for a
 * given assignment — "properly school/grade/section → correct teacher"
 * rather than any teacher at the school.
 *
 * Resolution order:
 *  1. `assignment.teacherId` if set (DAILY assignments already carry it,
 *     along with `assignment.schoolId`).
 *  2. Otherwise (COURSE-chapter assignments, which carry no schoolId of
 *     their own — only `courseId`/`chapterId`): resolve the student's own
 *     school for that course via CourseAccess ∩ their active enrollments.
 *  3. With a school in hand, the student's StudentSchool.grade/section at
 *     that school → matching Section (via Grade) → TeacherSectionAssignment
 *     → teacherId(s). This is the actual grade+section-aware mapping
 *     `openRetakeForAll` never did (it only matches by grade name, never
 *     section/TeacherSectionAssignment).
 *  4. Fallback: any teacher with a TeacherSchool row at that school — the
 *     same last-resort tier `canTeacherAccessAssignment` uses — so a
 *     request is never silently un-routable when section data is missing.
 */
@Injectable()
export class RetakeRequestTeacherResolver {
  constructor(private readonly db: DatabaseService) {}

  async resolve(
    studentId: number,
    assignment: {
      teacherId: number | null;
      schoolId: string | null;
      chapterId?: string | null;
      courseId?: string | null;
    },
  ): Promise<RetakeRequestRoutingResult> {
    if (assignment.teacherId) {
      return { schoolId: assignment.schoolId, teacherIds: [assignment.teacherId] };
    }

    const schoolId = assignment.schoolId ?? (await this.resolveSchoolForCourse(studentId, assignment));
    if (!schoolId) return { schoolId: null, teacherIds: [] };

    const teacherIds = await tenantContext.run(schoolId, async () => {
      const enrollment = await this.db.studentSchool.findFirst({
        where: { studentId, schoolId, isActive: true },
        select: { grade: true, section: true },
      });

      if (enrollment?.grade && enrollment?.section) {
        const section = await this.db.section.findFirst({
          where: {
            name: enrollment.section,
            grade: { schoolId, name: enrollment.grade },
          },
          select: { id: true },
        });
        if (section) {
          const assignments = await this.db.teacherSectionAssignment.findMany({
            where: { sectionId: section.id, schoolId },
            select: { teacherId: true },
          });
          const ids = Array.from(new Set(assignments.map((a) => a.teacherId)));
          if (ids.length > 0) return ids;
        }
      }

      // Fallback: any teacher assigned to this school at all.
      const teacherSchools = await this.db.teacherSchool.findMany({
        where: { schoolId },
        select: { teacherId: true },
      });
      return Array.from(new Set(teacherSchools.map((t) => t.teacherId)));
    });

    return { schoolId, teacherIds };
  }

  /**
   * Course-chapter assignments have no schoolId of their own — only
   * courseId (or chapterId → chapter.courseId). Resolve which school this
   * particular student takes that course at: the intersection of the
   * course's granted schools (CourseAccess) and the student's own active
   * school enrollments. Runs as super-admin since it spans schools the
   * request isn't yet scoped to one of.
   */
  private async resolveSchoolForCourse(
    studentId: number,
    assignment: { chapterId?: string | null; courseId?: string | null },
  ): Promise<string | null> {
    return tenantContext.runSuperAdmin(async () => {
      const courseId =
        assignment.courseId ??
        (assignment.chapterId
          ? (
              await this.db.chapter.findUnique({
                where: { id: assignment.chapterId },
                select: { courseId: true },
              })
            )?.courseId
          : null);
      if (!courseId) return null;

      const [accessRows, studentSchools] = await Promise.all([
        this.db.courseAccess.findMany({
          where: { courseId },
          select: { schoolId: true },
        }),
        this.db.studentSchool.findMany({
          where: { studentId, isActive: true },
          select: { schoolId: true },
        }),
      ]);
      const accessSchoolIds = new Set(accessRows.map((a) => a.schoolId));
      const match = studentSchools.find((ss) => accessSchoolIds.has(ss.schoolId));
      return match?.schoolId ?? null;
    });
  }
}
