import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AcademyLessonType, Prisma } from '@prisma/client';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../common/storage/storage.service';
import type { CourseDto, LessonDto, ModuleDto } from './academy.dto';

const UPLOAD_TYPES = new Set([
  'application/pdf',
  'video/mp4',
  'video/webm',
  'image/png',
  'image/jpeg',
  'image/webp',
]);
// ponytail: buffered in memory by multer; for long videos use YouTube (unlisted) /
// Vimeo links, or switch to presigned direct-to-S3 uploads if big files become common.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** LMS ChapterContent.contentType → Academy lesson type (the only LMS → Academy mapping). */
export function lessonTypeFromLms(contentType: string): AcademyLessonType {
  if (contentType === 'video' || contentType === 'video_link') return 'VIDEO';
  if (contentType === 'pdf') return 'PDF';
  if (contentType === 'text' || contentType === 'html') return 'TEXT';
  return 'LINK';
}

@Injectable()
export class CourseBuilderService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  // ─── Courses ───────────────────────────────────────────────────────────────

  async listCourses() {
    const courses = await this.db.academyCourse.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        modules: { select: { _count: { select: { lessons: true } } } },
      },
    });
    const learners = await this.db.academyEnrollment.groupBy({
      by: ['courseId'],
      _count: true,
    });
    const learnersBy = new Map(learners.map((l) => [l.courseId, l._count]));
    return courses.map(({ modules, ...c }) => ({
      ...c,
      moduleCount: modules.length,
      lessonCount: modules.reduce((n, m) => n + m._count.lessons, 0),
      learnerCount: learnersBy.get(c.id) ?? 0,
    }));
  }

  async getCourse(id: string) {
    const course = await this.db.academyCourse.findUnique({
      where: { id },
      include: {
        modules: {
          orderBy: { sortOrder: 'asc' },
          include: { lessons: { orderBy: { sortOrder: 'asc' } } },
        },
      },
    });
    if (!course) throw new NotFoundException('Course not found');
    return course;
  }

  createCourse(dto: CourseDto) {
    return this.db.academyCourse.create({
      data: { ...dto, isPublished: false },
    });
  }

  async updateCourse(id: string, dto: Partial<CourseDto>) {
    if (dto.isPublished) {
      const lessons = await this.db.academyLesson.count({
        where: { module: { courseId: id } },
      });
      if (lessons === 0)
        throw new BadRequestException(
          'Add at least one lesson before publishing',
        );
    }
    return this.db.academyCourse.update({ where: { id }, data: dto });
  }

  async deleteCourse(id: string) {
    const learners = await this.db.academyEnrollment.count({
      where: { courseId: id },
    });
    if (learners > 0) {
      throw new BadRequestException(
        `${learners} learner(s) own this course — unpublish it instead`,
      );
    }
    await this.db.academyCourse.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Modules & lessons ─────────────────────────────────────────────────────

  async addModule(courseId: string, dto: ModuleDto) {
    const last = await this.db.academyModule.aggregate({
      where: { courseId },
      _max: { sortOrder: true },
    });
    return this.db.academyModule.create({
      data: {
        courseId,
        title: dto.title,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
    });
  }

  updateModule(id: string, dto: ModuleDto) {
    return this.db.academyModule.update({
      where: { id },
      data: { title: dto.title },
    });
  }

  async deleteModule(id: string) {
    await this.db.academyModule.delete({ where: { id } });
    return { ok: true };
  }

  async addLesson(moduleId: string, dto: LessonDto) {
    const last = await this.db.academyLesson.aggregate({
      where: { moduleId },
      _max: { sortOrder: true },
    });
    return this.db.academyLesson.create({
      data: {
        moduleId,
        ...this.lessonData(dto),
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
    });
  }

  updateLesson(id: string, dto: LessonDto) {
    return this.db.academyLesson.update({
      where: { id },
      data: this.lessonData(dto),
    });
  }

  async deleteLesson(id: string) {
    await this.db.academyLesson.delete({ where: { id } });
    return { ok: true };
  }

  private lessonData(dto: LessonDto) {
    if (dto.type === 'QUIZ') {
      if (!dto.quiz?.length)
        throw new BadRequestException('Add at least one question');
      for (const q of dto.quiz) {
        if (q.answer >= q.options.length)
          throw new BadRequestException(
            `Pick the right answer for "${q.question}"`,
          );
      }
    } else if (dto.type === 'TEXT') {
      if (!dto.body?.trim())
        throw new BadRequestException('Write the lesson text');
    } else if (!dto.contentUrl?.trim()) {
      throw new BadRequestException('Add a link or upload a file');
    }
    return {
      title: dto.title,
      type: dto.type,
      contentUrl:
        dto.type === 'TEXT' || dto.type === 'QUIZ'
          ? null
          : dto.contentUrl!.trim(),
      body: dto.type === 'TEXT' ? dto.body! : (dto.body ?? null),
      quiz:
        dto.type === 'QUIZ'
          ? (dto.quiz as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
      durationMinutes: dto.durationMinutes ?? null,
      isPreview: dto.isPreview ?? false,
    };
  }

  /** Swap a module with its neighbour above/below. */
  async moveModule(id: string, direction: 'up' | 'down') {
    const item = await this.db.academyModule.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Module not found');
    const other = await this.db.academyModule.findFirst({
      where: {
        courseId: item.courseId,
        sortOrder:
          direction === 'up' ? { lt: item.sortOrder } : { gt: item.sortOrder },
      },
      orderBy: { sortOrder: direction === 'up' ? 'desc' : 'asc' },
    });
    if (other) {
      await this.db.$transaction([
        this.db.academyModule.update({
          where: { id: item.id },
          data: { sortOrder: other.sortOrder },
        }),
        this.db.academyModule.update({
          where: { id: other.id },
          data: { sortOrder: item.sortOrder },
        }),
      ]);
    }
    return { ok: true };
  }

  /** Swap a lesson with its neighbour above/below in the same module. */
  async moveLesson(id: string, direction: 'up' | 'down') {
    const item = await this.db.academyLesson.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Lesson not found');
    const other = await this.db.academyLesson.findFirst({
      where: {
        moduleId: item.moduleId,
        sortOrder:
          direction === 'up' ? { lt: item.sortOrder } : { gt: item.sortOrder },
      },
      orderBy: { sortOrder: direction === 'up' ? 'desc' : 'asc' },
    });
    if (other) {
      await this.db.$transaction([
        this.db.academyLesson.update({
          where: { id: item.id },
          data: { sortOrder: other.sortOrder },
        }),
        this.db.academyLesson.update({
          where: { id: other.id },
          data: { sortOrder: item.sortOrder },
        }),
      ]);
    }
    return { ok: true };
  }

  // ─── Uploads ───────────────────────────────────────────────────────────────

  async upload(
    file:
      | { buffer: Buffer; mimetype: string; size: number; originalname: string }
      | undefined,
  ) {
    if (!file) throw new BadRequestException('No file received');
    if (!UPLOAD_TYPES.has(file.mimetype)) {
      throw new BadRequestException('Upload a PDF, MP4/WebM video or an image');
    }
    if (file.size > MAX_UPLOAD_BYTES)
      throw new BadRequestException('Files must be under 100 MB');
    const url = await this.storage.uploadBuffer(
      this.storage.buildKey('academy', file.originalname),
      file.buffer,
      file.mimetype,
    );
    return { url };
  }

  // ─── Import from LMS (one-way copy; the only code that reads LMS tables) ──

  lmsCourses() {
    return this.db.course.findMany({
      where: { deletedAt: null },
      orderBy: { title: 'asc' },
      select: {
        id: true,
        title: true,
        isPublished: true,
        _count: { select: { chapters: true } },
      },
    });
  }

  async importLmsCourse(lmsCourseId: string) {
    const src = await this.db.course.findFirst({
      where: { id: lmsCourseId, deletedAt: null },
      include: {
        chapters: {
          orderBy: { sortOrder: 'asc' },
          include: { contents: { orderBy: { sortOrder: 'asc' } } },
        },
      },
    });
    if (!src) throw new NotFoundException('LMS course not found');
    return this.db.academyCourse.create({
      data: {
        title: src.title,
        description: src.description,
        thumbnailUrl: src.thumbnailUrl,
        isPublished: false,
        importedFromLmsCourseId: src.id,
        modules: {
          create: src.chapters.map((ch, i) => ({
            title: ch.title,
            sortOrder: i,
            lessons: {
              create: ch.contents.map((c, j) => {
                const type = lessonTypeFromLms(c.contentType);
                return {
                  title: c.title,
                  type,
                  contentUrl: type === 'TEXT' ? null : c.contentUrl,
                  body: type === 'TEXT' ? (c.contentText ?? '') : null,
                  durationMinutes: c.durationMinutes,
                  sortOrder: j,
                };
              }),
            },
          })),
        },
      },
      select: { id: true, title: true },
    });
  }
}
