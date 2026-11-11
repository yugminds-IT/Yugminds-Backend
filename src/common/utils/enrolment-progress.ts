import type { DatabaseService } from '../../database/database.service';
import { computeCourseProgress } from './course-progress.util';

/** Per-enrolment progress, computed from live course content exactly like the Course progress page. */
export async function enrolmentProgress(
  db: DatabaseService,
  scope: { studentIds?: number[]; courseIds?: string[] },
) {
  const enrol = await db.studentCourse.findMany({
    where: {
      ...(scope.studentIds ? { studentId: { in: scope.studentIds } } : {}),
      ...(scope.courseIds ? { courseId: { in: scope.courseIds } } : {}),
    },
    select: { studentId: true, courseId: true, enrolledAt: true },
  });
  const courseIds = [...new Set(enrol.map((e) => e.courseId))];
  if (!courseIds.length) return [];
  const [chapters, contents, progress] = await Promise.all([
    db.chapter.findMany({
      where: { courseId: { in: courseIds } },
      select: { id: true, courseId: true },
    }),
    db.chapterContent.findMany({
      where: { chapter: { courseId: { in: courseIds } } },
      select: {
        id: true,
        chapterId: true,
        durationMinutes: true,
        chapter: { select: { courseId: true } },
      },
    }),
    db.courseProgress.findMany({
      where: {
        courseId: { in: courseIds },
        ...(scope.studentIds ? { studentId: { in: scope.studentIds } } : {}),
      },
      select: {
        studentId: true,
        courseId: true,
        contentId: true,
        chapterId: true,
        progress: true,
        completedAt: true,
        updatedAt: true,
      },
    }),
  ]);
  const by = <T>(rows: T[], key: (r: T) => string) => {
    const m = new Map<string, T[]>();
    for (const r of rows)
      (m.get(key(r)) ?? m.set(key(r), []).get(key(r))!).push(r);
    return m;
  };
  const chByCourse = by(chapters, (c) => c.courseId);
  const coByCourse = by(contents, (c) => c.chapter.courseId);
  const prByPair = by(progress, (p) => `${p.studentId}:${p.courseId}`);
  return enrol.map((e) => ({
    ...e,
    ...computeCourseProgress(
      chByCourse.get(e.courseId) ?? [],
      coByCourse.get(e.courseId) ?? [],
      prByPair.get(`${e.studentId}:${e.courseId}`) ?? [],
    ),
  }));
}
