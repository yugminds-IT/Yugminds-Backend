import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { StudentDailyAssignmentsService } from '../daily-assignments.service';
import { computeCourseProgress } from '../../common/utils/course-progress.util';
import { duePhase, examPhase } from '../../common/assignment/assignment-types';
import { EnrollmentService } from '../../common/enrollment/enrollment.service';

@Injectable()
export class StudentDashboardService {
  constructor(
    private readonly db: DatabaseService,
    private readonly dailyAssignments: StudentDailyAssignmentsService,
    private readonly enrollmentService: EnrollmentService,
  ) {}

  /**
   * Pending/completed counts for DAILY (school-scoped homework) assignments.
   * "Completed" = has any submission; "pending" = visible but not yet submitted.
   * Counted independently of course enrollment so daily-only students are covered.
   */
  private async dailyAssignmentCounts(studentId: number) {
    const { assignments } =
      await this.dailyAssignments.getVisibleDailyAssignments(studentId);
    const ids = assignments.map((a) => a.id);
    const submittedIds = new Set<string>(
      ids.length > 0
        ? (
            await this.db.assignmentSubmission.findMany({
              where: { studentId, assignmentId: { in: ids } },
              select: { assignmentId: true },
              distinct: ['assignmentId'],
            })
          ).map((r) => r.assignmentId)
        : [],
    );
    const submitted = submittedIds.size;
    // Closed and never submitted = missed, not something the student can still do.
    const now = new Date();
    const missed = (
      assignments as {
        id: string;
        dueDate: Date | null;
        closeDate: Date | null;
        lateSubmissionPolicy: string;
      }[]
    ).filter(
      (a) => !submittedIds.has(a.id) && duePhase(a, now) === 'closed',
    ).length;
    return {
      pending: Math.max(0, ids.length - submitted - missed),
      completed: submitted,
    };
  }

  /** Exams open now and not yet attempted, plus ones scheduled for later. */
  private async examCounts(studentId: number) {
    const { assignments } = await this.dailyAssignments.getVisibleAssignments(
      studentId,
      'EXAM',
    );
    const now = new Date();
    const ids = assignments.map((a) => a.id);
    const attempted = new Set(
      ids.length
        ? (
            await this.db.assignmentSubmission.findMany({
              where: { studentId, assignmentId: { in: ids } },
              select: { assignmentId: true },
              distinct: ['assignmentId'],
            })
          ).map((r) => r.assignmentId)
        : [],
    );
    let open = 0;
    let upcoming = 0;
    for (const a of assignments) {
      const phase = examPhase(a, now);
      if (phase === 'open' && !attempted.has(a.id)) open++;
      else if (phase === 'upcoming') upcoming++;
    }
    return { pendingExams: open, upcomingExams: upcoming };
  }

  async get(user: { id: number }) {
    await this.enrollmentService.syncStudentEnrollments(user.id);
    const liveCourses = await this.db.course.findMany({
      where: { isPublished: true, deletedAt: null },
      select: { id: true },
    });
    const enrollments = await this.db.studentCourse.findMany({
      where: {
        studentId: user.id,
        courseId: { in: liveCourses.map((c) => c.id) },
      },
      select: { courseId: true },
    });

    const daily = await this.dailyAssignmentCounts(user.id);
    const exams = await this.examCounts(user.id);

    if (enrollments.length === 0) {
      const unreadNotifications = await this.db.notification.count({
        where: { userId: user.id, readAt: null, deletedAt: null },
      });
      return {
        stats: {
          activeCourses: 0,
          completedCourses: 0,
          pendingAssignments: daily.pending,
          ...exams,
          completedAssignments: daily.completed,
          unreadNotifications,
        },
      };
    }

    const courseIds = enrollments.map((e) => e.courseId);

    const [chapters, progressRows, unreadNotifications] = await Promise.all([
      this.db.chapter.findMany({
        where: { courseId: { in: courseIds } },
        select: { id: true, courseId: true },
      }),
      this.db.courseProgress.findMany({
        where: { studentId: user.id, courseId: { in: courseIds } },
        select: {
          courseId: true,
          chapterId: true,
          contentId: true,
          progress: true,
          completedAt: true,
          updatedAt: true,
        } as any,
      }),
      this.db.notification.count({
        where: { userId: user.id, readAt: null, deletedAt: null },
      }),
    ]);

    const chapterIds = chapters.map((c) => c.id);
    const contents = await this.db.chapterContent.findMany({
      where: { chapterId: { in: chapterIds } },
      select: { id: true, chapterId: true },
    });

    const chaptersByCourse = new Map<string, string[]>();
    for (const ch of chapters) {
      const arr = chaptersByCourse.get(ch.courseId) ?? [];
      arr.push(ch.id);
      chaptersByCourse.set(ch.courseId, arr);
    }

    // Same computeCourseProgress used by /student/courses, admin/school-admin
    // student-progress, teacher student-progress, and certificates — keeps
    // these stat cards in agreement with the "Active Courses" list below it
    // (which is built from /student/courses), instead of re-deriving
    // completion with slightly different edge-case rules.
    let activeCourses = 0;
    let completedCourses = 0;
    for (const courseId of courseIds) {
      const courseChapters = (chaptersByCourse.get(courseId) ?? []).map(
        (id) => ({ id }),
      );
      const courseChapterIdSet = new Set(courseChapters.map((c) => c.id));
      const courseContents = contents
        .filter((c) => courseChapterIdSet.has(c.chapterId))
        .map((c) => ({ id: c.id, chapterId: c.chapterId }));
      const courseProgressRows = progressRows
        .filter((p) => p.courseId === courseId)
        .map((p) => ({
          contentId: (p as any).contentId ?? null,
          chapterId: p.chapterId ?? null,
          progress: p.progress,
          completedAt: (p as any).completedAt ?? null,
          updatedAt: (p as any).updatedAt ?? new Date(0),
        }));

      const { status } = computeCourseProgress(
        courseChapters,
        courseContents,
        courseProgressRows,
      );

      if (status === 'completed') {
        completedCourses += 1;
      } else {
        // Matches the frontend's "Active Courses" list filter
        // (progress_percentage < 100), which counts not-yet-started
        // enrollments as active too.
        activeCourses += 1;
      }
    }

    // Assignments stats
    const assignmentIds =
      chapterIds.length > 0
        ? await this.db.assignment.findMany({
            where: { chapterId: { in: chapterIds } },
            select: { id: true },
          })
        : [];

    const courseAssignments =
      assignmentIds.length > 0
        ? await this.db.assignment.findMany({
            where: { id: { in: assignmentIds.map((a) => a.id) } },
            select: {
              id: true,
              dueDate: true,
              closeDate: true,
              lateSubmissionPolicy: true,
              assignmentType: true,
            },
          })
        : [];
    const submittedCourseIds = new Set<string>(
      courseAssignments.length > 0
        ? (
            await this.db.assignmentSubmission.findMany({
              where: {
                studentId: user.id,
                assignmentId: { in: courseAssignments.map((a) => a.id) },
              },
              select: { assignmentId: true },
              distinct: ['assignmentId'],
            })
          ).map((r) => r.assignmentId)
        : [],
    );
    const submissionCount = submittedCourseIds.size;
    // Closed and never submitted = missed, not something the student can still do.
    const now = new Date();
    const missedCourse = courseAssignments.filter(
      (a) => !submittedCourseIds.has(a.id) && duePhase(a, now) === 'closed',
    ).length;

    return {
      stats: {
        activeCourses,
        completedCourses,
        // Combine course (chapter-based) + daily (school homework) assignments.
        ...exams,
        pendingAssignments:
          Math.max(0, assignmentIds.length - submissionCount - missedCourse) +
          daily.pending,
        completedAssignments: submissionCount + daily.completed,
        unreadNotifications,
      },
    };
  }
}
