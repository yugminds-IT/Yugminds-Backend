import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class StudentDashboardService {
  constructor(private readonly db: DatabaseService) {}

  async get(user: { id: number }) {
    const enrollments = await this.db.studentCourse.findMany({
      where: { studentId: user.id },
      select: { courseId: true },
    });

    if (enrollments.length === 0) {
      const unreadNotifications = await this.db.notification.count({
        where: { userId: user.id, readAt: null, deletedAt: null },
      });
      return {
        stats: {
          activeCourses: 0,
          completedCourses: 0,
          pendingAssignments: 0,
          completedAssignments: 0,
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

    const contentsByChapter = new Map<string, string[]>();
    for (const c of contents) {
      const arr = contentsByChapter.get(c.chapterId) ?? [];
      arr.push(c.id);
      contentsByChapter.set(c.chapterId, arr);
    }

    const completedContentIdsByCourse = new Map<string, Set<string>>();
    const completedChapterIdsByCourse = new Map<string, Set<string>>();

    for (const courseId of courseIds) {
      const courseProgress = progressRows.filter(
        (p) => p.courseId === courseId,
      );

      const completedContentIds = new Set(
        courseProgress
          .filter(
            (p) => (p as any).contentId && (p.progress >= 99 || p.completedAt),
          )
          .map((p) => (p as any).contentId as string),
      );

      const completedChapterIds = new Set(
        courseProgress
          .filter((p) => {
            const cid = (p as any).contentId;
            const isChapterRecord =
              !cid || cid === '' || cid === 'null' || cid === 'undefined';
            return (
              isChapterRecord &&
              p.chapterId &&
              (p.progress >= 99 || p.completedAt)
            );
          })
          .map((p) => p.chapterId as string),
      );

      completedContentIdsByCourse.set(courseId, completedContentIds);
      completedChapterIdsByCourse.set(courseId, completedChapterIds);
    }

    let activeCourses = 0;
    let completedCourses = 0;
    for (const courseId of courseIds) {
      const courseChapters = chaptersByCourse.get(courseId) ?? [];
      const totalChapters = courseChapters.length;
      if (totalChapters === 0) continue;

      const completedContentIds =
        completedContentIdsByCourse.get(courseId) ?? new Set();
      const completedChapterIds =
        completedChapterIdsByCourse.get(courseId) ?? new Set();

      let hybridCompletedCount = 0;
      let totalCourseContentCount = 0;

      for (const chId of courseChapters) {
        const chContents = contentsByChapter.get(chId) || [];
        totalCourseContentCount += chContents.length;

        for (const cid of chContents) {
          if (completedContentIds.has(cid) || completedChapterIds.has(chId)) {
            hybridCompletedCount++;
          }
        }
      }

      const progressPercentage =
        totalCourseContentCount > 0
          ? Math.round((hybridCompletedCount / totalCourseContentCount) * 100)
          : completedChapterIds.size >= totalChapters
            ? 100
            : 0;

      if (progressPercentage >= 100) {
        completedCourses += 1;
      } else if (progressPercentage > 0) {
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
        pendingAssignments: Math.max(0, assignmentIds.length - submissionCount),
        completedAssignments: submissionCount,
        unreadNotifications,
      },
    };
  }
}
