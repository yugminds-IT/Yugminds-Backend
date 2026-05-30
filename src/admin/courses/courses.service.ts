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

type CourseListItem = {
  id: string;
  name: string;
  description?: string | null;
  thumbnail_url?: string | null;
  status: 'Draft' | 'Published';
  is_published: boolean;
  school_ids: string[];
  grades: string[];
  total_chapters: number;
  num_chapters: number;
  total_videos: number;
  total_materials: number;
  total_assignments: number;
  created_at: string;
  updated_at: string;
  course_access?: Array<{
    id: string;
    course_id: string;
    school_id: string;
    grade: string;
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
  chapter_id: string;
  content_type?: string;
  title?: string;
  content_text?: string;
  content_url?: string;
  order_index?: number;
  duration_minutes?: number;
};
type QuestionPayload = {
  question_type?: string;
  question_text?: string;
  options?: string[];
  correct_answer?: string;
  marks?: number;
};
type AssignmentPayload = {
  chapter_id: string;
  title?: string;
  description?: string;
  questions?: QuestionPayload[];
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

  private static buildGradesBySchool(
    schoolIds: string[],
    grades: string[],
  ): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    const normalizedSchools = schoolIds
      .map((s) => String(s ?? '').trim())
      .filter(Boolean);
    const normalizedGrades = grades
      .map((g) => String(g ?? '').trim())
      .filter(Boolean);
    for (const schoolId of normalizedSchools) {
      if (!map.has(schoolId)) map.set(schoolId, new Set<string>());
      for (const grade of normalizedGrades) {
        map.get(schoolId)!.add(grade);
      }
    }
    return map;
  }

  private toCourseListItem(course: {
    id: string;
    title: string;
    description: string | null;
    thumbnailUrl: string | null;
    isPublished: boolean;
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
      grades?: unknown;
      school?: { name: string } | null;
    }>;
  }): CourseListItem {
    const isPublished = !!course.isPublished;
    const grades: string[] = [];
    const course_access: CourseListItem['course_access'] = [];
    course.courseAccess.forEach((ca) => {
      if (Array.isArray(ca.grades)) {
        ca.grades.forEach((g: string) => {
          if (g && !grades.includes(g)) grades.push(g);
        });
      }
      const gradeList = Array.isArray(ca.grades)
        ? (ca.grades as string[]).filter(Boolean)
        : [];
      const normalizedGrades = gradeList.length > 0 ? gradeList : [''];
      for (const grade of normalizedGrades) {
        course_access.push({
          id: ca.id,
          course_id: course.id,
          school_id: ca.schoolId,
          grade: typeof grade === 'string' ? grade : String(grade ?? ''),
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
      total_chapters: totalChapters,
      num_chapters: totalChapters,
      total_videos: totalVideos,
      total_materials: totalMaterials,
      total_assignments: totalAssignments,
      created_at: course.createdAt.toISOString(),
      updated_at: course.updatedAt.toISOString(),
      course_access,
    };
  }

  async list(): Promise<{ courses: CourseListItem[] }> {
    const courses = await this.db.course.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        courseAccess: { include: { school: { select: { name: true } } } },
        chapters: {
          select: {
            id: true,
            contents: { select: { contentType: true } },
            _count: { select: { assignments: true } },
          },
        },
      },
    });
    return { courses: courses.map((c) => this.toCourseListItem(c)) };
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
        courseAccess: { include: { school: { select: { name: true } } } },
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

    await this.createContentsAndAssignments(
      chapterIdMap,
      chapterContentsPayload,
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

    // Replace contents & assignments for every kept/new chapter
    for (const serverId of keptServerIds) {
      await this.db.assignmentQuestion.deleteMany({
        where: { assignment: { chapterId: serverId } },
      });
      await this.db.assignment.deleteMany({ where: { chapterId: serverId } });
      await this.db.chapterContent.deleteMany({
        where: { chapterId: serverId },
      });
    }

    await this.createContentsAndAssignments(
      chapterIdMap,
      chapterContentsPayload,
      assignmentsPayload,
    );
  }

  /** Insert contents and assignments, resolving chapter IDs via the provided map. */
  private async createContentsAndAssignments(
    chapterIdMap: Map<string, string>,
    chapterContentsPayload: ContentPayload[],
    assignmentsPayload: AssignmentPayload[],
  ): Promise<void> {
    for (const cc of chapterContentsPayload) {
      const chapterId = chapterIdMap.get(cc.chapter_id);
      if (!chapterId)
        throw new BadRequestException(
          `Chapter ID "${cc.chapter_id}" not found`,
        );
      await this.db.chapterContent.create({
        data: {
          chapterId,
          contentType: (cc.content_type as string) || 'text',
          title: (cc.title as string) || 'Content',
          contentText: cc.content_text ?? null,
          contentUrl: cc.content_url ?? null,
          sortOrder: typeof cc.order_index === 'number' ? cc.order_index : 0,
          durationMinutes: cc.duration_minutes ?? null,
        },
      });
    }

    for (const ass of assignmentsPayload) {
      const chapterId = chapterIdMap.get(ass.chapter_id);
      if (!chapterId)
        throw new BadRequestException(
          `Chapter ID "${ass.chapter_id}" not found`,
        );
      const assignment = await this.db.assignment.create({
        data: {
          chapterId,
          title: (ass.title as string) || 'Assignment',
          description: ass.description ?? null,
          sortOrder: 0,
        },
      });
      const questions = Array.isArray(ass.questions) ? ass.questions : [];
      for (let qi = 0; qi < questions.length; qi++) {
        const q = questions[qi];
        await this.db.assignmentQuestion.create({
          data: {
            assignmentId: assignment.id,
            questionType: (q.question_type as string) || 'MCQ',
            questionText: (q.question_text as string) || '',
            options: Array.isArray(q.options) ? q.options : undefined,
            correctAnswer: q.correct_answer ?? null,
            marks: typeof q.marks === 'number' ? q.marks : 1,
            sortOrder: qi + 1,
          },
        });
      }
    }
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async create(body: Record<string, unknown>): Promise<CourseDetail> {
    const name = String(body.name ?? body.title ?? '').trim();
    if (!name) throw new BadRequestException('Course name is required');

    // Duplicate name guard (case-insensitive)
    const duplicate = await this.db.course.findFirst({
      where: { title: { equals: name, mode: 'insensitive' } },
    });
    if (duplicate)
      throw new BadRequestException(`A course named "${name}" already exists`);

    const description =
      (body.description as string | undefined)?.trim() || null;
    const thumbnailUrl =
      (body.thumbnail_url as string | undefined)?.trim() || null;
    const isPublished =
      (body.is_published as boolean | undefined) ?? body.status === 'Published';

    const schoolIds = Array.isArray(body.school_ids)
      ? (body.school_ids as string[])
      : [];
    const gradesArr = Array.isArray(body.grades)
      ? (body.grades as string[])
      : [];

    const created = await this.db.course.create({
      data: { title: name, description, thumbnailUrl, isPublished },
    });

    const gradesBySchool = AdminCoursesService.buildGradesBySchool(
      schoolIds,
      gradesArr,
    );
    const uniqueSchoolIds = Array.from(gradesBySchool.keys());
    for (const schoolId of uniqueSchoolIds) {
      await this.db.courseAccess.create({
        data: {
          courseId: created.id,
          schoolId,
          grades: Array.from(gradesBySchool.get(schoolId) ?? []),
        },
      });
    }

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

    if (Object.keys(data).length > 0) {
      await this.db.course.update({ where: { id }, data: data as never });
    }

    let impactedSchoolIds: string[] = [];
    if (Array.isArray(body.school_ids)) {
      const schoolIds = body.school_ids as string[];
      const gradesArr = Array.isArray(body.grades)
        ? (body.grades as string[])
        : [];
      await this.db.courseAccess.deleteMany({ where: { courseId: id } });
      const gradesBySchool = AdminCoursesService.buildGradesBySchool(
        schoolIds,
        gradesArr,
      );
      const uniqueSchoolIds = Array.from(gradesBySchool.keys());
      impactedSchoolIds = uniqueSchoolIds;
      for (const schoolId of uniqueSchoolIds) {
        await this.db.courseAccess.create({
          data: {
            courseId: id,
            schoolId,
            grades: Array.from(gradesBySchool.get(schoolId) ?? []),
          },
        });
      }

      // If course is already published, enroll new students
      if (existing.isPublished) {
        await this.enrollmentService.enrollRelevantStudentsInCourse(id);
      }
    }

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
      new Set([...impactedSchoolIds, ...existingAccess.map((a) => a.schoolId)]),
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
    await this.db.course.delete({ where: { id } });
    return { success: true };
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
        where: { title: { equals: copyName, mode: 'insensitive' } },
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
      school_ids: detail.school_ids,
      grades: detail.grades,
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
    await this.update(
      courseId,
      {
        name: snap.title ?? snap.name,
        description: snap.description,
        thumbnail_url: snap.thumbnailUrl,
        school_ids: snap.school_ids ?? [],
        grades: snap.grades ?? [],
        chapters: (snap.chapters as unknown[]) ?? [],
        chapter_contents: (snap.chapter_contents as unknown[]) ?? [],
        assignments: (snap.assignments as unknown[]) ?? [],
      },
      { skipVersionSnapshot: true },
    );
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
