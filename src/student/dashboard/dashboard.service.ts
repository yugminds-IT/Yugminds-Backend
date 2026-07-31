import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { StudentDailyAssignmentsService } from '../daily-assignments.service';
import { computeCourseProgress } from '../../common/utils/course-progress.util';

@Injectable()
export class StudentDashboardService {
  constructor(
    private readonly db: DatabaseService,
    private readonly dailyAssignments: StudentDailyAssignmentsService,
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
    const submitted =
      ids.length > 0
        ? await this.db.assignmentSubmission
            .findMany({
              where: { studentId, assignmentId: { in: ids } },
              select: { assignmentId: true },
              distinct: ['assignmentId'],
            })
            .then((rows) => rows.length)
        : 0;
    return { pending: Math.max(0, ids.length - submitted), completed: submitted };
  }

  async get(user: { id: number }) {
    const enrollments = await this.db.studentCourse.findMany({
      where: { studentId: user.id },
      select: { courseId: true },
    });

    const daily = await this.dailyAssignmentCounts(user.id);

    if (enrollments.length === 0) {
      const unreadNotifications = await this.db.notification.count({
        where: { userId: user.id, readAt: null, deletedAt: null },
      });
      return {
        stats: {
          activeCourses: 0,
          completedCourses: 0,
          pendingAssignments: daily.pending,
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

    const submissionCount =
      assignmentIds.length > 0
        ? await this.db.assignmentSubmission.count({
            where: {
              studentId: user.id,
              assignmentId: { in: assignmentIds.map((a) => a.id) },
            },
          })
        : 0;

    return {
      stats: {
        activeCourses,
        completedCourses,
        // Combine course (chapter-based) + daily (school homework) assignments.
        pendingAssignments:
          Math.max(0, assignmentIds.length - submissionCount) + daily.pending,
        completedAssignments: submissionCount + daily.completed,
        unreadNotifications,
      },
    };
  }
}
