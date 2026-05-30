import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  NotFoundException,
  BadRequestException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { DatabaseService } from '../../database/database.service';
import { RankingService } from '../../common/assignment/ranking.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { AssignmentsHierarchyQueryDto } from './dto/assignments-hierarchy-query.dto';
import { SimpleProgressDto } from './dto/simple-progress.dto';

@Controller('student')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.student)
export class StudentExtraController {
  constructor(
    private readonly db: DatabaseService,
    private readonly ranking: RankingService,
  ) {}

  private async recomputeStudentScores(
    studentId: number,
    assignmentCourseId?: string | null,
  ) {
    await this.ranking.recomputeStudentScores(studentId, assignmentCourseId);
  }

  @Get('certificates')
  async listCertificates(@CurrentUser() user: { id: number }) {
    const certs = await this.db.studentCertificate.findMany({
      where: { studentId: user.id },
      orderBy: { issuedAt: 'desc' },
      include: {
        course: true,
        student: { include: { profile: true } },
      },
    });
    return {
      certificates: certs.map((c) => ({
        id: c.id,
        course_id: c.courseId,
        certificate_name: c.certificateName,
        certificate_url: c.certificateUrl,
        issued_at: c.issuedAt.toISOString(),
        courses: {
          id: c.courseId,
          name: c.course?.title ?? '',
          title: c.course?.title ?? '',
          grade: '',
          subject: '',
        },
        profiles: {
          full_name: c.student?.profile?.fullName ?? c.student?.email ?? '',
        },
      })),
    };
  }

  private static escapeXml(s: string) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /** Derives a short, human-readable certificate code from a UUID (e.g. "YM-A1B2C3D4") */
  static shortCertId(fullId: string): string {
    return 'YM-' + fullId.replace(/-/g, '').slice(0, 8).toUpperCase();
  }

  static async svgToJpeg(svg: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharp = require('sharp') as typeof import('sharp');
    const buffer = await sharp(Buffer.from(svg))
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  }

  static buildCertificateSvg(
    params: {
      studentName: string;
      courseTitle: string;
      issuedAt: string;
      certificateId: string;
    },
    templateSvg?: string | null,
  ) {
    const student = StudentExtraController.escapeXml(params.studentName);
    const course = StudentExtraController.escapeXml(params.courseTitle);
    const issued = StudentExtraController.escapeXml(params.issuedAt);
    const shortId = StudentExtraController.escapeXml(
      StudentExtraController.shortCertId(params.certificateId),
    );

    // If a custom template is provided, replace placeholders and return it
    if (templateSvg) {
      return templateSvg
        .replace(/\{\{studentName\}\}/g, student)
        .replace(/\{\{courseTitle\}\}/g, course)
        .replace(/\{\{issuedAt\}\}/g, issued)
        .replace(/\{\{certificateId\}\}/g, shortId);
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="850" viewBox="0 0 1200 850">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f2a6d"/>
      <stop offset="1" stop-color="#4f46e5"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1200" height="850" fill="#f8fafc"/>
  <rect x="40" y="40" width="1120" height="770" rx="28" fill="white" stroke="#e2e8f0" stroke-width="4"/>
  <rect x="40" y="40" width="1120" height="140" rx="28" fill="url(#g)"/>
  <text x="600" y="125" font-family="Inter, Arial" font-size="44" font-weight="700" text-anchor="middle" fill="white">Certificate of Achievement</text>

  <text x="600" y="260" font-family="Inter, Arial" font-size="22" text-anchor="middle" fill="#334155">This certifies that</text>
  <text x="600" y="340" font-family="Georgia, 'Times New Roman'" font-size="56" font-weight="700" text-anchor="middle" fill="#0f172a">${student}</text>
  <text x="600" y="410" font-family="Inter, Arial" font-size="20" text-anchor="middle" fill="#475569">has successfully completed</text>
  <text x="600" y="470" font-family="Inter, Arial" font-size="34" font-weight="700" text-anchor="middle" fill="#111827">${course}</text>

  <g>
    <circle cx="150" cy="670" r="54" fill="#fef3c7" stroke="#f59e0b" stroke-width="6"/>
    <path d="M150 630 L162 656 L190 659 L168 677 L175 705 L150 690 L125 705 L132 677 L110 659 L138 656 Z" fill="#f59e0b"/>
  </g>

  <text x="600" y="615" font-family="Inter, Arial" font-size="18" text-anchor="middle" fill="#475569">Issued: ${issued}</text>
  <text x="600" y="648" font-family="Inter, Arial" font-size="15" font-weight="600" text-anchor="middle" fill="#1e40af">Certificate ID: ${shortId}</text>
  <text x="600" y="675" font-family="Inter, Arial" font-size="12" text-anchor="middle" fill="#64748b">Verify at: yugminds.com/robocoders/lms/verify/${shortId}</text>

  <line x1="820" y1="710" x2="1080" y2="710" stroke="#cbd5e1" stroke-width="2"/>
  <text x="950" y="740" font-family="Inter, Arial" font-size="16" text-anchor="middle" fill="#334155">Yugminds</text>
</svg>`;
  }

  private static daysUntil(due: Date, now: Date) {
    const ms = due.getTime() - now.getTime();
    return Math.ceil(ms / (24 * 60 * 60 * 1000));
  }

  @Post('assignments/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    }),
  )
  async uploadAssignmentFile(
    @CurrentUser() user: { id: number },
    @UploadedFile()
    file?: {
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    },
  ) {
    if (!file) throw new BadRequestException('file is required');
    const mime = file.mimetype || 'application/octet-stream';
    const b64 = file.buffer.toString('base64');
    const dataUrl = `data:${mime};base64,${b64}`;
    // No external storage configured; store as data URL for now (consistent with other media in this repo)
    return {
      success: true,
      file: {
        uploaded_by: user.id,
        filename: file.originalname,
        mime_type: mime,
        size: file.size,
        fileUrl: dataUrl,
      },
    };
  }

  @Get('courses')
  async listCourses(@CurrentUser() user: { id: number }) {
    const enrollments = await this.db.studentCourse.findMany({
      where: { studentId: user.id },
    });
    if (enrollments.length === 0) {
      return { courses: [] };
    }
    const courseIds = enrollments.map((e) => e.courseId);
    const [courseList, chapters, contents, progress, studentSchool] =
      await Promise.all([
        this.db.course.findMany({
          where: { id: { in: courseIds } },
        }),
        this.db.chapter.findMany({
          where: { courseId: { in: courseIds } },
          select: { id: true, courseId: true },
        }),
        this.db.chapterContent.findMany({
          where: { chapter: { courseId: { in: courseIds } } },
          select: { id: true, chapterId: true },
        }),
        this.db.courseProgress.findMany({
          where: { studentId: user.id, courseId: { in: courseIds } },
        }),
        this.db.studentSchool.findFirst({
          where: { studentId: user.id, isActive: true },
          select: { grade: true },
        }),
      ]);

    const courseById = new Map(courseList.map((c) => [c.id, c]));
    const chaptersByCourse = new Map<
      string,
      Array<{ id: string; courseId: string }>
    >();
    for (const ch of chapters) {
      if (!chaptersByCourse.has(ch.courseId))
        chaptersByCourse.set(ch.courseId, []);
      chaptersByCourse.get(ch.courseId)!.push(ch);
    }

    // Assignments: count per course (via chapters)
    const chapterIds = chapters.map((c) => c.id);
    const assignmentCountsByChapter =
      chapterIds.length > 0
        ? await this.db.assignment.groupBy({
            by: ['chapterId'],
            where: { chapterId: { in: chapterIds } },
            _count: { _all: true },
          })
        : [];
    const assignmentsByCourse = new Map<string, number>();
    const chapterToCourse = new Map(chapters.map((c) => [c.id, c.courseId]));
    for (const row of assignmentCountsByChapter) {
      const courseId = row.chapterId
        ? chapterToCourse.get(row.chapterId)
        : undefined;
      if (!courseId) continue;
      assignmentsByCourse.set(
        courseId,
        (assignmentsByCourse.get(courseId) ?? 0) + row._count._all,
      );
    }

    // Submissions: compute completed assignments + average grade (graded submissions)
    const assignmentIds = chapterIds.length
      ? await this.db.assignment.findMany({
          where: { chapterId: { in: chapterIds } },
          select: { id: true, chapterId: true },
        })
      : [];
    const assignmentIdToCourseId = new Map<string, string>();
    assignmentIds.forEach((a) => {
      const c = a.chapterId ? chapterToCourse.get(a.chapterId) : undefined;
      if (c) assignmentIdToCourseId.set(a.id, c);
    });
    const submissions =
      assignmentIds.length > 0
        ? await this.db.assignmentSubmission.findMany({
            where: {
              studentId: user.id,
              assignmentId: { in: assignmentIds.map((a) => a.id) },
            },
            select: {
              assignmentId: true,
              status: true,
              score: true,
              maxScore: true,
            },
          })
        : [];
    const completedAssignmentsByCourse = new Map<string, number>();
    const gradeAggByCourse = new Map<
      string,
      { sumPct: number; count: number }
    >();
    for (const s of submissions) {
      const c = assignmentIdToCourseId.get(s.assignmentId);
      if (!c) continue;
      completedAssignmentsByCourse.set(
        c,
        (completedAssignmentsByCourse.get(c) ?? 0) + 1,
      );
      const ms =
        typeof s.maxScore === 'number' && s.maxScore > 0 ? s.maxScore : null;
      const sc = typeof s.score === 'number' ? s.score : null;
      if (ms && sc !== null && (s.status ?? '') === 'graded') {
        const pct = Math.max(0, Math.min(100, (sc / ms) * 100));
        const agg = gradeAggByCourse.get(c) ?? { sumPct: 0, count: 0 };
        agg.sumPct += pct;
        agg.count += 1;
        gradeAggByCourse.set(c, agg);
      }
    }

    // Progress: group per course
    const progressByCourse = new Map<string, typeof progress>();
    for (const p of progress) {
      if (!progressByCourse.has(p.courseId))
        progressByCourse.set(p.courseId, []);
      progressByCourse.get(p.courseId)!.push(p);
    }

    const grade = studentSchool?.grade ?? '';
    const courses = enrollments.map((e) => {
      const course = courseById.get(e.courseId);
      const courseChapters = chaptersByCourse.get(e.courseId) ?? [];
      const totalChapters = courseChapters.length;

      const courseProgress = progressByCourse.get(e.courseId) ?? [];

      // Get all content items for these chapters
      const courseChapterIds = courseChapters.map((ch) => ch.id);
      const courseContents = contents.filter((c) =>
        courseChapterIds.includes(c.chapterId),
      );
      const totalContentItems = courseContents.length;

      // Get completed content IDs and completed chapter IDs
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

      // Calculate actual completed count using hybrid logic
      let hybridCompletedCount = 0;
      courseContents.forEach((c) => {
        // Content is completed if its own record says so, OR if its parent chapter is marked completed (legacy fallback)
        // We also check progress >= 99 OR completedAt being non-null for maximum resilience
        const contentIsDone = completedContentIds.has(c.id);
        const chapterIsDone = completedChapterIds.has(c.chapterId);

        if (contentIsDone || chapterIsDone) {
          hybridCompletedCount++;
        }
      });

      // Calculate progress percentage based on actual contents in this course
      const progressPercentage =
        totalContentItems > 0
          ? Math.min(
              100,
              Math.round((hybridCompletedCount / totalContentItems) * 100),
            )
          : courseProgress.some((p) => p.progress >= 99)
            ? 100
            : 0;

      // A chapter is completed if all its contents are completed
      const chapterContentsMap = new Map<string, string[]>();
      courseContents.forEach((c) => {
        const list = chapterContentsMap.get(c.chapterId) || [];
        list.push(c.id);
        chapterContentsMap.set(c.chapterId, list);
      });

      let completedChapters = 0;
      courseChapters.forEach((ch) => {
        const chContents = chapterContentsMap.get(ch.id) || [];
        const chapterIsExplicitlyCompleted = completedChapterIds.has(ch.id);

        if (chContents.length > 0) {
          const allContentsDone = chContents.every((cid) =>
            completedContentIds.has(cid),
          );
          if (allContentsDone || chapterIsExplicitlyCompleted) {
            completedChapters++;
          }
        } else if (chapterIsExplicitlyCompleted) {
          // Fallback for empty chapters that are marked done
          completedChapters++;
        }
      });

      const last = courseProgress.reduce<Date | null>((latest, p) => {
        const ts = p.completedAt ?? p.updatedAt;
        return !latest || ts > latest ? ts : latest;
      }, null);

      const status: 'active' | 'completed' | 'not_started' =
        totalChapters > 0 && completedChapters >= totalChapters
          ? 'completed'
          : progressPercentage > 0
            ? 'active'
            : 'not_started';

      // Force 100% if status is completed for UI consistency
      const finalProgressPercentage =
        status === 'completed' ? 100 : progressPercentage;

      return {
        id: e.courseId,
        title: course?.title ?? '',
        name: course?.title ?? '',
        description: course?.description ?? null,
        thumbnail_url: course?.thumbnailUrl ?? null,
        enrolled_at: e.enrolledAt.toISOString(),
        grade,
        subject: '',
        total_chapters: totalChapters,
        completed_chapters: completedChapters,
        progress_percentage: finalProgressPercentage,
        last_accessed: (last ?? e.enrolledAt).toISOString(),
        total_assignments: assignmentsByCourse.get(e.courseId) ?? 0,
        completed_assignments:
          completedAssignmentsByCourse.get(e.courseId) ?? 0,
        average_grade: (() => {
          const agg = gradeAggByCourse.get(e.courseId);
          if (!agg || agg.count === 0) return null;
          return Number((agg.sumPct / agg.count).toFixed(2));
        })(),
        status,
      };
    });
    return { courses };
  }

  @Get('courses/:courseId/chapters')
  async listCourseChapters(
    @CurrentUser() user: { id: number },
    @Param('courseId') courseId: string,
  ) {
    const enrolled = await this.db.studentCourse.findUnique({
      where: {
        studentId_courseId: { studentId: user.id, courseId },
      },
    });
    if (!enrolled) {
      throw new NotFoundException('Not enrolled in this course');
    }

    const chapters = await this.db.chapter.findMany({
      where: { courseId },
      orderBy: { sortOrder: 'asc' },
    });

    const chapterIds = chapters.map((ch) => ch.id);

    const [contents, progress] = await Promise.all([
      this.db.chapterContent.findMany({
        where: { chapterId: { in: chapterIds } },
      }),
      this.db.courseProgress.findMany({
        where: { studentId: user.id, courseId },
      }),
    ]);

    // Group contents by chapterId
    const contentsByChapter = new Map<string, any[]>();
    contents.forEach((c) => {
      const list = contentsByChapter.get(c.chapterId) || [];
      list.push(c);
      contentsByChapter.set(c.chapterId, list);
    });

    // Group progress by chapterId and contentId
    const completedContentIds = new Set(
      progress
        .filter((p) => (p as any).contentId && p.progress >= 99)
        .map((p) => (p as any).contentId as string),
    );
    const completedChapterIds = new Set(
      progress
        .filter((p) => !(p as any).contentId && p.chapterId && p.progress >= 99)
        .map((p) => p.chapterId as string),
    );

    const resultChapters = chapters.map((ch, index) => {
      const chapterContents = contentsByChapter.get(ch.id) || [];
      const completedInChapter = chapterContents.filter((c) =>
        completedContentIds.has(c.id),
      ).length;

      // A chapter is completed if explicitly marked OR if all its contents are completed
      const isCompleted =
        completedChapterIds.has(ch.id) ||
        (chapterContents.length > 0 &&
          completedInChapter === chapterContents.length);

      // Hybrid logic for completed count: if chapter is marked done, count all lessons as done
      const displayCompletedCount = isCompleted
        ? chapterContents.length
        : completedInChapter;

      return {
        id: ch.id,
        course_id: courseId,
        title: ch.title,
        name: ch.title,
        sort_order: ch.sortOrder,
        order_number: index + 1,
        content_count: chapterContents.length,
        completed_count: displayCompletedCount,
        is_completed: isCompleted,
        // We'll calculate is_unlocked in a second pass to use the updated isCompleted
        _isCompleted: isCompleted,
      };
    });

    return {
      chapters: resultChapters.map((ch, index) => {
        // First chapter is always unlocked. Others are unlocked if the previous one is completed.
        const isUnlocked =
          index === 0 || resultChapters[index - 1]._isCompleted;

        return {
          ...ch,
          is_unlocked: isUnlocked,
          _isCompleted: undefined, // cleanup
        };
      }),
    };
  }

  @Get('courses/:courseId/chapters/:chapterId/contents')
  async getChapterContents(
    @CurrentUser() user: { id: number },
    @Param('courseId') courseId: string,
    @Param('chapterId') chapterId: string,
  ) {
    const enrolled = await this.db.studentCourse.findUnique({
      where: {
        studentId_courseId: { studentId: user.id, courseId },
      },
    });
    if (!enrolled) {
      throw new NotFoundException('Not enrolled in this course');
    }
    const chapter = await this.db.chapter.findFirst({
      where: { id: chapterId, courseId },
    });
    if (!chapter) {
      throw new NotFoundException('Chapter not found');
    }
    const [contents, progress] = await Promise.all([
      this.db.chapterContent.findMany({
        where: { chapterId },
        orderBy: { sortOrder: 'asc' },
      }),
      this.db.courseProgress.findMany({
        where: { studentId: user.id, courseId, chapterId },
      }),
    ]);

    const completedContentIds = new Set(
      progress
        .filter((p) => (p as any).contentId && p.progress >= 99)
        .map((p) => (p as any).contentId as string),
    );

    return {
      contents: contents.map((c) => ({
        id: c.id,
        content_id: c.id,
        chapter_id: chapterId,
        content_type: c.contentType,
        title: c.title,
        content_text: c.contentText,
        content_url: c.contentUrl,
        order_index: c.sortOrder,
        duration_minutes: c.durationMinutes,
        is_completed: completedContentIds.has(c.id),
      })),
    };
  }

  @Get('assignments')
  async listAssignments(
    @CurrentUser() user: { id: number },
    @Query('course_id') courseId?: string,
    @Query('type') type?: string,
  ) {
    // If type=DAILY, serve school-scoped daily assignments for the student's grade
    if (type && String(type).toUpperCase() === 'DAILY') {
      const studentSchool = await this.db.studentSchool.findFirst({
        where: { studentId: user.id, isActive: true },
        select: { schoolId: true, grade: true, section: true },
      });
      if (!studentSchool) return { assignments: [] };

      // Get the grade record for gradeId matching
      const gradeRecord = studentSchool.grade
        ? await this.db.grade.findFirst({
            where: {
              schoolId: studentSchool.schoolId,
              name: studentSchool.grade,
            },
            select: { id: true },
          })
        : null;

      // Get section record so we can match publishedSectionIds
      const sectionRecord =
        gradeRecord && studentSchool.section
          ? await this.db.section.findFirst({
              where: { gradeId: gradeRecord.id, name: studentSchool.section },
              select: { id: true },
            })
          : null;

      // Fetch all published daily assignments for this school first, then post-filter by publishScope
      const candidateAssignments = await this.db.assignment.findMany({
        where: {
          schoolId: studentSchool.schoolId,
          assignmentType: 'DAILY',
          isPublished: true,
        },
        include: { questions: true, grade: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      });

      // Post-filter by publishScope / publishedGradeIds / publishedSectionIds
      const dailyAssignments = candidateAssignments.filter((a) => {
        const scope = a.publishScope ?? 'grade';
        // Legacy single-gradeId targeting: assignment.gradeId must match student or be null (all grades)
        if (scope === 'grade') {
          if (a.publishedGradeIds && a.publishedGradeIds.length > 0) {
            return gradeRecord
              ? a.publishedGradeIds.includes(gradeRecord.id)
              : false;
          }
          // Fall back to legacy gradeId field
          return !a.gradeId || a.gradeId === gradeRecord?.id;
        }
        if (scope === 'section') {
          if (a.publishedSectionIds && a.publishedSectionIds.length > 0) {
            return sectionRecord
              ? a.publishedSectionIds.includes(sectionRecord.id)
              : false;
          }
          return false;
        }
        // selected_students scope: visible unless explicitly excluded; grant-based access handled at submit time
        return true;
      });
      const submissionRows = await this.db.assignmentSubmission.findMany({
        where: {
          studentId: user.id,
          assignmentId: { in: dailyAssignments.map((a) => a.id) },
        },
        orderBy: { attemptNumber: 'desc' },
        select: {
          id: true,
          assignmentId: true,
          status: true,
          score: true,
          maxScore: true,
          submittedAt: true,
          gradedAt: true,
          attemptNumber: true,
        },
      });
      const latestSubByAssignment = new Map<
        string,
        (typeof submissionRows)[0]
      >();
      for (const s of submissionRows) {
        if (!latestSubByAssignment.has(s.assignmentId))
          latestSubByAssignment.set(s.assignmentId, s);
      }
      const now = new Date();
      return {
        assignments: dailyAssignments.map((a) => {
          const sub = latestSubByAssignment.get(a.id) ?? null;
          const due = (a as any).dueDate as Date | null;
          const maxMarks =
            (a.questions ?? []).reduce(
              (sum: number, q: any) =>
                sum + (typeof q.marks === 'number' ? q.marks : 1),
              0,
            ) ||
            (a as any).totalMarks ||
            0;
          return {
            id: a.id,
            title: a.title,
            description: a.description,
            assignment_type: 'DAILY',
            subject: a.subject,
            grade_name: (a as any).grade?.name ?? studentSchool.grade,
            due_date: due ? due.toISOString() : null,
            max_marks: maxMarks,
            is_overdue: due ? due < now && !sub : false,
            days_until_due: due
              ? StudentExtraController.daysUntil(due, now)
              : 0,
            status: sub?.status ?? 'not_started',
            submission: sub
              ? {
                  id: sub.id,
                  grade:
                    sub.score !== null && sub.maxScore
                      ? Math.round((sub.score / sub.maxScore) * 100)
                      : null,
                  feedback: '',
                  submitted_at: sub.submittedAt.toISOString(),
                  status: sub.status,
                }
              : null,
          };
        }),
      };
    }

    const enrolled = courseId
      ? await this.db.studentCourse.findUnique({
          where: {
            studentId_courseId: { studentId: user.id, courseId },
          },
        })
      : null;
    const courseIds =
      courseId && enrolled
        ? [courseId]
        : (
            await this.db.studentCourse.findMany({
              where: { studentId: user.id },
              select: { courseId: true },
            })
          ).map((e) => e.courseId);
    if (courseIds.length === 0) {
      return { assignments: [] };
    }
    const chapters = await this.db.chapter.findMany({
      where: { courseId: { in: courseIds } },
      select: { id: true, courseId: true },
    });
    const chapterIds = chapters.map((c) => c.id);
    const courseIdByChapterId = new Map(
      chapters.map((c) => [c.id, c.courseId] as const),
    );
    const courses = await this.db.course.findMany({
      where: { id: { in: courseIds } },
    });
    const courseById = new Map(courses.map((c) => [c.id, c] as const));
    const assignments = await this.db.assignment.findMany({
      where: { chapterId: { in: chapterIds } },
      include: {
        chapter: { select: { courseId: true, title: true } },
        questions: true,
      },
      orderBy: { sortOrder: 'asc' },
    });
    const submissionRows = await this.db.assignmentSubmission.findMany({
      where: {
        studentId: user.id,
        assignmentId: { in: assignments.map((a) => a.id) },
      },
      select: {
        id: true,
        assignmentId: true,
        status: true,
        score: true,
        maxScore: true,
        submittedAt: true,
        gradedAt: true,
      },
    });
    const submissionByAssignmentId = new Map(
      submissionRows.map((s) => [s.assignmentId, s] as const),
    );
    return {
      assignments: assignments.map((a) => ({
        id: a.id,
        chapter_id: a.chapterId,
        course_id: a.chapter?.courseId ?? '',
        title: a.title,
        description: a.description,
        course_title: (() => {
          const cid =
            a.chapter?.courseId ??
            (a.chapterId ? courseIdByChapterId.get(a.chapterId) : undefined) ??
            '';
          const c = courseById.get(cid);
          return c?.title ?? '';
        })(),
        assignment_type: (() => {
          const qTypes = new Set(
            (a.questions ?? []).map((q) =>
              String(q.questionType ?? '').toLowerCase(),
            ),
          );
          if (qTypes.has('mcq')) return 'mcq';
          if (qTypes.has('fillblank')) return 'quiz';
          return 'essay';
        })(),
        due_date: (a as { dueDate?: Date | null }).dueDate
          ? (a as { dueDate?: Date }).dueDate!.toISOString()
          : null,
        max_marks: (a.questions ?? []).reduce(
          (sum, q) => sum + (typeof q.marks === 'number' ? q.marks : 1),
          0,
        ),
        status: submissionByAssignmentId.get(a.id)?.status ?? 'not_started',
        is_overdue: (() => {
          const due = (a as { dueDate?: Date | null }).dueDate;
          if (!due) return false;
          return (
            due.getTime() < Date.now() &&
            (submissionByAssignmentId.get(a.id)?.status ?? 'not_started') ===
              'not_started'
          );
        })(),
        days_until_due: (() => {
          const due = (a as { dueDate?: Date | null }).dueDate;
          if (!due) return 0;
          return StudentExtraController.daysUntil(due, new Date());
        })(),
        submission: (() => {
          const s = submissionByAssignmentId.get(a.id);
          if (!s) return null;
          const pct =
            typeof s.score === 'number' &&
            typeof s.maxScore === 'number' &&
            s.maxScore > 0
              ? Math.round((s.score / s.maxScore) * 100)
              : null;
          return {
            id: s.id,
            grade: pct,
            feedback: '',
            submitted_at: s.submittedAt.toISOString(),
            status: s.status,
          };
        })(),
      })),
    };
  }

  @Get('assignments/hierarchy')
  async getAssignmentsHierarchy(
    @CurrentUser() user: { id: number },
    @Query() query: AssignmentsHierarchyQueryDto,
  ) {
    const enrolledCourses = await this.db.studentCourse.findMany({
      where: {
        studentId: user.id,
        ...(query.course_id ? { courseId: query.course_id } : {}),
      },
      select: { courseId: true },
    });
    const courseIds = enrolledCourses.map((c) => c.courseId);
    if (courseIds.length === 0) return { hierarchy: [] };

    const [courses, chapters, assignments] = await Promise.all([
      this.db.course.findMany({
        where: { id: { in: courseIds } },
        select: { id: true, title: true },
      }),
      this.db.chapter.findMany({
        where: { courseId: { in: courseIds } },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, courseId: true, title: true, sortOrder: true },
      }),
      this.db.assignment.findMany({
        where: { chapter: { courseId: { in: courseIds } } },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, chapterId: true, title: true, sortOrder: true },
      }),
    ]);

    const assignmentsByChapter = new Map<
      string,
      Array<{ id: string; title: string; sort_order: number }>
    >();
    for (const a of assignments) {
      if (!a.chapterId) continue;
      if (!assignmentsByChapter.has(a.chapterId))
        assignmentsByChapter.set(a.chapterId, []);
      assignmentsByChapter.get(a.chapterId)!.push({
        id: a.id,
        title: a.title,
        sort_order: a.sortOrder,
      });
    }

    const chaptersByCourse = new Map<
      string,
      Array<{
        id: string;
        title: string;
        sort_order: number;
        assignments: Array<{ id: string; title: string; sort_order: number }>;
      }>
    >();
    for (const ch of chapters) {
      if (!chaptersByCourse.has(ch.courseId))
        chaptersByCourse.set(ch.courseId, []);
      chaptersByCourse.get(ch.courseId)!.push({
        id: ch.id,
        title: ch.title,
        sort_order: ch.sortOrder,
        assignments: assignmentsByChapter.get(ch.id) ?? [],
      });
    }

    return {
      hierarchy: courses.map((c) => ({
        course_id: c.id,
        course_title: c.title,
        chapters: chaptersByCourse.get(c.id) ?? [],
      })),
    };
  }

  @Get('assignments/:assignmentId')
  async getAssignment(
    @CurrentUser() user: { id: number },
    @Param('assignmentId') assignmentId: string,
  ) {
    const assignment = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      include: {
        chapter: { select: { courseId: true } },
        questions: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!assignment) {
      throw new NotFoundException('Assignment not found');
    }

    // DAILY assignments are school-scoped — verify school membership, not course enrollment
    if (assignment.assignmentType === 'DAILY') {
      if (assignment.schoolId) {
        const schoolMember = await this.db.studentSchool.findFirst({
          where: {
            studentId: user.id,
            schoolId: assignment.schoolId,
            isActive: true,
          },
        });
        if (!schoolMember) throw new NotFoundException('Assignment not found');
      }
    } else {
      const courseId = assignment.chapter?.courseId ?? assignment.courseId;
      if (!courseId) throw new NotFoundException('Assignment not found');
      const enrolled = await this.db.studentCourse.findUnique({
        where: { studentId_courseId: { studentId: user.id, courseId } },
      });
      if (!enrolled) throw new NotFoundException('Not enrolled in this course');
    }
    const attempts = await this.db.assignmentSubmission.findMany({
      where: { assignmentId, studentId: user.id },
      orderBy: [{ attemptNumber: 'asc' }, { submittedAt: 'asc' }],
      select: {
        id: true,
        attemptNumber: true,
        status: true,
        answers: true,
        fileUrl: true,
        textContent: true,
        feedback: true,
        score: true,
        maxScore: true,
        submittedAt: true,
        gradedAt: true,
      },
    });
    const latestAttempt = attempts[attempts.length - 1] ?? null;
    const retakeGrant = await this.db.retakeGrant.findUnique({
      where: { assignmentId_studentId: { assignmentId, studentId: user.id } },
      select: { isActive: true },
    });
    const maxMarks = assignment.questions.reduce(
      (sum, q) =>
        sum +
        (typeof q.marks === 'number' && !Number.isNaN(q.marks) ? q.marks : 1),
      0,
    );
    const qTypes = new Set(
      assignment.questions.map((q) =>
        String(q.questionType ?? '').toLowerCase(),
      ),
    );
    const assignmentType = qTypes.has('mcq')
      ? 'mcq'
      : qTypes.has('fillblank')
        ? 'quiz'
        : 'essay';

    // Fetch course for title (chapter may be null for DAILY assignments)
    const resolvedCourseId =
      assignment.chapter?.courseId ?? assignment.courseId ?? null;
    const course = resolvedCourseId
      ? await this.db.course.findUnique({
          where: { id: resolvedCourseId },
          select: { title: true },
        })
      : null;

    return {
      assignment: {
        id: assignment.id,
        chapter_id: assignment.chapterId,
        course_id: resolvedCourseId,
        course_title: course?.title ?? '',
        title: assignment.title,
        description: assignment.description,
        assignment_type: assignmentType,
        due_date:
          (assignment as { dueDate?: Date | null }).dueDate?.toISOString() ??
          null,
        max_marks: maxMarks,
        max_attempts: assignment.maxRetakeAttempts ?? 1,
        retake_enabled: assignment.retakeEnabled,
        retake_scoring_rule: assignment.retakeScoringRule ?? 'latest',
        retake_window_open: assignment.retakeWindowOpen ?? false,
        retake_access_scope: assignment.retakeAccessScope ?? 'all',
        questions: assignment.questions.map((q) => ({
          id: q.id,
          question_type: q.questionType,
          question_text: q.questionText,
          options: Array.isArray(q.options)
            ? (q.options as string[])
            : undefined,
          marks: q.marks,
          // Only show correct answer if graded
          correct_answer:
            latestAttempt && latestAttempt.status === 'graded'
              ? q.correctAnswer
              : undefined,
        })),
      },
      submission: latestAttempt
        ? {
            id: latestAttempt.id,
            attempt_number: latestAttempt.attemptNumber,
            status: latestAttempt.status,
            answers: latestAttempt.answers,
            text_content: latestAttempt.textContent ?? null,
            file_url: latestAttempt.fileUrl ?? null,
            feedback: latestAttempt.feedback ?? null,
            score: latestAttempt.score,
            max_score: latestAttempt.maxScore,
            grade:
              latestAttempt.score !== null && latestAttempt.maxScore
                ? Math.round(
                    (latestAttempt.score / latestAttempt.maxScore) * 100,
                  )
                : null,
            submitted_at: latestAttempt.submittedAt.toISOString(),
            graded_at: latestAttempt.gradedAt?.toISOString() ?? null,
          }
        : null,
      attempts: attempts.map((a) => ({
        id: a.id,
        attempt_number: a.attemptNumber,
        status: a.status,
        score: a.score,
        max_score: a.maxScore,
        grade:
          a.score !== null && a.maxScore
            ? Math.round((a.score / a.maxScore) * 100)
            : null,
        submitted_at: a.submittedAt.toISOString(),
        graded_at: a.gradedAt?.toISOString() ?? null,
      })),
      retake: {
        enabled: assignment.retakeEnabled ?? false,
        window_open: assignment.retakeWindowOpen ?? false,
        max_attempts: assignment.maxRetakeAttempts,
        current_attempts: attempts.length,
        granted: !!retakeGrant?.isActive,
        allowed:
          (assignment.retakeEnabled &&
            (assignment.retakeWindowOpen || !!retakeGrant?.isActive)) ||
          attempts.length === 0,
      },
    };
  }

  @Post('assignments/:assignmentId/submit')
  async submitAssignment(
    @CurrentUser() user: { id: number },
    @Param('assignmentId') assignmentId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const assignment = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      include: {
        chapter: { select: { courseId: true } },
        questions: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!assignment) {
      throw new NotFoundException('Assignment not found');
    }

    // DAILY assignments: verify school membership. COURSE assignments: verify enrollment.
    if (assignment.assignmentType === 'DAILY') {
      if (assignment.schoolId) {
        const schoolMember = await this.db.studentSchool.findFirst({
          where: {
            studentId: user.id,
            schoolId: assignment.schoolId,
            isActive: true,
          },
        });
        if (!schoolMember) throw new NotFoundException('Assignment not found');
      }
    } else {
      const courseId = assignment.chapter?.courseId ?? assignment.courseId;
      if (!courseId) throw new NotFoundException('Assignment not found');
      const enrolled = await this.db.studentCourse.findUnique({
        where: { studentId_courseId: { studentId: user.id, courseId } },
      });
      if (!enrolled) throw new NotFoundException('Not enrolled in this course');
    }

    const existingAttempts = await this.db.assignmentSubmission.findMany({
      where: { assignmentId, studentId: user.id },
      orderBy: { attemptNumber: 'asc' },
      select: {
        attemptNumber: true,
        score: true,
        maxScore: true,
        submittedAt: true,
      },
    });
    const nextAttemptNumber =
      (existingAttempts[existingAttempts.length - 1]?.attemptNumber ?? 0) + 1;
    const retakeFeatureEnabled =
      process.env.ASSIGNMENT_RETAKE_FEATURE_ENABLED !== 'false';
    const hasAttempted = existingAttempts.length > 0;
    const hasRetakeCapacity =
      assignment.maxRetakeAttempts == null ||
      existingAttempts.length < assignment.maxRetakeAttempts + 1;
    const activeRetakeGrant = await this.db.retakeGrant.findUnique({
      where: { assignmentId_studentId: { assignmentId, studentId: user.id } },
      select: { isActive: true },
    });
    const retakeAllowedByScope =
      (assignment.retakeAccessScope ?? 'all') === 'all' ||
      !!activeRetakeGrant?.isActive;
    const retakeAllowedByWindow =
      !!assignment.retakeWindowOpen || !!activeRetakeGrant?.isActive;
    const canRetake =
      !!assignment.retakeEnabled &&
      hasRetakeCapacity &&
      retakeAllowedByScope &&
      retakeAllowedByWindow;
    if (retakeFeatureEnabled && hasAttempted && !canRetake) {
      throw new BadRequestException(
        'Retake is not available for this assignment',
      );
    }

    const answers = (body?.answers ?? body) as unknown;
    const safeAnswers = answers && typeof answers === 'object' ? answers : null;
    const fileUrl =
      typeof body?.fileUrl === 'string' ? String(body.fileUrl) : undefined;
    const textContent =
      typeof body?.textContent === 'string'
        ? String(body.textContent)
        : undefined;

    const answerMap = safeAnswers as Record<string, unknown> | null;
    let maxScore = 0;
    let score = 0;
    const norm = (s: unknown) =>
      String(s ?? '')
        .toLowerCase()
        .trim();

    for (const q of assignment.questions) {
      const marks =
        typeof q.marks === 'number' && !Number.isNaN(q.marks) ? q.marks : 1;
      maxScore += marks;
      const expected = q.correctAnswer;
      if (!expected) continue;

      const givenRaw = answerMap ? answerMap[String(q.id)] : undefined;
      const qType = (q.questionType ?? '').toLowerCase();
      const isMCQ = qType === 'mcq' || qType === 'multiple_choice';
      const isFillBlank =
        qType === 'fillblank' ||
        qType === 'fill_blank' ||
        qType === 'fill-blank';
      const isEssay = qType === 'essay';

      // Essay is manually graded — never auto-scored
      if (isEssay) continue;

      let isCorrect = false;

      if (isFillBlank) {
        // Student answer comes in as string[] (one entry per blank).
        // Fall back to a single-entry array for legacy string payloads.
        const givenArr: string[] = Array.isArray(givenRaw)
          ? givenRaw.map((v) => norm(v))
          : typeof givenRaw === 'string' && givenRaw.trim().length > 0
            ? [norm(givenRaw)]
            : [];

        if (givenArr.length === 0 || givenArr.every((s) => s.length === 0)) {
          continue;
        }

        // Correct answer is stored as a single string; teachers may separate
        // multiple blanks with "," or ";".
        const correctArr = expected
          .split(/[,;]/)
          .map((s) => norm(s))
          .filter((s) => s.length > 0);

        if (correctArr.length === 0) continue;

        if (correctArr.length === givenArr.length) {
          // Positional match (one correct value per blank).
          isCorrect = correctArr.every((c, idx) => c === givenArr[idx]);
        } else if (correctArr.length === 1) {
          // Single accepted answer — every blank must match it.
          isCorrect = givenArr.every((g) => g === correctArr[0]);
        }
      } else if (isMCQ) {
        // Student answer is the option index (number) — coerce to string for parsing.
        const given =
          typeof givenRaw === 'string'
            ? givenRaw.trim()
            : typeof givenRaw === 'number'
              ? String(givenRaw)
              : '';
        if (given === '') continue;

        const options = Array.isArray(q.options) ? (q.options as string[]) : [];
        const givenIndex = parseInt(given, 10);
        const expectedIndex = parseInt(expected, 10);
        const expectedIsIndex =
          !Number.isNaN(expectedIndex) &&
          expectedIndex >= 0 &&
          expectedIndex < options.length;

        if (
          !Number.isNaN(givenIndex) &&
          givenIndex >= 0 &&
          givenIndex < options.length
        ) {
          if (expectedIsIndex) {
            isCorrect = givenIndex === expectedIndex;
          } else {
            // expected is the option text
            isCorrect = norm(options[givenIndex]) === norm(expected);
          }
        } else {
          // Legacy: student stored the option text directly
          const expectedText = expectedIsIndex
            ? norm(options[expectedIndex])
            : norm(expected);
          isCorrect = norm(given) === expectedText;
        }
      } else {
        // Unknown type — fall back to exact (normalized) string comparison.
        const given =
          typeof givenRaw === 'string'
            ? givenRaw.trim()
            : typeof givenRaw === 'number'
              ? String(givenRaw)
              : '';
        if (given === '') continue;
        isCorrect = norm(given) === norm(expected);
      }

      if (isCorrect) {
        score += marks;
      }
    }

    const canAutoGrade =
      maxScore > 0 && assignment.questions.some((q) => !!q.correctAnswer);
    const status = canAutoGrade ? 'graded' : 'submitted';

    const submission = await this.db.assignmentSubmission.create({
      data: {
        assignmentId,
        studentId: user.id,
        attemptNumber: nextAttemptNumber,
        answers: safeAnswers as never,
        fileUrl: fileUrl ?? null,
        textContent: textContent?.trim() ? textContent.trim() : null,
        status,
        score: canAutoGrade ? score : null,
        maxScore: canAutoGrade ? maxScore : null,
        gradedAt: canAutoGrade ? new Date() : null,
        isRetake: hasAttempted,
      },
    });

    await this.recomputeStudentScores(
      user.id,
      assignment.courseId ?? assignment.chapter?.courseId,
    );

    // When auto-graded, also update the school-wide StudentScoreSummary so ranks stay current
    if (canAutoGrade) {
      const studentEnrollment = await this.db.studentSchool.findFirst({
        where: { studentId: user.id, isActive: true },
        select: { schoolId: true },
      });
      if (studentEnrollment?.schoolId) {
        // Run asynchronously — don't block the response
        void this.ranking
          .recomputeStudentScoreSummary(studentEnrollment.schoolId)
          .catch(() => {});
      }
    }

    if (
      activeRetakeGrant?.isActive &&
      assignment.retakeAccessScope === 'selected'
    ) {
      await this.db.retakeGrant.update({
        where: { assignmentId_studentId: { assignmentId, studentId: user.id } },
        data: { isActive: false },
      });
    }
    return {
      success: true,
      message: 'Submission recorded',
      assignment_id: assignmentId,
      attempt_number: submission.attemptNumber,
      submitted_at: submission.submittedAt.toISOString(),
      status: submission.status === 'graded' ? 'graded' : 'submitted',
      score: submission.score,
      max_score: submission.maxScore,
    };
  }

  @Post('certificates/generate')
  async generateCertificate(
    @CurrentUser() user: { id: number },
    @Body() body: Record<string, unknown>,
  ) {
    const courseId = String(body?.courseId ?? '').trim();
    if (!courseId) throw new BadRequestException('courseId is required');

    const enrolled = await this.db.studentCourse.findUnique({
      where: { studentId_courseId: { studentId: user.id, courseId } },
    });
    if (!enrolled) throw new BadRequestException('Not enrolled in this course');

    const [course, chapters, contents, progress, profile] = await Promise.all([
      this.db.course.findUnique({ where: { id: courseId } }),
      this.db.chapter.findMany({ where: { courseId }, select: { id: true } }),
      this.db.chapterContent.findMany({
        where: { chapter: { courseId } },
        select: { id: true, chapterId: true },
      }),
      this.db.courseProgress.findMany({
        where: { studentId: user.id, courseId },
      }),
      this.db.profile.findUnique({ where: { userId: user.id } }),
    ]);
    if (!course) throw new BadRequestException('Course not found');

    const totalContentItems = contents.length;

    // Use the same hybrid logic as the courses list:
    // Content is complete if its own record says so OR if its parent chapter is marked complete.
    const completedContentIds = new Set(
      progress
        .filter(
          (p) => (p as any).contentId && (p.progress >= 99 || p.completedAt),
        )
        .map((p) => (p as any).contentId as string),
    );
    const completedChapterIds = new Set(
      progress
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

    let hybridCompletedCount = 0;
    contents.forEach((c) => {
      if (
        completedContentIds.has(c.id) ||
        completedChapterIds.has(c.chapterId)
      ) {
        hybridCompletedCount++;
      }
    });

    // Also honour explicit chapter completion: if all chapters are done, treat as 100%
    const allChaptersDone =
      chapters.length > 0 &&
      chapters.every((ch) => completedChapterIds.has(ch.id));

    const overallProgressPercent = allChaptersDone
      ? 100
      : totalContentItems > 0
        ? Math.min(
            100,
            Math.round((hybridCompletedCount / totalContentItems) * 100),
          )
        : progress.some((p) => p.progress >= 99 || p.completedAt)
          ? 100
          : 0;

    const eligible = overallProgressPercent >= 80;
    if (!eligible) {
      throw new BadRequestException(
        'Course not eligible for certificate (requires 80%+ completion).',
      );
    }

    const existing = await this.db.studentCertificate.findUnique({
      where: { studentId_courseId: { studentId: user.id, courseId } },
    });
    if (existing) {
      return {
        success: true,
        certificate: {
          id: existing.id,
          certificate_url: existing.certificateUrl,
        },
      };
    }

    const studentName = profile?.fullName ?? '';
    const issuedAt = new Date().toISOString().split('T')[0];
    const certificateName = `${course.title} Certificate`;

    // Load custom template if one has been uploaded
    const templateSetting = await this.db.systemSetting.findUnique({
      where: { key: 'certificate:template' },
    });

    // Create first to get an ID we can embed
    const created = await this.db.studentCertificate.create({
      data: {
        studentId: user.id,
        courseId,
        certificateName,
        certificateUrl: 'pending',
        issuedBy: null,
      },
    });
    const svg = StudentExtraController.buildCertificateSvg(
      {
        studentName: studentName || 'Student',
        courseTitle: course.title,
        issuedAt,
        certificateId: created.id,
      },
      templateSetting?.value ?? null,
    );
    const dataUrl = await StudentExtraController.svgToJpeg(svg);
    const updated = await this.db.studentCertificate.update({
      where: { id: created.id },
      data: { certificateUrl: dataUrl },
    });
    return {
      success: true,
      certificate: {
        id: updated.id,
        short_id: StudentExtraController.shortCertId(updated.id),
        certificate_url: updated.certificateUrl,
      },
    };
  }

  private async fetchProgress(userId: number, courseId?: string) {
    const where: { studentId: number; courseId?: string } = {
      studentId: userId,
    };
    if (courseId) where.courseId = courseId;
    const progress = await this.db.courseProgress.findMany({
      where,
    });
    const summary = progress.reduce(
      (acc, p) => {
        acc.total_progress += p.progress;
        acc.count += 1;
        return acc;
      },
      { total_progress: 0, count: 0 },
    );
    return {
      progress: progress.map((p) => ({
        course_id: p.courseId,
        chapter_id: p.chapterId,
        progress: p.progress,
        completed_at: p.completedAt?.toISOString(),
        updated_at: p.updatedAt.toISOString(),
      })),
      average_progress:
        summary.count > 0
          ? Number((summary.total_progress / summary.count).toFixed(2))
          : 0,
    };
  }

  @Get('progress')
  async getProgress(
    @CurrentUser() user: { id: number },
    @Query('course_id') courseId?: string,
  ) {
    return this.fetchProgress(user.id, courseId);
  }

  @Get('simple-progress')
  async getSimpleProgress(
    @CurrentUser() user: { id: number },
    @Query('course_id') courseIdFromSnake?: string,
    @Query('courseId') courseIdFromCamel?: string,
    @Query('chapter_id') chapterIdFromSnake?: string,
    @Query('chapterId') chapterIdFromCamel?: string,
  ) {
    const courseId = courseIdFromSnake ?? courseIdFromCamel;
    const chapterId = chapterIdFromSnake ?? chapterIdFromCamel;

    const res = await this.fetchProgress(user.id, courseId);
    if (!chapterId) return res;

    return {
      ...res,
      progress: res.progress.filter((p) => p.chapter_id === chapterId),
    };
  }

  @Post('simple-progress')
  async saveSimpleProgress(
    @CurrentUser() user: { id: number },
    @Body() dto: SimpleProgressDto,
  ) {
    const courseId = dto.courseId;
    const chapterId = dto.chapterId;
    const contentId = dto.contentId;
    const value = dto.isCompleted ? 100 : 0;

    const enrolled = await this.db.studentCourse.findUnique({
      where: {
        studentId_courseId: { studentId: user.id, courseId },
      },
    });
    if (!enrolled) {
      throw new NotFoundException('Not enrolled in this course');
    }

    const existing = await (this.db.courseProgress as any).findFirst({
      where: {
        studentId: user.id,
        courseId,
        chapterId: chapterId ?? null,
        contentId: contentId ?? null,
      },
    });

    if (existing) {
      await this.db.courseProgress.update({
        where: { id: existing.id },
        data: {
          progress: value,
          updatedAt: new Date(),
          completedAt: value >= 99 ? new Date() : null,
        },
      });
    } else {
      await (this.db.courseProgress as any).create({
        data: {
          studentId: user.id,
          courseId,
          chapterId: chapterId ?? null,
          contentId: contentId ?? null,
          progress: value,
          completedAt: value >= 99 ? new Date() : null,
        },
      });
    }

    return { success: true, progress: value };
  }

  @Post('save-chapter-progress')
  async saveChapterProgress(
    @CurrentUser() user: { id: number },
    @Body() body: Record<string, unknown>,
  ) {
    const courseId = (body.courseId ?? body.course_id) as string;
    const chapterId = (body.chapterId ?? body.chapter_id) as string | undefined;
    const progressValue =
      body.progress !== undefined
        ? Number(body.progress)
        : body.completed
          ? 100
          : 0;

    if (!courseId) {
      throw new BadRequestException('courseId required');
    }
    const enrolled = await this.db.studentCourse.findUnique({
      where: {
        studentId_courseId: { studentId: user.id, courseId },
      },
    });
    if (!enrolled) {
      throw new NotFoundException('Not enrolled in this course');
    }
    const value = Math.min(100, Math.max(0, progressValue));
    const existing = await this.db.courseProgress.findFirst({
      where: {
        studentId: user.id,
        courseId,
        chapterId: chapterId ?? null,
      },
    });
    if (existing) {
      await this.db.courseProgress.update({
        where: { id: existing.id },
        data: {
          progress: value,
          updatedAt: new Date(),
          completedAt: value >= 99 ? new Date() : null,
        },
      });
    } else {
      await this.db.courseProgress.create({
        data: {
          studentId: user.id,
          courseId,
          chapterId: chapterId ?? null,
          progress: value,
          completedAt: value >= 99 ? new Date() : null,
        },
      });
    }
    return { success: true, progress: value };
  }

  @Get('analytics')
  async getAnalytics(@CurrentUser() user: { id: number }) {
    // Get student's school enrollment
    const enrollment = await this.db.studentSchool.findFirst({
      where: { studentId: user.id, isActive: true },
      select: { schoolId: true, grade: true, section: true },
    });
    const schoolId = enrollment?.schoolId ?? null;

    // Get accessible assignment IDs (school + course library)
    const [schoolAssignments, courseAccess] = schoolId
      ? await Promise.all([
          this.db.assignment.findMany({
            where: { schoolId, isPublished: true },
            select: {
              id: true,
              assignmentType: true,
              title: true,
              subject: true,
              retakeScoringRule: true,
            },
          }),
          this.db.courseAccess.findMany({
            where: { schoolId },
            select: { courseId: true },
          }),
        ])
      : [[], []];

    const accessibleCourseIds = [
      ...new Set(
        (courseAccess as { courseId: string }[]).map((c) => c.courseId),
      ),
    ];
    const courseAssignmentsFromLibrary = accessibleCourseIds.length
      ? await this.db.assignment.findMany({
          where: {
            assignmentType: 'COURSE',
            isPublished: true,
            OR: [
              { courseId: { in: accessibleCourseIds } },
              { chapter: { courseId: { in: accessibleCourseIds } } },
            ],
          },
          select: {
            id: true,
            assignmentType: true,
            title: true,
            subject: true,
            retakeScoringRule: true,
          },
        })
      : [];

    const allAssignmentsMap = new Map(
      (
        schoolAssignments as {
          id: string;
          assignmentType: string;
          title: string;
          subject: string | null;
        }[]
      ).map((a) => [a.id, a]),
    );
    for (const a of courseAssignmentsFromLibrary) {
      if (!allAssignmentsMap.has(a.id))
        allAssignmentsMap.set(
          a.id,
          a as {
            id: string;
            assignmentType: string;
            title: string;
            subject: string | null;
          },
        );
    }
    const allAssignments = [...allAssignmentsMap.values()];
    const allAssignmentIds = allAssignments.map((a) => a.id);

    // Get own submissions
    const ownSubmissions = allAssignmentIds.length
      ? await this.db.assignmentSubmission.findMany({
          where: { studentId: user.id, assignmentId: { in: allAssignmentIds } },
          select: {
            assignmentId: true,
            score: true,
            maxScore: true,
            attemptNumber: true,
            status: true,
            submittedAt: true,
            feedback: true,
          },
          orderBy: [{ assignmentId: 'asc' }, { attemptNumber: 'asc' }],
        })
      : [];

    // Canonical deduplication: graded-only, respect retakeScoringRule per assignment
    const asgnRuleMap = new Map(
      allAssignments.map((a) => [
        a.id,
        String((a as any).retakeScoringRule ?? 'latest').toLowerCase(),
      ]),
    );
    const bestByKey = new Map<string, (typeof ownSubmissions)[0]>();
    for (const s of ownSubmissions) {
      if (s.status !== 'graded') continue;
      const rule = asgnRuleMap.get(s.assignmentId) ?? 'latest';
      const existing = bestByKey.get(s.assignmentId);
      if (!existing) {
        bestByKey.set(s.assignmentId, s);
      } else if (
        rule === 'highest' &&
        Number(s.score ?? 0) > Number(existing.score ?? 0)
      ) {
        bestByKey.set(s.assignmentId, s);
      } else if (rule !== 'highest') {
        // latest: ascending order means last write wins
        bestByKey.set(s.assignmentId, s);
      }
    }
    const bestSubs = [...bestByKey.values()];

    // Personal score summary
    let courseScore = 0,
      courseMax = 0,
      dailyScore = 0,
      dailyMax = 0;
    const subjectMap = new Map<string, { total: number; max: number }>();
    for (const s of bestSubs) {
      const asgn = allAssignments.find((a) => a.id === s.assignmentId);
      const isCourse = asgn?.assignmentType === 'COURSE';
      const score = Number(s.score ?? 0);
      const max = Number(s.maxScore ?? 0);
      if (isCourse) {
        courseScore += score;
        courseMax += max;
      } else {
        dailyScore += score;
        dailyMax += max;
      }
      const subj = asgn?.subject ?? 'General';
      const sm = subjectMap.get(subj) ?? { total: 0, max: 0 };
      sm.total += score;
      sm.max += max;
      subjectMap.set(subj, sm);
    }
    const coursePercent =
      courseMax > 0 ? Number(((courseScore / courseMax) * 100).toFixed(2)) : 0;
    const dailyPercent =
      dailyMax > 0 ? Number(((dailyScore / dailyMax) * 100).toFixed(2)) : 0;
    const overallScore = Number(
      (coursePercent * 0.6 + dailyPercent * 0.4).toFixed(2),
    );

    // Score history (last 20 submissions chronologically)
    const scoreHistory = [...ownSubmissions]
      .filter((s) => s.status === 'graded')
      .sort(
        (a, b) =>
          new Date(a.submittedAt ?? 0).getTime() -
          new Date(b.submittedAt ?? 0).getTime(),
      )
      .slice(-20)
      .map((s) => ({
        assignment_id: s.assignmentId,
        title: allAssignments.find((a) => a.id === s.assignmentId)?.title ?? '',
        score: Number(s.score ?? 0),
        max_score: Number(s.maxScore ?? 0),
        percentage:
          Number(s.maxScore ?? 0) > 0
            ? Number(
                (
                  (Number(s.score ?? 0) / Number(s.maxScore ?? 0)) *
                  100
                ).toFixed(2),
              )
            : 0,
        attempt: s.attemptNumber,
        submitted_at: s.submittedAt,
        feedback: s.feedback ?? null,
      }));

    // Subject breakdown
    const subject_breakdown = [...subjectMap.entries()]
      .map(([subject, s]) => ({
        subject,
        avg_score: s.max > 0 ? Number(((s.total / s.max) * 100).toFixed(2)) : 0,
        submissions: bestSubs.filter(
          (sub) =>
            (allAssignments.find((a) => a.id === sub.assignmentId)?.subject ??
              'General') === subject,
        ).length,
      }))
      .sort((a, b) => b.avg_score - a.avg_score);

    // School leaderboard (read-only, show own rank highlighted)
    let school_leaderboard: Array<{
      rank: number;
      student_id: number;
      student_name: string;
      overall_score: number;
      is_self: boolean;
    }> = [];
    if (schoolId) {
      const schoolStudents = await this.db.studentSchool.findMany({
        where: { schoolId, isActive: true },
        include: { student: { include: { profile: true } } },
      });
      const summaries = await this.db.studentScoreSummary.findMany({
        where: { studentId: { in: schoolStudents.map((e) => e.studentId) } },
        select: { studentId: true, overallScore: true },
      });
      const scoreByStudent = new Map(
        summaries.map((s) => [s.studentId, Number(s.overallScore ?? 0)]),
      );
      school_leaderboard = schoolStudents
        .map((e) => ({
          rank: 0,
          student_id: e.studentId,
          student_name:
            e.student.profile?.fullName ??
            e.student.email ??
            `Student ${e.studentId}`,
          overall_score: scoreByStudent.get(e.studentId) ?? 0,
          is_self: e.studentId === user.id,
        }))
        .sort((a, b) => b.overall_score - a.overall_score)
        .map((r, idx) => ({ ...r, rank: idx + 1 }));
    }

    const computeBadge = (score: number) => {
      if (score >= 90) return 'GOLD';
      if (score >= 75) return 'SILVER';
      if (score >= 60) return 'BRONZE';
      return 'NONE';
    };

    return {
      summary: {
        course_assignment_score: coursePercent,
        daily_assignment_score: dailyPercent,
        overall_score: overallScore,
        assignments_attempted: bestSubs.length,
        graded_count: bestSubs.filter((s) => s.status === 'graded').length,
        badge: computeBadge(overallScore),
        grade: enrollment?.grade ?? '',
        section: enrollment?.section ?? '',
      },
      subject_breakdown,
      score_history: scoreHistory,
      school_leaderboard,
    };
  }
}
