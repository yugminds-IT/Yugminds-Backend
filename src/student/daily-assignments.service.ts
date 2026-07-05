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
          where: { schoolId: studentSchool.schoolId, name: studentSchool.grade },
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

    const assignments = candidateAssignments.filter((a) => {
      const scope = a.publishScope ?? 'grade';
      if (scope === 'grade') {
        // Modern multi-grade targeting takes precedence over the legacy gradeId field.
        if (a.publishedGradeIds && a.publishedGradeIds.length > 0) {
          return gradeRecord ? a.publishedGradeIds.includes(gradeRecord.id) : false;
        }
        return !a.gradeId || a.gradeId === gradeRecord?.id;
      }
      if (scope === 'section') {
        if (a.publishedSectionIds && a.publishedSectionIds.length > 0) {
          return sectionRecord
            ? a.publishedSectionIds.includes(sectionRecord.id)
            : false;
        }
        return false;
      }
      // selected_students scope: visible unless explicitly excluded; grant-based
      // access is enforced at submit time.
      return true;
    });

    return { assignments, studentSchool };
  }
}
