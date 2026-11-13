import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { tenantContext } from '../../tenants/tenant-context';

/**
 * Everything the "Download report" Excel needs for one assignment: its settings,
 * every submission attempt, and the targeted students who never submitted.
 * Same response shape the teacher portal gets from its own endpoints, so one
 * frontend report works for teacher, school-admin and admin.
 */
@Injectable()
export class AssignmentReportService {
  constructor(private readonly db: DatabaseService) {}

  /** `schoolId` set = school-admin (assignment must belong to that school); unset = platform admin. */
  async get(assignmentId: string, schoolId?: string | null) {
    const a = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        title: true,
        subject: true,
        schoolId: true,
        gradeId: true,
        dueDate: true,
        totalMarks: true,
        assignmentType: true,
        examType: true,
        startsAt: true,
        endsAt: true,
        retakeScoringRule: true,
        publishScope: true,
        publishedGradeIds: true,
        publishedSectionIds: true,
        isPublished: true,
      },
    });
    if (!a || (schoolId && a.schoolId !== schoolId)) {
      throw new NotFoundException('Assignment not found');
    }
    const name = (
      u: { email: string | null; profile: { fullName: string | null } | null },
      id: number,
    ) => u.profile?.fullName ?? u.email ?? `Student ${id}`;

    const submissions = await this.db.assignmentSubmission.findMany({
      where: { assignmentId },
      orderBy: [{ studentId: 'asc' }, { attemptNumber: 'asc' }],
      include: {
        student: {
          include: {
            profile: true,
            studentSchools: {
              where: { isActive: true },
              include: { school: { select: { name: true } } },
              take: 1,
            },
          },
        },
      },
    });

    // Course audiences follow enrolment, so "not submitted" is only meaningful for published DAILY/EXAM work.
    const targeted =
      (a.assignmentType === 'DAILY' || a.assignmentType === 'EXAM') &&
      a.isPublished &&
      a.schoolId;
    const missing = targeted
      ? await tenantContext.run(a.schoolId as string, async () => {
          const ids = await this.targetedStudentIds(a.schoolId as string, a);
          const submitted = new Set(submissions.map((s) => s.studentId));
          const missingIds = ids.filter((id) => !submitted.has(id));
          return missingIds.length
            ? await this.db.studentSchool.findMany({
                where: {
                  schoolId: a.schoolId as string,
                  studentId: { in: missingIds },
                  isActive: true,
                },
                include: { student: { include: { profile: true } } },
              })
            : [];
        })
      : [];

    return {
      assignment: {
        id: a.id,
        title: a.title,
        subject: a.subject,
        due_date: a.dueDate?.toISOString() ?? null,
        total_marks: a.totalMarks,
        assignment_type: a.assignmentType,
        exam_type: a.examType,
        starts_at: a.startsAt?.toISOString() ?? null,
        ends_at: a.endsAt?.toISOString() ?? null,
        retake_rule: a.retakeScoringRule,
      },
      not_submitted: missing.map((m) => ({
        student_id: m.studentId,
        student_name: name(m.student, m.studentId),
        email: m.student.email ?? null,
        grade: m.grade ?? null,
        section: m.section ?? null,
      })),
      submissions: submissions.map((s) => {
        const ss = s.student.studentSchools?.[0];
        return {
          id: s.id,
          student_id: s.studentId,
          student_name: name(s.student, s.studentId),
          attempt_number: s.attemptNumber,
          status: s.status,
          score: s.score,
          max_score: s.maxScore,
          submitted_at: s.submittedAt.toISOString(),
          graded_at: s.gradedAt?.toISOString() ?? null,
          is_retake: s.isRetake,
          is_late: s.isLate,
          grade: ss?.grade ?? null,
          section: ss?.section ?? null,
          school_name: ss?.school?.name ?? null,
        };
      }),
    };
  }

  // Mirrors TeacherExtraController.resolveTargetedStudentIds (section > published grades > grade > whole school).
  private async targetedStudentIds(
    schoolId: string,
    a: {
      gradeId: string | null;
      publishScope: string | null;
      publishedGradeIds: string[] | null;
      publishedSectionIds: string[] | null;
    },
  ): Promise<number[]> {
    const enrollments = await this.db.studentSchool.findMany({
      where: { schoolId, isActive: true },
      select: { studentId: true, grade: true, section: true },
    });
    const pick = (keep: (e: (typeof enrollments)[number]) => boolean) =>
      enrollments.filter(keep).map((e) => e.studentId);
    const sectionIds = a.publishedSectionIds ?? [];
    const gradeIds = a.publishedGradeIds ?? [];
    if ((a.publishScope ?? 'grade') === 'section' && sectionIds.length) {
      const sections = await this.db.section.findMany({
        where: { id: { in: sectionIds } },
        select: { name: true, grade: { select: { name: true } } },
      });
      const targets = new Set(
        sections.map((s) => `${s.grade.name}::${s.name}`),
      );
      return pick((e) => targets.has(`${e.grade ?? ''}::${e.section ?? ''}`));
    }
    if (gradeIds.length) {
      const grades = await this.db.grade.findMany({
        where: { id: { in: gradeIds } },
        select: { name: true },
      });
      const names = new Set(grades.map((g) => g.name));
      return pick((e) => names.has(e.grade ?? ''));
    }
    if (a.gradeId) {
      const g = await this.db.grade.findUnique({
        where: { id: a.gradeId },
        select: { name: true },
      });
      return pick((e) => e.grade === (g?.name ?? ''));
    }
    return pick(() => true);
  }
}
