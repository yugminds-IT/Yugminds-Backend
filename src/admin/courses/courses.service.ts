import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { Role } from '@prisma/client';
import { EnrollmentService } from '../../common/enrollment/enrollment.service';

/** Per-school → per-grade → sections targeting the publish UI reads back. */
type AccessTarget = {
  school_id: string;
  school_name?: string;
  grades: Array<{ grade: string; sections: string[] }>;
};

type CourseListItem = {
  id: string;
  name: string;
  description?: string | null;
  thumbnail_url?: string | null;
  status: 'Draft' | 'Published';
  is_published: boolean;
  school_ids: string[];
  grades: string[];
  /** Structured school→grade→section targeting (empty sections = whole grade). */
  access: AccessTarget[];
  total_chapters: number;
  num_chapters: number;
  total_videos: number;
  total_materials: number;
  total_assignments: number;
  /** Drip schedule: chapter K unlocks K * this many days after enrollment. null/0 = no drip. */
  chapter_unlock_interval_days: number | null;
  created_at: string;
  updated_at: string;
  course_access?: Array<{
    id: string;
    course_id: string;
    school_id: string;
    grade: string;
    sections: string[];
    schools?: { name: string };
  }>;
};

type ChapterDto = {
  id: string;
  course_id: string;
  name: string;
  order_number: number;
  description?: string | null;
};

type ChapterContentDto = {
  id: string;
  content_id?: string;
  chapter_id: string;
  content_type: string;
  title: string;
  content_text?: string | null;
  content_url?: string | null;
  order_index: number;
  duration_minutes?: number | null;
};

type AssignmentQuestionDto = {
  id: string;
  assignment_id?: string;
  question_type: string;
  question_text: string;
  options?: string[];
  correct_answer?: string | null;
  marks: number;
};

type AssignmentDto = {
  id: string;
  chapter_id: string;
  title: string;
  description?: string | null;
  questions?: AssignmentQuestionDto[];
};

type CourseDetail = CourseListItem & {
  chapters: ChapterDto[];
  chapter_contents?: ChapterContentDto[];
  assignments?: AssignmentDto[];
};

type ChapterPayload = { id?: string; name?: string; order_number?: number };
type ContentPayload = {
  id?: string;
  chapter_id: string;
  content_type?: string;
  title?: string;
  content_text?: string;
  content_url?: string;
  order_index?: number;
  duration_minutes?: number;
};
type QuestionPayload = {
  id?: string;
  question_type?: string;
  question_text?: string;
  options?: string[];
  correct_answer?: string;
  marks?: number;
};
type AssignmentPayload = {
  id?: string;
  chapter_id: string;
  title?: string;
  description?: string;
  questions?: QuestionPayload[];
};
type AccessPayload = {
  school_id: string;
  grades?: Array<{ grade: string; sections?: string[] }>;
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_REGEX.test(s);
}

@Injectable()
export class AdminCoursesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly enrollmentService: EnrollmentService,
  ) {}

  private isCourseVersionStorageUnavailable(error: unknown): boolean {
    const e = error as { code?: string; message?: string };
    const code = String(e?.code ?? '').toUpperCase();
    const msg = String(e?.message ?? '').toLowerCase();
    const missingTableOrColumn = code === 'P2021' || code === 'P2022';
    const mentionsVersionStore =
      msg.includes('courseversion') ||
      msg.includes('course_version') ||
      msg.includes('course version');
    return missingTableOrColumn || mentionsVersionStore;
  }

  /**
   * Normalizes the publish UI's per-school access payload into
   * `{ schoolId → { gradeName → sectionNames } }`. Empty section list for a
   * grade means "whole grade" (no CourseAccessSection rows written).
   */
  private static normalizeAccess(
    access: AccessPayload[],
  ): Map<string, Map<string, string[]>> {
    const bySchool = new Map<string, Map<string, string[]>>();
    for (const entry of access) {
      const schoolId = String(entry.school_id ?? '').trim();
      if (!schoolId) continue;
      if (!bySchool.has(schoolId)) bySchool.set(schoolId, new Map());
      const gradeMap = bySchool.get(schoolId)!;
      for (const g of entry.grades ?? []) {
        const gradeName = String(g.grade ?? '').trim();
        if (!gradeName) continue;
        const sections = Array.from(
          new Set(
            (g.sections ?? [])
              .map((s) => String(s ?? '').trim())
              .filter(Boolean),
          ),
        );
        // Merge if the same grade appears twice; union sections (but if either
        // side is grade-wide/empty, keep it grade-wide).
        if (gradeMap.has(gradeName)) {
          const existing = gradeMap.get(gradeName)!;
          if (existing.length === 0 || sections.length === 0) {
            gradeMap.set(gradeName, []);
          } else {
            gradeMap.set(gradeName, Array.from(new Set([...existing, ...sections])));
          }
        } else {
          gradeMap.set(gradeName, sections);
        }
      }
    }
    return bySchool;
  }

  /**
   * Resolves a course-write body into an access map, or null if the body
   * carries no targeting at all (content-only build). Accepts either the
   * new structured `access` array or the legacy flat `school_ids` + `grades`
   * (still sent by duplicate/version-revert snapshots).
   */
  /** null/0/absent/negative/non-numeric all mean "no drip" (chapters unlock purely by completion, as before this feature existed). */
  private static parseUnlockInterval(raw: unknown): number | null {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n);
  }

  private static resolveAccessMap(
    body: Record<string, unknown>,
  ): Map<string, Map<string, string[]>> | null {
    if (Array.isArray(body.access)) {
      return AdminCoursesService.normalizeAccess(body.access as AccessPayload[]);
    }
    if (Array.isArray(body.school_ids)) {
      const schoolIds = (body.school_ids as string[])
        .map((s) => String(s ?? '').trim())
        .filter(Boolean);
      const grades = (Array.isArray(body.grades) ? (body.grades as string[]) : [])
        .map((g) => String(g ?? '').trim())
        .filter(Boolean);
      const map = new Map<string, Map<string, string[]>>();
      for (const schoolId of schoolIds) {
        const gradeMap = new Map<string, string[]>();
        for (const grade of grades) gradeMap.set(grade, []); // legacy = grade-wide
        map.set(schoolId, gradeMap);
      }
      return map;
    }
    return null;
  }

  /** Writes CourseAccess → CourseAccessGrade → CourseAccessSection rows. Assumes prior rows already cleared. */
  private async writeCourseAccess(
    courseId: string,
    accessMap: Map<string, Map<string, string[]>>,
  ): Promise<void> {
    for (const [schoolId, gradeMap] of accessMap) {
      const ca = await this.db.courseAccess.create({
        data: { courseId, schoolId },
      });
      for (const [gradeName, sections] of gradeMap) {
        await this.db.courseAccessGrade.create({
          data: {
            courseAccessId: ca.id,
            gradeName,
            sectionAccess:
              sections.length > 0
                ? { create: sections.map((sectionName) => ({ sectionName })) }
                : undefined,
          },
        });
      }
    }
  }

  private toCourseListItem(course: {
    id: string;
    title: string;
    description: string | null;
    thumbnailUrl: string | null;
    isPublished: boolean;
    chapterUnlockIntervalDays?: number | null;
    createdAt: Date;
    updatedAt: Date;
    chapters?: Array<{
      id: string;
      contents?: Array<{ contentType: string }>;
      assignments?: Array<{ id: string }>;
      _count?: { assignments?: number };
    }>;
    courseAccess: Array<{
      id: string;
      schoolId: string;
      gradeAccess?: Array<{
        gradeName: string;
        sectionAccess?: Array<{ sectionName: string }>;
      }>;
      school?: { name: string } | null;
    }>;
  }): CourseListItem {
    const isPublished = !!course.isPublished;
    const grades: string[] = [];
    const course_access: CourseListItem['course_access'] = [];
    const access: AccessTarget[] = [];
    course.courseAccess.forEach((ca) => {
      const gradeEntries = (ca.gradeAccess ?? []).filter((g) => g.gradeName);
      access.push({
        school_id: ca.schoolId,
        school_name: ca.school?.name,
        grades: gradeEntries.map((g) => ({
          grade: g.gradeName,
          sections: (g.sectionAccess ?? []).map((s) => s.sectionName),
        })),
      });
      const gradeList = gradeEntries.map((g) => g.gradeName);
      for (const g of gradeList) {
        if (!grades.includes(g)) grades.push(g);
      }
      const normalizedGrades = gradeEntries.length > 0 ? gradeEntries : null;
      if (normalizedGrades) {
        for (const g of normalizedGrades) {
          course_access.push({
            id: ca.id,
            course_id: course.id,
            school_id: ca.schoolId,
            grade: g.gradeName,
            sections: (g.sectionAccess ?? []).map((s) => s.sectionName),
            schools: ca.school ? { name: ca.school.name } : undefined,
          });
        }
      } else {
        course_access.push({
          id: ca.id,
          course_id: course.id,
          school_id: ca.schoolId,
          grade: '',
          sections: [],
          schools: ca.school ? { name: ca.school.name } : undefined,
        });
      }
    });
    const chapters = Array.isArray(course.chapters) ? course.chapters : [];
    const totalChapters = chapters.length;
    let totalVideos = 0;
    let totalMaterials = 0;
    let totalAssignments = 0;
    for (const chapter of chapters) {
      const chapterAssignments =
        chapter?._count?.assignments ??
        (Array.isArray(chapter?.assignments) ? chapter.assignments.length : 0);
      totalAssignments += chapterAssignments;
      const contents = Array.isArray(chapter.contents) ? chapter.contents : [];
      for (const c of contents) {
        const type = String(c.contentType || '').toLowerCase();
        if (type === 'video' || type === 'video_link') totalVideos += 1;
        else totalMaterials += 1;
      }
    }
    return {
      id: course.id,
      name: course.title,
      description: course.description,
      thumbnail_url: course.thumbnailUrl,
      status: isPublished ? 'Published' : 'Draft',
      is_published: isPublished,
      school_ids: course.courseAccess.map((ca) => ca.schoolId),
      grades,
      access,
      total_chapters: totalChapters,
      num_chapters: totalChapters,
      total_videos: totalVideos,
      total_materials: totalMaterials,
      total_assignments: totalAssignments,
      chapter_unlock_interval_days: course.chapterUnlockIntervalDays ?? null,
      created_at: course.createdAt.toISOString(),
      updated_at: course.updatedAt.toISOString(),
      course_access,
    };
  }

  async list(
    limit?: number,
  ): Promise<{ courses: CourseListItem[]; truncated: boolean }> {
    // Defensive cap: comfortably above any realistic catalog size so normal
    // callers see every course, but a single request can never pull the
    // entire table. Fetch one extra row to detect (and report) truncation
    // instead of silently dropping courses past the cap with no signal.
    const cap = limit ?? 300;
    const rows = await this.db.course.findMany({
      where: { deletedAt: null }, // exclude trashed courses
      orderBy: { createdAt: 'desc' },
      take: cap + 1,
      include: {
        courseAccess: {
          include: {
            school: { select: { name: true } },
            gradeAccess: { include: { sectionAccess: true } },
          },
        },
        chapters: {
          select: {
            id: true,
            contents: { select: { contentType: true } },
            _count: { select: { assignments: true } },
          },
        },
      },
    });
    const truncated = rows.length > cap;
    const courses = truncated ? rows.slice(0, cap) : rows;
    return { courses: courses.map((c) => this.toCourseListItem(c)), truncated };
  }

  async get(id: string): Promise<CourseDetail> {
    const course = await this.db.course.findUnique({
      where: { id },
      include: {
        chapters: {
          orderBy: { sortOrder: 'asc' },
          include: {
            contents: { orderBy: { sortOrder: 'asc' } },
            assignments: {
              orderBy: { sortOrder: 'asc' },
              include: { questions: { orderBy: { sortOrder: 'asc' } } },
            },
          },
        },
        courseAccess: {
          include: {
            school: { select: { name: true } },
            gradeAccess: { include: { sectionAccess: true } },
          },
        },
      },
    });
    if (!course) throw new NotFoundException('Course not found');

    const base = this.toCourseListItem(course);
    const chapters: ChapterDto[] = course.chapters.map((ch) => ({
      id: ch.id,
      course_id: ch.courseId,
      name: ch.title,
      order_number: ch.sortOrder,
      description: null,
    }));

    const chapter_contents: ChapterContentDto[] = course.chapters.flatMap(
      (ch) =>
        (ch.contents || []).map((c) => ({
          id: c.id,
          content_id: c.id,
          chapter_id: ch.id,
          content_type: c.contentType,
          title: c.title,
          content_text: c.contentText,
          content_url: c.contentUrl,
          order_index: c.sortOrder,
          duration_minutes: c.durationMinutes,
        })),
    );

    const assignments: AssignmentDto[] = course.chapters.flatMap((ch) =>
      (ch.assignments || []).map((a) => ({
        id: a.id,
        chapter_id: ch.id,
        title: a.title,
        description: a.description,
        questions: (a.questions || []).map((q) => ({
          id: q.id,
          assignment_id: a.id,
          question_type: q.questionType,
          question_text: q.questionText,
          options: Array.isArray(q.options)
            ? (q.options as string[])
            : undefined,
          correct_answer: q.correctAnswer,
          marks: q.marks ?? 1,
        })),
      })),
    );

    return { ...base, chapters, chapter_contents, assignments };
  }

  // ─── Chapter helpers ──────────────────────────────────────────────────────

  /** Create chapters + their contents/assignments from scratch (used by create + duplicate). */
  private async createChaptersWithContentAndAssignments(
    courseId: string,
    chaptersPayload: ChapterPayload[],
    chapterContentsPayload: ContentPayload[],
    assignmentsPayload: AssignmentPayload[],
  ): Promise<void> {
    const createdChapterIds: string[] = [];
    for (let i = 0; i < chaptersPayload.length; i++) {
      const ch = chaptersPayload[i];
      const title = (ch.name ?? '').toString().trim() || `Chapter ${i + 1}`;
      const sortOrder =
        typeof ch.order_number === 'number' && ch.order_number > 0
          ? ch.order_number
          : i + 1;
      const data: {
        courseId: string;
        title: string;
        sortOrder: number;
        id?: string;
      } = {
        courseId,
        title,
        sortOrder,
      };
      if (isValidUuid(ch.id)) data.id = ch.id;
      const created = await this.db.chapter.create({ data });
      createdChapterIds.push(created.id);
    }

    // Map frontend IDs (temp or real) → server IDs
    const chapterIdMap = new Map<string, string>();
    chaptersPayload.forEach((ch, idx) => {
      const serverId = createdChapterIds[idx];
      if (ch.id) chapterIdMap.set(ch.id, serverId);
      chapterIdMap.set(serverId, serverId);
    });

    await this.upsertContentsForChapters(
      chapterIdMap,
      createdChapterIds,
      chapterContentsPayload,
    );
    await this.upsertAssignmentsForChapters(
      chapterIdMap,
      createdChapterIds,
      assignmentsPayload,
    );
  }

  /**
   * Upsert chapters for an existing course:
   *  – If a chapter ID in the payload already exists in the DB → update title/order, then
   *    replace its contents & assignments.
   *  – If a chapter ID is new (or absent) → create it.
   *  – Chapters in the DB but absent from the payload → deleted (cascade).
   */
  private async upsertChaptersWithContentAndAssignments(
    courseId: string,
    chaptersPayload: ChapterPayload[],
    chapterContentsPayload: ContentPayload[],
    assignmentsPayload: AssignmentPayload[],
  ): Promise<void> {
    const existing = await this.db.chapter.findMany({
      where: { courseId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((ch) => ch.id));

    // chapterIdMap: frontend-sent ID → server DB ID
    const chapterIdMap = new Map<string, string>();
    const keptServerIds: string[] = [];

    for (let i = 0; i < chaptersPayload.length; i++) {
      const ch = chaptersPayload[i];
      const title = (ch.name ?? '').toString().trim() || `Chapter ${i + 1}`;
      const sortOrder =
        typeof ch.order_number === 'number' && ch.order_number > 0
          ? ch.order_number
          : i + 1;

      if (isValidUuid(ch.id) && existingIds.has(ch.id)) {
        // Existing chapter — update metadata only; contents/assignments replaced below
        await this.db.chapter.update({
          where: { id: ch.id },
          data: { title, sortOrder },
        });
        chapterIdMap.set(ch.id, ch.id);
        keptServerIds.push(ch.id);
      } else {
        // New chapter — create with optional hint ID
        const data: {
          courseId: string;
          title: string;
          sortOrder: number;
          id?: string;
        } = {
          courseId,
          title,
          sortOrder,
        };
        if (isValidUuid(ch.id)) data.id = ch.id;
        const created = await this.db.chapter.create({ data });
        if (ch.id) chapterIdMap.set(ch.id, created.id);
        chapterIdMap.set(created.id, created.id);
        keptServerIds.push(created.id);
      }
    }

    // Delete chapters that are no longer in the payload (cascade removes contents & assignments)
    const toDelete = existing
      .filter((ch) => !keptServerIds.includes(ch.id))
      .map((ch) => ch.id);
    if (toDelete.length > 0) {
      await this.db.chapter.deleteMany({ where: { id: { in: toDelete } } });
    }

    await this.upsertContentsForChapters(chapterIdMap, keptServerIds, chapterContentsPayload);
    await this.upsertAssignmentsForChapters(
      chapterIdMap,
      keptServerIds,
      assignmentsPayload,
    );
  }

  /**
   * Upserts chapter contents (lesson materials) by ID instead of wiping and
   * recreating them on every save. `CourseProgress.contentId` is a plain
   * string with no FK/cascade to `ChapterContent` — so a blanket
   * delete+recreate here doesn't error, it silently ORPHANS every student's
   * per-lesson completion record (it just stops matching any current
   * content ID). That makes a student's displayed course-progress
   * percentage drop after ANY course save, even one editing an unrelated
   * chapter, since the denominator/numerator are both recomputed live from
   * current `ChapterContent` rows on every read. Preserving IDs for content
   * that's still present in the payload keeps existing progress records
   * matching.
   */
  private async upsertContentsForChapters(
    chapterIdMap: Map<string, string>,
    keptServerChapterIds: string[],
    chapterContentsPayload: ContentPayload[],
  ): Promise<void> {
    const existingContents = await this.db.chapterContent.findMany({
      where: { chapterId: { in: keptServerChapterIds } },
      select: { id: true },
    });
    const existingContentIds = new Set(existingContents.map((c) => c.id));
    const keptContentIds: string[] = [];

    for (const cc of chapterContentsPayload) {
      const chapterId = chapterIdMap.get(cc.chapter_id);
      if (!chapterId)
        throw new BadRequestException(
          `Chapter ID "${cc.chapter_id}" not found`,
        );
      const data = {
        chapterId,
        contentType: (cc.content_type as string) || 'text',
        title: (cc.title as string) || 'Content',
        contentText: cc.content_text ?? null,
        contentUrl: cc.content_url ?? null,
        sortOrder: typeof cc.order_index === 'number' ? cc.order_index : 0,
        durationMinutes: cc.duration_minutes ?? null,
      };

      if (isValidUuid(cc.id) && existingContentIds.has(cc.id)) {
        await this.db.chapterContent.update({ where: { id: cc.id }, data });
        keptContentIds.push(cc.id);
      } else {
        const created = await this.db.chapterContent.create({
          data: isValidUuid(cc.id) ? { ...data, id: cc.id } : data,
        });
        keptContentIds.push(created.id);
      }
    }

    const toDelete = [...existingContentIds].filter(
      (id) => !keptContentIds.includes(id),
    );
    if (toDelete.length > 0) {
      await this.db.chapterContent.deleteMany({
        where: { id: { in: toDelete } },
      });
    }
  }

  /**
   * Upserts assignments (and their questions) by ID instead of wiping and
   * recreating them on every save. `AssignmentSubmission` cascade-deletes
   * when its `Assignment` is deleted — a blanket delete+recreate here used
   * to silently wipe every student's submission/grade for an assignment
   * any time the course was saved at all, even for an unrelated edit
   * elsewhere in the same chapter. An assignment (or question) whose ID is
   * still present in the payload is updated in place; only ones genuinely
   * removed from the payload are deleted.
   */
  private async upsertAssignmentsForChapters(
    chapterIdMap: Map<string, string>,
    keptServerChapterIds: string[],
    assignmentsPayload: AssignmentPayload[],
  ): Promise<void> {
    const existingAssignments = await this.db.assignment.findMany({
      where: { chapterId: { in: keptServerChapterIds } },
      select: { id: true },
    });
    const existingAssignmentIds = new Set(existingAssignments.map((a) => a.id));
    const keptAssignmentIds: string[] = [];

    for (const ass of assignmentsPayload) {
      const chapterId = chapterIdMap.get(ass.chapter_id);
      if (!chapterId)
        throw new BadRequestException(
          `Chapter ID "${ass.chapter_id}" not found`,
        );

      let assignmentId: string;
      if (isValidUuid(ass.id) && existingAssignmentIds.has(ass.id)) {
        await this.db.assignment.update({
          where: { id: ass.id },
          data: {
            chapterId,
            title: (ass.title as string) || 'Assignment',
            description: ass.description ?? null,
          },
        });
        assignmentId = ass.id;
      } else {
        const data: {
          chapterId: string;
          title: string;
          description: string | null;
          sortOrder: number;
          id?: string;
        } = {
          chapterId,
          title: (ass.title as string) || 'Assignment',
          description: ass.description ?? null,
          sortOrder: 0,
        };
        if (isValidUuid(ass.id)) data.id = ass.id;
        const created = await this.db.assignment.create({ data });
        assignmentId = created.id;
      }
      keptAssignmentIds.push(assignmentId);

      await this.upsertQuestionsForAssignment(
        assignmentId,
        Array.isArray(ass.questions) ? ass.questions : [],
      );
    }

    const toDeleteAssignmentIds = [...existingAssignmentIds].filter(
      (id) => !keptAssignmentIds.includes(id),
    );
    if (toDeleteAssignmentIds.length > 0) {
      await this.db.assignment.deleteMany({
        where: { id: { in: toDeleteAssignmentIds } },
      });
    }
  }

  /** Upserts one assignment's questions by ID — same rationale as above. */
  private async upsertQuestionsForAssignment(
    assignmentId: string,
    questionsPayload: QuestionPayload[],
  ): Promise<void> {
    const existing = await this.db.assignmentQuestion.findMany({
      where: { assignmentId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((q) => q.id));
    const keptIds: string[] = [];

    for (let qi = 0; qi < questionsPayload.length; qi++) {
      const q = questionsPayload[qi];
      const data = {
        assignmentId,
        questionType: (q.question_type as string) || 'MCQ',
        questionText: (q.question_text as string) || '',
        options: Array.isArray(q.options) ? q.options : undefined,
        correctAnswer: q.correct_answer ?? null,
        marks: typeof q.marks === 'number' ? q.marks : 1,
        sortOrder: qi + 1,
      };

      if (isValidUuid(q.id) && existingIds.has(q.id)) {
        await this.db.assignmentQuestion.update({
          where: { id: q.id },
          data,
        });
        keptIds.push(q.id);
      } else {
        const created = await this.db.assignmentQuestion.create({
          data: isValidUuid(q.id) ? { ...data, id: q.id } : data,
        });
        keptIds.push(created.id);
      }
    }

    const toDelete = [...existingIds].filter((id) => !keptIds.includes(id));
    if (toDelete.length > 0) {
      await this.db.assignmentQuestion.deleteMany({
        where: { id: { in: toDelete } },
      });
    }
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async create(body: Record<string, unknown>): Promise<CourseDetail> {
    const name = String(body.name ?? body.title ?? '').trim();
    if (!name) throw new BadRequestException('Course name is required');

    // Duplicate name guard (case-insensitive, live courses only — a trashed
    // course's title must not permanently block reusing that name).
    const duplicate = await this.db.course.findFirst({
      where: { title: { equals: name, mode: 'insensitive' }, deletedAt: null },
    });
    if (duplicate)
      throw new BadRequestException(`A course named "${name}" already exists`);

    const description =
      (body.description as string | undefined)?.trim() || null;
    const thumbnailUrl =
      (body.thumbnail_url as string | undefined)?.trim() || null;
    const isPublished =
      (body.is_published as boolean | undefined) ?? body.status === 'Published';
    const chapterUnlockIntervalDays = AdminCoursesService.parseUnlockInterval(
      body.chapter_unlock_interval_days,
    );

    // The findFirst check above is a read-then-write race (two concurrent
    // creates with the same name can both pass it before either commits) —
    // a DB-level partial unique index on lower(title) (live courses only,
    // see migration 20260804000000) is the real guarantee. Translate its
    // violation into the same friendly error as the pre-check.
    let created: { id: string };
    try {
      created = await this.db.course.create({
        data: {
          title: name,
          description,
          thumbnailUrl,
          isPublished,
          chapterUnlockIntervalDays,
        },
      });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2002') {
        throw new BadRequestException(`A course named "${name}" already exists`);
      }
      throw err;
    }

    // A course is built content-first and starts unassigned — school/grade/
    // section targeting is set later via the Publish flow (setAccess). We only
    // write access here if the caller supplied it (duplicate / version revert
    // pass legacy school_ids+grades or a structured `access` array).
    const accessMap = AdminCoursesService.resolveAccessMap(body);
    const uniqueSchoolIds = accessMap ? Array.from(accessMap.keys()) : [];
    if (accessMap) await this.writeCourseAccess(created.id, accessMap);

    const chapters = (
      Array.isArray(body.chapters) ? body.chapters : []
    ) as ChapterPayload[];
    const chapterContents = (
      Array.isArray(body.chapter_contents) ? body.chapter_contents : []
    ) as ContentPayload[];
    const assignments = (
      Array.isArray(body.assignments) ? body.assignments : []
    ) as AssignmentPayload[];

    if (chapters.length > 0) {
      await this.createChaptersWithContentAndAssignments(
        created.id,
        chapters,
        chapterContents,
        assignments,
      );
    }

    // Students created before this course existed are not enrolled unless we
    // sync here (publish() also enrolls, but create can set isPublished directly).
    if (isPublished && uniqueSchoolIds.length > 0) {
      await this.enrollmentService.enrollRelevantStudentsInCourse(created.id);
    }

    // Notify dashboards
    const adminUsers = await this.db.user.findMany({
      where: { role: Role.admin },
      select: { id: true },
    });
    const schoolAdmins =
      uniqueSchoolIds.length > 0
        ? await this.db.schoolAdmin.findMany({
            where: { schoolId: { in: uniqueSchoolIds } },
            select: { userId: true },
          })
        : [];
    await this.realtimeGateway.emitDashboardStatsForUsers([
      ...adminUsers.map((u) => u.id),
      ...schoolAdmins.map((s) => s.userId),
    ]);

    return this.get(created.id);
  }

  async update(
    id: string,
    body: Record<string, unknown>,
    options?: { skipVersionSnapshot?: boolean },
  ): Promise<CourseDetail> {
    const existing = await this.db.course.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Course not found');

    const data: Record<string, unknown> = {};
    if (body.name || body.title)
      data.title = String(body.name ?? body.title ?? '').trim();
    if (body.description !== undefined)
      data.description =
        (body.description as string | undefined)?.trim() ?? null;
    if (body.thumbnail_url !== undefined)
      data.thumbnailUrl =
        (body.thumbnail_url as string | undefined)?.trim() ?? null;
    if (body.is_published !== undefined || body.status !== undefined) {
      data.isPublished =
        (body.is_published as boolean | undefined) ??
        body.status === 'Published';
    }
    if (body.chapter_unlock_interval_days !== undefined) {
      data.chapterUnlockIntervalDays = AdminCoursesService.parseUnlockInterval(
        body.chapter_unlock_interval_days,
      );
    }

    if (Object.keys(data).length > 0) {
      await this.db.course.update({ where: { id }, data: data as never });
    }

    // NOTE: update() only touches course content + basic fields. School/
    // grade/section targeting is owned entirely by setAccess() (the Publish
    // flow); a content edit never rewrites who the course reaches. Version
    // revert restores targeting by calling setAccess() explicitly.

    if (Array.isArray(body.chapters)) {
      const chapters = body.chapters as ChapterPayload[];
      const chapterContents = (
        Array.isArray(body.chapter_contents) ? body.chapter_contents : []
      ) as ContentPayload[];
      const assignments = (
        Array.isArray(body.assignments) ? body.assignments : []
      ) as AssignmentPayload[];

      // Upsert chapters by ID so existing IDs are preserved — fixes assignment-loss and ID-mismatch bugs
      await this.upsertChaptersWithContentAndAssignments(
        id,
        chapters,
        chapterContents,
        assignments,
      );
    }

    // Realtime notifications
    const adminUsers = await this.db.user.findMany({
      where: { role: Role.admin },
      select: { id: true },
    });
    const existingAccess = await this.db.courseAccess.findMany({
      where: { courseId: id },
      select: { schoolId: true },
    });
    const schoolScope = Array.from(
      new Set(existingAccess.map((a) => a.schoolId)),
    );
    const schoolAdmins =
      schoolScope.length > 0
        ? await this.db.schoolAdmin.findMany({
            where: { schoolId: { in: schoolScope } },
            select: { userId: true },
          })
        : [];
    await this.realtimeGateway.emitDashboardStatsForUsers([
      ...adminUsers.map((u) => u.id),
      ...schoolAdmins.map((s) => s.userId),
    ]);

    if (!options?.skipVersionSnapshot) {
      try {
        await this.saveVersion(id, this.buildAutoChangesSummary(body));
      } catch {
        /* Version saving is best-effort */
      }
    }

    return this.get(id);
  }

  async delete(id: string): Promise<{ success: true }> {
    // Soft delete: unpublish so students lose access immediately; the record
    // lands in the admin Trash and can be restored from there.
    await this.db.course.update({
      where: { id },
      data: { deletedAt: new Date(), isPublished: false },
    });
    return { success: true };
  }

  /**
   * Sets the course's school → grade → section targeting (the Publish flow).
   * Fully replaces any prior targeting. If the course is already published,
   * newly-matching students are enrolled immediately (section-gated). This is
   * the single writer of CourseAccess — build/edit never touch it.
   */
  async setAccess(
    courseId: string,
    body: { access?: AccessPayload[] },
  ): Promise<CourseDetail> {
    const course = await this.db.course.findUnique({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');

    const accessMap = AdminCoursesService.normalizeAccess(
      Array.isArray(body.access) ? body.access : [],
    );

    // Replace wholesale — cascade clears grade + section rows too.
    await this.db.courseAccess.deleteMany({ where: { courseId } });
    await this.writeCourseAccess(courseId, accessMap);

    if (course.isPublished) {
      await this.enrollmentService.enrollRelevantStudentsInCourse(courseId);
    }

    // Notify admins + affected school admins.
    const schoolIds = Array.from(accessMap.keys());
    const [adminUsers, schoolAdmins] = await Promise.all([
      this.db.user.findMany({ where: { role: Role.admin }, select: { id: true } }),
      schoolIds.length > 0
        ? this.db.schoolAdmin.findMany({
            where: { schoolId: { in: schoolIds } },
            select: { userId: true },
          })
        : Promise.resolve([] as Array<{ userId: number }>),
    ]);
    await this.realtimeGateway.emitDashboardStatsForUsers([
      ...adminUsers.map((u) => u.id),
      ...schoolAdmins.map((s) => s.userId),
    ]);

    return this.get(courseId);
  }

  async publish(
    courseId: string,
    body: { publish?: boolean; changes_summary?: string },
  ): Promise<{
    id: string;
    title: string;
    is_published: boolean;
    status: string;
  }> {
    const publishFlag = body?.publish ?? true;

    if (publishFlag) {
      const chapterCount = await this.db.chapter.count({ where: { courseId } });
      if (chapterCount === 0) {
        throw new BadRequestException(
          'Add at least one chapter before publishing this course',
        );
      }
      await this.saveVersion(courseId, body.changes_summary);
    }

    const course = await this.db.course.update({
      where: { id: courseId },
      data: { isPublished: publishFlag },
    });

    if (publishFlag) {
      await this.enrollmentService.enrollRelevantStudentsInCourse(courseId);
    }

    return {
      id: course.id,
      title: course.title,
      is_published: course.isPublished,
      status: course.isPublished ? 'Published' : 'Draft',
    };
  }

  async duplicate(courseId: string): Promise<CourseDetail> {
    const detail = await this.get(courseId);

    // Find a unique copy name
    const baseName = detail.name.replace(/\s*\(Copy(?:\s+\d+)?\)$/i, '').trim();
    let copyName = `${baseName} (Copy)`;
    let copyNum = 1;
    while (
      await this.db.course.findFirst({
        where: { title: { equals: copyName, mode: 'insensitive' }, deletedAt: null },
      })
    ) {
      copyNum++;
      copyName = `${baseName} (Copy ${copyNum})`;
    }

    // Map original chapter IDs → fresh UUIDs so contents/assignments link correctly
    const chapterIdMapping = new Map<string, string>();
    const newChapters = (detail.chapters || []).map((ch) => {
      const newId = randomUUID();
      chapterIdMapping.set(ch.id, newId);
      return { id: newId, name: ch.name, order_number: ch.order_number };
    });

    const newChapterContents = (detail.chapter_contents || []).map((cc) => ({
      chapter_id: chapterIdMapping.get(cc.chapter_id) ?? cc.chapter_id,
      content_type: cc.content_type,
      title: cc.title,
      content_text: cc.content_text ?? undefined,
      content_url: cc.content_url ?? undefined,
      order_index: cc.order_index,
      duration_minutes: cc.duration_minutes ?? undefined,
    }));

    const newAssignments = (detail.assignments || []).map((a) => ({
      chapter_id: chapterIdMapping.get(a.chapter_id) ?? a.chapter_id,
      title: a.title,
      description: a.description ?? undefined,
      questions: (a.questions || []).map((q) => ({
        question_type: q.question_type,
        question_text: q.question_text,
        options: q.options,
        correct_answer: q.correct_answer ?? undefined,
        marks: q.marks,
      })),
    }));

    return this.create({
      name: copyName,
      description: detail.description,
      thumbnail_url: detail.thumbnail_url,
      // Carry the full school→grade→section targeting to the copy.
      access: detail.access,
      is_published: false,
      chapters: newChapters,
      chapter_contents: newChapterContents,
      assignments: newAssignments,
    });
  }

  // ─── Chapters ─────────────────────────────────────────────────────────────

  async getChapters(id: string): Promise<{ chapters: ChapterDto[] }> {
    const chapters = await this.db.chapter.findMany({
      where: { courseId: id },
      orderBy: { sortOrder: 'asc' },
    });
    return {
      chapters: chapters.map((ch) => ({
        id: ch.id,
        course_id: ch.courseId,
        name: ch.title,
        order_number: ch.sortOrder,
        description: null,
      })),
    };
  }

  async addChapter(
    id: string,
    body: Record<string, unknown>,
  ): Promise<ChapterDto> {
    const name = String(body.name ?? body.title ?? '').trim();
    const existingCount = await this.db.chapter.count({
      where: { courseId: id },
    });
    const created = await this.db.chapter.create({
      data: {
        courseId: id,
        title: name || `Chapter ${existingCount + 1}`,
        sortOrder:
          (body.order_number as number | undefined) ?? existingCount + 1,
      },
    });
    return {
      id: created.id,
      course_id: created.courseId,
      name: created.title,
      order_number: created.sortOrder,
      description: null,
    };
  }

  // ─── Versions ─────────────────────────────────────────────────────────────

  async getVersions(courseId: string): Promise<{
    versions: Array<{
      id: string;
      version_number: number;
      changes_summary: string | null;
      created_at: string;
      snapshot_summary: {
        name: string | null;
        description: string | null;
        thumbnail_url: string | null;
        chapters_count: number;
        assignments_count: number;
        grades: string[];
      } | null;
    }>;
  }> {
    const course = await this.db.course.findUnique({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');

    let versions: Array<{
      id: string;
      versionNumber: number;
      changesSummary: string | null;
      createdAt: Date;
      snapshot: unknown;
    }> = [];
    try {
      versions = await this.db.courseVersion.findMany({
        where: { courseId },
        orderBy: { versionNumber: 'desc' },
      });
    } catch (error) {
      if (!this.isCourseVersionStorageUnavailable(error)) throw error;
      versions = [];
    }

    return {
      versions: versions.map((v) => {
        const snap =
          v.snapshot && typeof v.snapshot === 'object'
            ? (v.snapshot as Record<string, unknown>)
            : null;
        const chapters = Array.isArray(snap?.chapters)
          ? (snap.chapters as unknown[])
          : [];
        const assignments = Array.isArray(snap?.assignments)
          ? (snap.assignments as unknown[])
          : [];
        const grades = Array.isArray(snap?.grades)
          ? (snap.grades as string[])
          : [];
        return {
          id: v.id,
          version_number: v.versionNumber,
          changes_summary: v.changesSummary,
          created_at: v.createdAt.toISOString(),
          snapshot_summary: snap
            ? {
                name: (snap.title ?? snap.name ?? null) as string | null,
                description: (snap.description ?? null) as string | null,
                thumbnail_url: (snap.thumbnailUrl ??
                  snap.thumbnail_url ??
                  null) as string | null,
                chapters_count: chapters.length,
                assignments_count: assignments.length,
                grades,
              }
            : null,
        };
      }),
    };
  }

  async revertVersion(
    courseId: string,
    body: { version_id?: string; version_number?: number },
  ): Promise<CourseDetail> {
    const course = await this.db.course.findUnique({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');

    const version = body.version_id
      ? await this.db.courseVersion.findFirst({
          where: { id: body.version_id, courseId },
        })
      : body.version_number != null
        ? await this.db.courseVersion.findUnique({
            where: {
              courseId_versionNumber: {
                courseId,
                versionNumber: body.version_number,
              },
            },
          })
        : null;

    if (!version || !version.snapshot || typeof version.snapshot !== 'object') {
      throw new NotFoundException('Version not found or has no snapshot');
    }

    const snap = version.snapshot as Record<string, unknown>;
    // Restore content (update never touches access).
    await this.update(
      courseId,
      {
        name: snap.title ?? snap.name,
        description: snap.description,
        thumbnail_url: snap.thumbnailUrl,
        chapters: (snap.chapters as unknown[]) ?? [],
        chapter_contents: (snap.chapter_contents as unknown[]) ?? [],
        assignments: (snap.assignments as unknown[]) ?? [],
      },
      { skipVersionSnapshot: true },
    );

    // Restore targeting. Newer snapshots carry a structured `access`; older
    // ones only have flat school_ids + grades (grade-wide) — resolveAccessMap
    // handles both, and setAccess writes it back.
    const accessMap = AdminCoursesService.resolveAccessMap({
      access: snap.access,
      school_ids: snap.school_ids,
      grades: snap.grades,
    });
    if (accessMap) {
      const accessPayload: AccessPayload[] = Array.from(accessMap.entries()).map(
        ([school_id, gradeMap]) => ({
          school_id,
          grades: Array.from(gradeMap.entries()).map(([grade, sections]) => ({
            grade,
            sections,
          })),
        }),
      );
      await this.setAccess(courseId, { access: accessPayload });
    } else {
      await this.setAccess(courseId, { access: [] });
    }

    return this.get(courseId);
  }

  async saveVersion(
    courseId: string,
    changesSummary?: string,
  ): Promise<{ id: string; version_number: number }> {
    const course = await this.db.course.findUnique({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');

    const detail = await this.get(courseId);
    let versionNumber = 1;
    try {
      const last = await this.db.courseVersion.findFirst({
        where: { courseId },
        orderBy: { versionNumber: 'desc' },
      });
      versionNumber = (last?.versionNumber ?? 0) + 1;
    } catch (error) {
      if (!this.isCourseVersionStorageUnavailable(error)) throw error;
      return { id: 'version-storage-unavailable', version_number: 0 };
    }

    const snapshot = {
      title: detail.name,
      description: detail.description,
      thumbnailUrl: detail.thumbnail_url,
      school_ids: detail.school_ids,
      grades: detail.grades,
      // Full school→grade→section targeting so a revert restores distribution
      // (not just the flat grade list) alongside content.
      access: detail.access,
      chapters: detail.chapters,
      chapter_contents: detail.chapter_contents ?? [],
      assignments: detail.assignments ?? [],
    };

    let created: { id: string };
    try {
      created = await this.db.courseVersion.create({
        data: {
          courseId,
          versionNumber,
          changesSummary: changesSummary ?? null,
          snapshot,
        },
      });
    } catch (error) {
      if (!this.isCourseVersionStorageUnavailable(error)) throw error;
      return { id: 'version-storage-unavailable', version_number: 0 };
    }

    return { id: created.id, version_number: versionNumber };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private buildAutoChangesSummary(body: Record<string, unknown>): string {
    const parts: string[] = [];
    if (body.name || body.title) parts.push('name');
    if (body.description !== undefined) parts.push('description');
    if (body.thumbnail_url !== undefined) parts.push('thumbnail');
    if (Array.isArray(body.school_ids)) parts.push('school/grade assignment');
    if (Array.isArray(body.chapters)) parts.push('chapters & content');
    if (parts.length === 0) return 'Course updated';
    return `Updated: ${parts.join(', ')}`;
  }
}
