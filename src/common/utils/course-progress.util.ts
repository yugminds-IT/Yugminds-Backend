/**
 * Single source of truth for "how complete is this student in this course."
 * Both the student-facing "My Learning" page and the admin-facing
 * "Course Progress" page must derive the same percentage/status for the
 * same student+course — they used to compute it independently and could
 * disagree (the admin side did a raw average of every CourseProgress row
 * ever written for the pair, with no filtering against the course's
 * CURRENT content; a stale/orphaned row — e.g. left over from content that
 * was since replaced during a course edit — silently dragged its number
 * down while the student side, which recomputes from the live content set,
 * showed 100%).
 *
 * Always recomputes from the course's LIVE chapters/content — a
 * CourseProgress row whose `contentId` doesn't match any of them (stale,
 * orphaned) is ignored rather than averaged in.
 */

export interface CourseProgressChapter {
  id: string;
}

export interface CourseProgressContent {
  id: string;
  chapterId: string;
  durationMinutes?: number | null;
}

export interface CourseProgressRow {
  contentId: string | null;
  chapterId: string | null;
  progress: number;
  completedAt: Date | null;
  updatedAt: Date;
}

export interface CourseProgressResult {
  totalChapters: number;
  completedChapters: number;
  totalContentItems: number;
  progressPercentage: number;
  status: 'completed' | 'active' | 'not_started';
  lastAccessed: Date | null;
  estimatedMinutes: number;
}

export function computeCourseProgress(
  chapters: CourseProgressChapter[],
  contents: CourseProgressContent[],
  progressRows: CourseProgressRow[],
): CourseProgressResult {
  const totalChapters = chapters.length;
  const totalContentItems = contents.length;

  const completedContentIds = new Set(
    progressRows
      .filter((p) => p.contentId && (p.progress >= 99 || p.completedAt))
      .map((p) => p.contentId as string),
  );

  const completedChapterIds = new Set(
    progressRows
      .filter((p) => {
        const cid = p.contentId;
        const isChapterRecord = !cid || cid === '' || cid === 'null' || cid === 'undefined';
        return isChapterRecord && p.chapterId && (p.progress >= 99 || p.completedAt);
      })
      .map((p) => p.chapterId as string),
  );

  let hybridCompletedCount = 0;
  for (const c of contents) {
    // A content item counts as done if its own record says so, OR if its
    // parent chapter is explicitly marked done (legacy fallback).
    if (completedContentIds.has(c.id) || completedChapterIds.has(c.chapterId)) {
      hybridCompletedCount++;
    }
  }

  const progressPercentage =
    totalContentItems > 0
      ? Math.min(100, Math.round((hybridCompletedCount / totalContentItems) * 100))
      : progressRows.some((p) => p.progress >= 99)
        ? 100
        : 0;

  const chapterContentsMap = new Map<string, string[]>();
  for (const c of contents) {
    const list = chapterContentsMap.get(c.chapterId) ?? [];
    list.push(c.id);
    chapterContentsMap.set(c.chapterId, list);
  }

  let completedChapters = 0;
  for (const ch of chapters) {
    const chContents = chapterContentsMap.get(ch.id) ?? [];
    const chapterIsExplicitlyCompleted = completedChapterIds.has(ch.id);
    if (chContents.length > 0) {
      const allContentsDone = chContents.every((cid) => completedContentIds.has(cid));
      if (allContentsDone || chapterIsExplicitlyCompleted) completedChapters++;
    } else if (chapterIsExplicitlyCompleted) {
      completedChapters++;
    }
  }

  const lastAccessed = progressRows.reduce<Date | null>((latest, p) => {
    const ts = p.completedAt ?? p.updatedAt;
    return !latest || ts > latest ? ts : latest;
  }, null);

  const status: CourseProgressResult['status'] =
    totalChapters > 0 && completedChapters >= totalChapters
      ? 'completed'
      : progressPercentage > 0
        ? 'active'
        : 'not_started';

  const estimatedMinutes = contents.reduce((sum, c) => sum + (c.durationMinutes ?? 0), 0);

  return {
    totalChapters,
    completedChapters,
    totalContentItems,
    // Force 100% when completed, for UI consistency (matches "N of N chapters").
    progressPercentage: status === 'completed' ? 100 : progressPercentage,
    status,
    lastAccessed,
    estimatedMinutes,
  };
}
