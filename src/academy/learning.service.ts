import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/database.service';

export const QUIZ_PASS_PERCENT = 60;

type QuizQuestion = { question: string; options: string[]; answer: number };

/** What a learner may see of a quiz: never the answers. */
export function publicQuiz(
  quiz: unknown,
): { question: string; options: string[] }[] {
  return ((quiz as QuizQuestion[] | null) ?? []).map(
    ({ question, options }) => ({ question, options }),
  );
}

/** Server-side grading; `correct` is only revealed after submitting. */
export function gradeQuiz(quiz: unknown, answers: number[]) {
  const questions = (quiz as QuizQuestion[] | null) ?? [];
  if (questions.length === 0)
    throw new BadRequestException('This quiz has no questions');
  const correct = questions.map((q, i) => answers[i] === q.answer);
  const score = Math.round(
    (correct.filter(Boolean).length / questions.length) * 100,
  );
  return { score, passed: score >= QUIZ_PASS_PERCENT, correct };
}

const shortId = () => randomBytes(5).toString('hex').toUpperCase(); // 10 chars

@Injectable()
export class LearningService {
  constructor(private readonly db: DatabaseService) {}

  private async enrollment(learnerId: string, courseId: string) {
    return this.db.academyEnrollment.findUnique({
      where: { learnerId_courseId: { learnerId, courseId } },
    });
  }

  async myCourses(learnerId: string) {
    const enrollments = await this.db.academyEnrollment.findMany({
      where: { learnerId },
      orderBy: { enrolledAt: 'desc' },
    });
    const ids = enrollments.map((e) => e.courseId);
    const [courses, done] = await Promise.all([
      this.db.academyCourse.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          title: true,
          thumbnailUrl: true,
          modules: { select: { _count: { select: { lessons: true } } } },
        },
      }),
      this.db.academyLessonProgress.groupBy({
        by: ['courseId'],
        where: { learnerId, courseId: { in: ids } },
        _count: true,
      }),
    ]);
    const doneBy = new Map(done.map((d) => [d.courseId, d._count]));
    const byId = new Map(courses.map((c) => [c.id, c]));
    return enrollments.flatMap((e) => {
      const c = byId.get(e.courseId);
      if (!c) return [];
      const total = c.modules.reduce((n, m) => n + m._count.lessons, 0);
      const completed = doneBy.get(c.id) ?? 0;
      return [
        {
          id: c.id,
          title: c.title,
          thumbnailUrl: c.thumbnailUrl,
          totalLessons: total,
          completedLessons: completed,
          progress: total ? Math.round((completed / total) * 100) : 0,
          completedAt: e.completedAt,
        },
      ];
    });
  }

  /**
   * The player's view of a course. Enrolled learners get every lesson;
   * otherwise only `isPreview` lessons carry content. Quiz answers never leave.
   */
  async course(courseId: string, learnerId: string | null) {
    const course = await this.db.academyCourse.findFirst({
      where: { id: courseId, isPublished: true },
      include: {
        modules: {
          orderBy: { sortOrder: 'asc' },
          include: { lessons: { orderBy: { sortOrder: 'asc' } } },
        },
      },
    });
    if (!course) throw new NotFoundException('Course not found');
    const enrolled = learnerId
      ? await this.enrollment(learnerId, courseId)
      : null;
    const done = enrolled
      ? await this.db.academyLessonProgress.findMany({
          where: { learnerId: learnerId!, courseId },
          select: { lessonId: true, quizScore: true },
        })
      : [];
    const doneBy = new Map(done.map((d) => [d.lessonId, d]));
    return {
      id: course.id,
      title: course.title,
      description: course.description,
      enrolled: Boolean(enrolled),
      completedAt: enrolled?.completedAt ?? null,
      modules: course.modules.map((m) => ({
        id: m.id,
        title: m.title,
        lessons: m.lessons.map((l) => {
          const open = Boolean(enrolled) || l.isPreview;
          return {
            id: l.id,
            title: l.title,
            type: l.type,
            durationMinutes: l.durationMinutes,
            isPreview: l.isPreview,
            locked: !open,
            completed: doneBy.has(l.id),
            quizScore: doneBy.get(l.id)?.quizScore ?? null,
            ...(open
              ? {
                  contentUrl: l.contentUrl,
                  body: l.body,
                  quiz: l.type === 'QUIZ' ? publicQuiz(l.quiz) : null,
                }
              : {}),
          };
        }),
      })),
    };
  }

  private async lessonFor(learnerId: string, lessonId: string) {
    const lesson = await this.db.academyLesson.findUnique({
      where: { id: lessonId },
      include: { module: { select: { courseId: true } } },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (!(await this.enrollment(learnerId, lesson.module.courseId))) {
      throw new ForbiddenException('Buy this course to continue');
    }
    return lesson;
  }

  async completeLesson(learnerId: string, lessonId: string) {
    const lesson = await this.lessonFor(learnerId, lessonId);
    if (lesson.type === 'QUIZ')
      throw new BadRequestException('Pass the quiz to complete this lesson');
    await this.record(learnerId, lesson.module.courseId, lessonId, null);
    return this.afterProgress(learnerId, lesson.module.courseId);
  }

  async submitQuiz(learnerId: string, lessonId: string, answers: number[]) {
    const lesson = await this.lessonFor(learnerId, lessonId);
    if (lesson.type !== 'QUIZ') throw new BadRequestException('Not a quiz');
    const result = gradeQuiz(lesson.quiz, answers);
    if (result.passed)
      await this.record(
        learnerId,
        lesson.module.courseId,
        lessonId,
        result.score,
      );
    return {
      ...result,
      ...(await this.afterProgress(learnerId, lesson.module.courseId)),
    };
  }

  private record(
    learnerId: string,
    courseId: string,
    lessonId: string,
    quizScore: number | null,
  ) {
    return this.db.academyLessonProgress.upsert({
      where: { learnerId_lessonId: { learnerId, lessonId } },
      create: { learnerId, courseId, lessonId, quizScore },
      update: quizScore === null ? {} : { quizScore },
    });
  }

  /** When every lesson is done: mark the enrollment complete and issue the certificate (once). */
  async afterProgress(learnerId: string, courseId: string) {
    const [total, done] = await Promise.all([
      this.db.academyLesson.count({ where: { module: { courseId } } }),
      this.db.academyLessonProgress.count({ where: { learnerId, courseId } }),
    ]);
    if (total === 0 || done < total)
      return { courseCompleted: false, certificateId: null };

    const existing = await this.db.academyCertificate.findUnique({
      where: { learnerId_courseId: { learnerId, courseId } },
    });
    if (existing)
      return { courseCompleted: true, certificateId: existing.shortId };

    const [account, course] = await Promise.all([
      this.db.academyAccount.findUnique({
        where: { id: learnerId },
        select: { fullName: true },
      }),
      this.db.academyCourse.findUnique({
        where: { id: courseId },
        select: { title: true },
      }),
    ]);
    await this.db.academyEnrollment.updateMany({
      where: { learnerId, courseId, completedAt: null },
      data: { completedAt: new Date() },
    });
    try {
      const cert = await this.db.academyCertificate.create({
        data: {
          shortId: shortId(),
          learnerId,
          courseId,
          learnerName: account?.fullName ?? 'Learner',
          courseTitle: course?.title ?? 'Course',
        },
      });
      return { courseCompleted: true, certificateId: cert.shortId };
    } catch (e) {
      // Two lessons finished at once: the other request already issued it.
      if ((e as { code?: string }).code !== 'P2002') throw e;
      const cert = await this.db.academyCertificate.findUnique({
        where: { learnerId_courseId: { learnerId, courseId } },
      });
      return { courseCompleted: true, certificateId: cert?.shortId ?? null };
    }
  }

  myCertificates(learnerId: string) {
    return this.db.academyCertificate.findMany({
      where: { learnerId },
      orderBy: { issuedAt: 'desc' },
    });
  }

  /** Public verification by short id. */
  async certificate(shortIdValue: string) {
    const cert = await this.db.academyCertificate.findUnique({
      where: { shortId: shortIdValue.toUpperCase() },
      select: {
        shortId: true,
        learnerName: true,
        courseTitle: true,
        issuedAt: true,
      },
    });
    if (!cert) throw new NotFoundException('Certificate not found');
    return cert;
  }
}
