import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * Shared resolver for the DAILY (school-scoped homework) assignments a student
 * can see.
 *
 * Both the assignments list endpoint and the dashboard pending/completed counts
 * need the exact same school + publishScope (grade / section / selected_students)
 * filtering. Keeping it in one place means the badge count and the list can never
 * drift apart.
 */
@Injectable()
export class StudentDailyAssignmentsService {
  constructor(private readonly db: DatabaseService) {}

  async getVisibleDailyAssignments(studentId: number) {
    const studentSchool = await this.db.studentSchool.findFirst({
      where: { studentId, isActive: true },
      select: { schoolId: true, grade: true, section: true },
    });
    if (!studentSchool) {
      return { assignments: [], studentSchool: null };
    }

    // Resolve grade/section records so we can match publishedGradeIds/publishedSectionIds.
    const gradeRecord = studentSchool.grade
      ? await this.db.grade.findFirst({
          where: {
            schoolId: studentSchool.schoolId,
            name: studentSchool.grade,
          },
          select: { id: true },
        })
      : null;

    const sectionRecord =
      gradeRecord && studentSchool.section
        ? await this.db.section.findFirst({
            where: { gradeId: gradeRecord.id, name: studentSchool.section },
            select: { id: true },
          })
        : null;

    const candidateAssignments = await this.db.assignment.findMany({
      where: {
        schoolId: studentSchool.schoolId,
        assignmentType: 'DAILY',
        isPublished: true,
      },
      include: { questions: true, grade: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const assignments = candidateAssignments.filter((a) =>
      StudentDailyAssignmentsService.matchesAudience(
        a,
        gradeRecord?.id,
        sectionRecord?.id,
      ),
    );

    return { assignments, studentSchool };
  }

  /** Single source of truth for the grade / section audience rule. */
  private static matchesAudience(
    a: {
      publishScope: string | null;
      publishedGradeIds: string[] | null;
      publishedSectionIds: string[] | null;
      gradeId: string | null;
    },
    gradeId: string | undefined,
    sectionId: string | undefined,
  ): boolean {
    const scope = a.publishScope ?? 'grade';
    if (scope === 'grade') {
      // Modern multi-grade targeting takes precedence over the legacy gradeId field.
      if (a.publishedGradeIds && a.publishedGradeIds.length > 0) {
        return gradeId ? a.publishedGradeIds.includes(gradeId) : false;
      }
      return !a.gradeId || a.gradeId === gradeId;
    }
    if (scope === 'section') {
      if (a.publishedSectionIds && a.publishedSectionIds.length > 0) {
        return sectionId ? a.publishedSectionIds.includes(sectionId) : false;
      }
      return false;
    }
    // selected_students scope: visible unless explicitly excluded; grant-based
    // access is enforced at submit time.
    return true;
  }

  /**
   * Same visibility rule as the list, for a single assignment (by-id read and
   * submit): published, in the student's active school, and in the audience.
   */
  async isVisibleToStudent(
    studentId: number,
    a: {
      assignmentType: string;
      isPublished: boolean;
      schoolId: string | null;
      publishScope: string | null;
      publishedGradeIds: string[] | null;
      publishedSectionIds: string[] | null;
      gradeId: string | null;
    },
  ): Promise<boolean> {
    if (a.assignmentType !== 'DAILY') return true;
    if (!a.isPublished || !a.schoolId) return false;
    const ss = await this.db.studentSchool.findFirst({
      where: { studentId, schoolId: a.schoolId, isActive: true },
      select: { schoolId: true, grade: true, section: true },
    });
    if (!ss) return false;
    const grade = ss.grade
      ? await this.db.grade.findFirst({
          where: { schoolId: ss.schoolId, name: ss.grade },
          select: { id: true },
        })
      : null;
    const section =
      grade && ss.section
        ? await this.db.section.findFirst({
            where: { gradeId: grade.id, name: ss.section },
            select: { id: true },
          })
        : null;
    return StudentDailyAssignmentsService.matchesAudience(
      a,
      grade?.id,
      section?.id,
    );
  }
}
