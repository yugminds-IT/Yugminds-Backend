import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
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
import { computeCourseProgress } from '../../common/utils/course-progress.util';
import { StudentRankingService } from '../../common/assignment/student-ranking.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { AssignmentsHierarchyQueryDto } from './dto/assignments-hierarchy-query.dto';
import { SimpleProgressDto } from './dto/simple-progress.dto';
import { NotificationsService } from '../../common/notifications/notifications.service';
import { StudentDailyAssignmentsService } from '../daily-assignments.service';
import { StorageService } from '../../common/storage/storage.service';
import { RetakeRequestTeacherResolver } from '../../common/assignment/retake-request-teacher-resolver.service';
import * as certificateSvgUtil from '../../common/utils/certificate-svg.util';
import { CertificateService } from '../../common/certificates/certificate.service';

@Controller('student')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.student)
export class StudentExtraController {
  constructor(
    private readonly db: DatabaseService,
    private readonly ranking: RankingService,
    private readonly studentRanking: StudentRankingService,
    private readonly notificationsService: NotificationsService,
    private readonly dailyAssignments: StudentDailyAssignmentsService,
    private readonly storage: StorageService,
    private readonly retakeTeacherResolver: RetakeRequestTeacherResolver,
    private readonly certificateService: CertificateService,
  ) {}

  // ─── Notifications ────────────────────────────────────────────────────────

  private async getStudentSchoolId(studentId: number, schoolIdHint?: string): Promise<string> {
    if (schoolIdHint) {
      const m = await this.db.studentSchool.findFirst({
        where: { studentId, schoolId: schoolIdHint, isActive: true },
      });
      if (!m) throw new BadRequestException('Not enrolled in this school');
      return schoolIdHint;
    }
    // Auto-detect: use the first active school
    const m = await this.db.studentSchool.findFirst({
      where: { studentId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!m) throw new BadRequestException('Not enrolled in any school');
    return m.schoolId;
  }

  /**
   * Students can message teachers in their own school.
   * Recipients: 'role:teacher' (all teachers in school) or individual teacher IDs.
   */
  @Post('notifications')
  async createNotification(
    @CurrentUser() user: { id: number },
    @Body()
    body: {
      title?: string;
      message?: string;
      school_id?: string;
      recipientType?: 'role' | 'individual';
      recipients?: string[];
    },
  ) {
    const title = (body.title ?? '').trim();
    const message = (body.message ?? '').trim();
    if (!title || !message) throw new BadRequestException('Title and message are required');

    const schoolId = await this.getStudentSchoolId(user.id, body.school_id?.trim());

    const recipientType = body.recipientType ?? 'role';
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];
    const targetUserIds = new Set<number>();

    if (recipientType === 'role') {
      // Students can only message teachers (not other students, for safety)
      if (!recipients.includes('role:teacher') && recipients.length > 0) {
        throw new BadRequestException('Students can only send notifications to teachers');
      }
      const teachers = await this.db.teacherSchool.findMany({
        where: { schoolId },
        select: { teacherId: true },
      });
      teachers.forEach((t) => targetUserIds.add(t.teacherId));
    } else {
      const ids = recipients
        .map((x) => parseInt(String(x), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (ids.length === 0) throw new BadRequestException('Invalid recipients');
      // Only allow teachers from this school as individual targets
      const teacherRows = await this.db.teacherSchool.findMany({
        where: { schoolId, teacherId: { in: ids } },
        select: { teacherId: true },
      });
      if (teacherRows.length === 0)
        throw new BadRequestException('Students can only send notifications to teachers in their school');
      teacherRows.forEach((t) => targetUserIds.add(t.teacherId));
    }

    if (targetUserIds.size === 0) throw new BadRequestException('No valid recipients');

    const { sent } = await this.notificationsService.sendBroadcast(
      user.id,
      Array.from(targetUserIds),
      { title, message, type: 'student_message', allowReplies: true },
    );
    return { sent, success: true };
  }

  /**
   * List teachers in student's school (recipient picker for the send UI).
   */
  @Get('notifications/recipients')
  async listNotificationRecipients(
    @CurrentUser() user: { id: number },
    @Query('school_id') schoolId?: string,
  ) {
    const resolvedSchoolId = await this.getStudentSchoolId(user.id, schoolId).catch(() => null);
    if (!resolvedSchoolId) return { roles: [], users: [] };
    const schoolId2 = resolvedSchoolId;

    const [teacherCount, teacherSchools] = await Promise.all([
      this.db.teacherSchool.count({ where: { schoolId: schoolId2 } }),
      this.db.teacherSchool.findMany({ where: { schoolId: schoolId2 } }),
    ]);

    const teacherIds = Array.from(new Set(teacherSchools.map((t) => t.teacherId)));
    const teachers = teacherIds.length > 0
      ? await this.db.user.findMany({
          where: { id: { in: teacherIds } },
          include: { profile: true },
        })
      : [];

    const roles = teacherCount > 0
      ? [{ id: 'role:teacher', name: 'All Teachers', count: teacherCount }]
      : [];

    const users = teachers.map((t) => ({
      id: String(t.id),
      name: t.profile?.fullName ?? t.email,
      email: t.email,
      role: 'teacher',
    }));

    return { roles, users };
  }

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
        // Resolves the real issuing actor (an admin/teacher who manually
        // issued it) — previously never queried, so the frontend's "Issued
        // By" field fell back to the certificate's RECIPIENT (the student's
        // own profile), making every certificate look self-issued.
        issuedByUser: { include: { profile: true } },
      },
    });
    return {
      certificates: certs.map((c) => ({
        id: c.id,
        short_id: certificateSvgUtil.shortCertId(c.id),
        course_id: c.courseId,
        certificate_name: c.certificateName,
        certificate_url: c.certificateUrl,
        status: c.status,
        issued_at: c.issuedAt.toISOString(),
        courses: {
          id: c.courseId,
          name: c.course?.title ?? '',
          title: c.course?.title ?? '',
          grade: '',
          subject: '',
        },
        // Certificates are auto-issued by the platform (issueIfEligible)
        // unless an admin/teacher explicitly issued one manually.
        issued_by:
          c.issuedByUser?.profile?.fullName ??
          c.issuedByUser?.email ??
          'Yugminds',
      })),
    };
  }

  @Get('certificates/:id/download')
  async downloadCertificate(
    @CurrentUser() user: { id: number },
    @Param('id') id: string,
    @Res() res: any,
  ) {
    const cert = await this.db.studentCertificate.findUnique({
      where: { id },
      select: { studentId: true, certificateKey: true, certificateUrl: true, id: true },
    });
    if (!cert || cert.studentId !== user.id) {
      throw new NotFoundException('Certificate not found');
    }
    const key = cert.certificateKey ?? this.storage.keyFromUrl(cert.certificateUrl);
    if (!key) throw new BadRequestException('Certificate file is unavailable');

    const { body, contentType } = await this.storage.getObject(key);
    res.setHeader('Content-Type', contentType ?? 'image/jpeg');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${certificateSvgUtil.shortCertId(cert.id)}.jpg"`,
    );
    return res.send(body);
  }

  /** @deprecated use the exported `shortCertId` from certificate-svg.util directly */
  static shortCertId(fullId: string): string {
    return certificateSvgUtil.shortCertId(fullId);
  }

  /** @deprecated use the exported `svgToJpegBuffer` from certificate-svg.util directly */
  static async svgToJpegBuffer(svg: string): Promise<Buffer> {
    return certificateSvgUtil.svgToJpegBuffer(svg);
  }

  /** @deprecated use the exported `buildCertificateSvg` from certificate-svg.util directly */
  static buildCertificateSvg(
    params: {
      studentName: string;
      courseTitle: string;
      issuedAt: string;
      certificateId: string;
    },
    templateSvg?: string | null,
  ) {
    return certificateSvgUtil.buildCertificateSvg(params, templateSvg);
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
    const key = this.storage.buildKey(
      `assignment-submissions/${user.id}`,
      file.originalname,
    );
    const fileUrl = await this.storage.uploadBuffer(key, file.buffer, mime);
    return {
      success: true,
      file: {
        uploaded_by: user.id,
        filename: file.originalname,
        mime_type: mime,
        size: file.size,
        fileUrl,
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
          where: { id: { in: courseIds }, deletedAt: null },
        }),
        this.db.chapter.findMany({
          where: { courseId: { in: courseIds } },
          select: { id: true, courseId: true },
        }),
        this.db.chapterContent.findMany({
          where: { chapter: { courseId: { in: courseIds } } },
          select: { id: true, chapterId: true, durationMinutes: true },
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
          select: { id: true, chapterId: true, retakeScoringRule: true },
        })
      : [];
    const assignmentIdToCourseId = new Map<string, string>();
    const assignmentMetaById = new Map(assignmentIds.map((a) => [a.id, a]));
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
            // Ascending, so pickBestGraded's "last one seen wins" for the
            // 'latest' rule correctly means "most recent attempt".
            orderBy: { attemptNumber: 'asc' },
          })
        : [];
    // Distinct assignments attempted per course — counting raw submission
    // rows here (as this used to) double-counted a single assignment's
    // retake attempts as multiple separately-completed assignments.
    const attemptedAssignmentIds = new Set(
      submissions.map((s) => s.assignmentId),
    );
    const completedAssignmentsByCourse = new Map<string, number>();
    for (const assignmentId of attemptedAssignmentIds) {
      const c = assignmentIdToCourseId.get(assignmentId);
      if (!c) continue;
      completedAssignmentsByCourse.set(
        c,
        (completedAssignmentsByCourse.get(c) ?? 0) + 1,
      );
    }
    // Average grade per course: same official-score selection
    // StudentRankingService uses (graded-only, honoring retakeScoringRule) —
    // this used to average every raw submission row including superseded
    // retake attempts, which could pull a course's (and the Certificates
    // page's "Achievement Summary → Average Grade") number well below the
    // student's real, deduped score.
    const bestGraded = StudentRankingService.pickBestGraded(
      submissions,
      (s) => s.assignmentId,
      (assignmentId) =>
        assignmentMetaById.get(assignmentId)?.retakeScoringRule ?? 'latest',
    );
    const gradeAggByCourse = new Map<
      string,
      { sumPct: number; count: number }
    >();
    for (const s of bestGraded.values()) {
      const c = assignmentIdToCourseId.get(s.assignmentId);
      if (!c) continue;
      const ms =
        typeof s.maxScore === 'number' && s.maxScore > 0 ? s.maxScore : null;
      const sc = typeof s.score === 'number' ? s.score : null;
      if (ms && sc !== null) {
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
    // Enrollments whose course was excluded by the deletedAt:null filter
    // above (i.e. trashed by an admin) must not surface here — otherwise a
    // trashed course keeps appearing in "My Courses" with a blank title.
    const courses = enrollments
      .filter((e) => courseById.has(e.courseId))
      .map((e) => {
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

      const computed = computeCourseProgress(
        courseChapters,
        courseContents,
        courseProgress as unknown as Array<{
          contentId: string | null;
          chapterId: string | null;
          progress: number;
          completedAt: Date | null;
          updatedAt: Date;
        }>,
      );
      const { completedChapters, status } = computed;
      const last = computed.lastAccessed;
      const finalProgressPercentage = computed.progressPercentage;

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
        // Derived metadata for a richer "My Courses" catalog (no schema change):
        // total lessons, estimated duration (sum of content durations), last updated.
        total_lessons: totalContentItems,
        estimated_minutes: computed.estimatedMinutes,
        last_updated: (course?.updatedAt ?? e.enrolledAt).toISOString(),
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

    const [contents, chapterAssignments, progress] = await Promise.all([
      this.db.chapterContent.findMany({
        where: { chapterId: { in: chapterIds } },
      }),
      this.db.assignment.findMany({
        where: { chapterId: { in: chapterIds } },
        select: { id: true, chapterId: true },
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

    // Group assignments by chapterId
    const assignmentsByChapter = new Map<string, any[]>();
    chapterAssignments.forEach((a) => {
      if (a.chapterId) {
        const list = assignmentsByChapter.get(a.chapterId) || [];
        list.push(a);
        assignmentsByChapter.set(a.chapterId, list);
      }
    });

    // Group progress by chapterId and contentId. Mirrors the completion
    // predicate in the shared computeCourseProgress util (progress >= 99 OR
    // completedAt set) — this endpoint predates that util and never used it
    // directly, but should still agree with it on which rows count as done.
    const completedContentIds = new Set(
      progress
        .filter(
          (p) =>
            (p as any).contentId && (p.progress >= 99 || p.completedAt),
        )
        .map((p) => (p as any).contentId as string),
    );
    const completedChapterIds = new Set(
      progress
        .filter(
          (p) =>
            !(p as any).contentId &&
            p.chapterId &&
            (p.progress >= 99 || p.completedAt),
        )
        .map((p) => p.chapterId as string),
    );

    const resultChapters = chapters.map((ch, index) => {
      const chapterContents = contentsByChapter.get(ch.id) || [];
      const chapterAssignmentsForCh = assignmentsByChapter.get(ch.id) || [];
      const allItems = [...chapterContents, ...chapterAssignmentsForCh];
      const completedInChapter = allItems.filter((c) =>
        completedContentIds.has(c.id),
      ).length;

      // A chapter is completed if explicitly marked OR if all its contents are completed
      const isCompleted =
        completedChapterIds.has(ch.id) ||
        (allItems.length > 0 && completedInChapter === allItems.length);

      // Hybrid logic for completed count: if chapter is marked done, count all items as done
      const displayCompletedCount = isCompleted
        ? allItems.length
        : completedInChapter;

      return {
        id: ch.id,
        course_id: courseId,
        title: ch.title,
        name: ch.title,
        sort_order: ch.sortOrder,
        order_number: index + 1,
        content_count: allItems.length,
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
    const [contents, assignments, progress] = await Promise.all([
      this.db.chapterContent.findMany({
        where: { chapterId },
        orderBy: { sortOrder: 'asc' },
      }),
      this.db.assignment.findMany({
        where: { chapterId },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          title: true,
          description: true,
          sortOrder: true,
        },
      }),
      this.db.courseProgress.findMany({
        where: { studentId: user.id, courseId, chapterId },
      }),
    ]);

    const completedContentIds = new Set(
      progress
        .filter(
          (p) =>
            (p as any).contentId && (p.progress >= 99 || p.completedAt),
        )
        .map((p) => (p as any).contentId as string),
    );
    // A chapter can be marked done as a whole (no contentId, just a
    // chapter-level progress row) — listCourseChapters already honors this
    // for its own is_completed/green-checkmark, but this endpoint only
    // checked per-item rows, so an item viewer kept showing "Mark as
    // Complete" on every item in a chapter the sidebar already showed as
    // 100% complete.
    const chapterMarkedComplete = progress.some(
      (p) =>
        !(p as any).contentId &&
        p.chapterId === chapterId &&
        (p.progress >= 99 || p.completedAt),
    );

    const contentItems = contents.map((c) => ({
      id: c.id,
      content_id: c.id,
      chapter_id: chapterId,
      content_type: c.contentType,
      title: c.title,
      content_text: c.contentText,
      content_url: c.contentUrl,
      order_index: c.sortOrder,
      duration_minutes: c.durationMinutes,
      is_completed: chapterMarkedComplete || completedContentIds.has(c.id),
    }));

    const assignmentItems = assignments.map((a) => ({
      id: a.id,
      content_id: a.id,
      chapter_id: chapterId,
      content_type: 'assignment',
      title: a.title,
      content_text: a.description ?? null,
      content_url: null,
      order_index: a.sortOrder,
      duration_minutes: null,
      is_completed: chapterMarkedComplete || completedContentIds.has(a.id),
    }));

    // Regular content first (already ordered by sortOrder from DB), assignments appended at the end
    return { contents: [...contentItems, ...assignmentItems] };
  }

  @Get('assignments')
  async listAssignments(
    @CurrentUser() user: { id: number },
    @Query('course_id') courseId?: string,
    @Query('type') type?: string,
  ) {
    // If type=DAILY, serve school-scoped daily assignments for the student's grade.
    // Visibility (school + publishScope filtering) is resolved by the shared
    // StudentDailyAssignmentsService so this list and the dashboard counts agree.
    if (type && String(type).toUpperCase() === 'DAILY') {
      const { assignments: dailyAssignments, studentSchool } =
        await this.dailyAssignments.getVisibleDailyAssignments(user.id);
      if (dailyAssignments.length === 0) return { assignments: [] };
      const submissionRows = await this.db.assignmentSubmission.findMany({
        where: {
          studentId: user.id,
          assignmentId: { in: dailyAssignments.map((a) => a.id) },
        },
        // Ascending, so the retake-rule selection below can treat "last
        // matching row seen" as "highest attemptNumber" without re-sorting.
        orderBy: { attemptNumber: 'asc' },
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
      const submissionsByAssignment = new Map<
        string,
        (typeof submissionRows)[0][]
      >();
      for (const s of submissionRows) {
        const list = submissionsByAssignment.get(s.assignmentId) ?? [];
        list.push(s);
        submissionsByAssignment.set(s.assignmentId, list);
      }
      const dailyAssignmentById = new Map(
        dailyAssignments.map((a) => [a.id, a] as const),
      );
      // Same official-score selection as GET /student/assignments/:id and
      // StudentRankingService — honors retakeScoringRule instead of always
      // showing whichever attempt is most recent.
      const latestSubByAssignment = new Map<
        string,
        (typeof submissionRows)[0]
      >();
      for (const [assignmentId, subs] of submissionsByAssignment) {
        const rule = String(
          (dailyAssignmentById.get(assignmentId) as any)?.retakeScoringRule ??
            'latest',
        ).toLowerCase();
        const graded = subs.filter((s) => s.status === 'graded' && s.score != null);
        const chosen =
          graded.length === 0
            ? subs[subs.length - 1]
            : rule === 'highest'
              ? graded.reduce((best, s) =>
                  (s.score ?? 0) > (best.score ?? 0) ? s : best,
                )
              : graded[graded.length - 1];
        latestSubByAssignment.set(assignmentId, chosen);
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
            grade_name: (a as any).grade?.name ?? studentSchool?.grade ?? null,
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
                  graded_at: sub.gradedAt?.toISOString() ?? null,
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
      where: { id: { in: courseIds }, deletedAt: null },
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
      // Ascending, so the retake-rule selection below can treat "last
      // matching row seen" as "highest attemptNumber" without re-sorting.
      orderBy: { attemptNumber: 'asc' },
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
    const submissionsByAssignmentId = new Map<
      string,
      (typeof submissionRows)[0][]
    >();
    for (const s of submissionRows) {
      const list = submissionsByAssignmentId.get(s.assignmentId) ?? [];
      list.push(s);
      submissionsByAssignmentId.set(s.assignmentId, list);
    }
    const assignmentById = new Map(assignments.map((a) => [a.id, a]));
    // Same official-score selection as GET /student/assignments/:id and
    // StudentRankingService — honors retakeScoringRule instead of relying on
    // implicit (unordered) row order, which previously made attempt
    // selection here undefined behavior.
    const submissionByAssignmentId = new Map<
      string,
      (typeof submissionRows)[0]
    >();
    for (const [assignmentId, subs] of submissionsByAssignmentId) {
      const rule = String(
        assignmentById.get(assignmentId)?.retakeScoringRule ?? 'latest',
      ).toLowerCase();
      const graded = subs.filter((s) => s.status === 'graded' && s.score != null);
      const chosen =
        graded.length === 0
          ? subs[subs.length - 1]
          : rule === 'highest'
            ? graded.reduce((best, s) =>
                (s.score ?? 0) > (best.score ?? 0) ? s : best,
              )
            : graded[graded.length - 1];
      submissionByAssignmentId.set(assignmentId, chosen);
    }
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
            graded_at: s.gradedAt?.toISOString() ?? null,
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
        where: { id: { in: courseIds }, deletedAt: null },
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
    // The submission shown to the student must reflect the OFFICIAL score for
    // this assignment — the same graded-attempt selection StudentRankingService
    // uses, honoring `retakeScoringRule` ('highest' picks the best-scoring
    // graded attempt; 'latest'/default picks the most recent graded one) —
    // not just whichever attempt happens to be most recent. This used to
    // always show the latest attempt regardless of the rule, which directly
    // contradicted the "Your highest score across all attempts is used for
    // grading" copy shown to the student on 'highest'-rule assignments: a
    // student who retook and scored worse would see the worse score.
    const gradedAttempts = attempts.filter(
      (a) => a.status === 'graded' && a.score != null,
    );
    const scoringRule = String(
      assignment.retakeScoringRule ?? 'latest',
    ).toLowerCase();
    const officialGradedAttempt =
      gradedAttempts.length === 0
        ? null
        : scoringRule === 'highest'
          ? gradedAttempts.reduce((best, a) =>
              (a.score ?? 0) > (best.score ?? 0) ? a : best,
            )
          : gradedAttempts[gradedAttempts.length - 1]; // ascending order → last (highest attemptNumber) wins
    const latestAttempt =
      officialGradedAttempt ?? attempts[attempts.length - 1] ?? null;
    const retakeGrant = await this.db.retakeGrant.findUnique({
      where: { assignmentId_studentId: { assignmentId, studentId: user.id } },
      select: { isActive: true },
    });
    const latestRetakeRequest = await this.db.retakeRequest.findFirst({
      where: { assignmentId, studentId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        reason: true,
        teacherRemarks: true,
        createdAt: true,
        decidedAt: true,
      },
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
        scoring_rule: assignment.retakeScoringRule ?? 'latest',
        // Mirror exactly the canRetake logic used in the submit handler so that
        // the frontend's "Retake" button appears iff the submit will be accepted.
        allowed:
          attempts.length === 0 ||
          (!!assignment.retakeEnabled &&
            (assignment.maxRetakeAttempts == null ||
              attempts.length < (assignment.maxRetakeAttempts ?? 0) + 1) &&
            ((assignment.retakeAccessScope ?? 'all') === 'all' ||
              !!retakeGrant?.isActive) &&
            (assignment.maxRetakeAttempts === null ||
              !!assignment.retakeWindowOpen ||
              !!retakeGrant?.isActive)),
      },
      retake_request: latestRetakeRequest
        ? {
            id: latestRetakeRequest.id,
            status: latestRetakeRequest.status,
            reason: latestRetakeRequest.reason,
            teacher_remarks: latestRetakeRequest.teacherRemarks,
            created_at: latestRetakeRequest.createdAt.toISOString(),
            decided_at: latestRetakeRequest.decidedAt?.toISOString() ?? null,
          }
        : null,
    };
  }

  /**
   * Student asks to be granted a retake. Routed to the teacher(s) who
   * actually teach the student's grade/section at the assignment's school
   * (RetakeRequestTeacherResolver) rather than any teacher at the school.
   */
  @Post('assignments/:assignmentId/retake-request')
  async requestRetake(
    @CurrentUser() user: { id: number },
    @Param('assignmentId') assignmentId: string,
    @Body() body: { reason?: string },
  ) {
    const assignment = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        title: true,
        teacherId: true,
        schoolId: true,
        chapterId: true,
        courseId: true,
        retakeEnabled: true,
        retakeWindowOpen: true,
        retakeAccessScope: true,
        maxRetakeAttempts: true,
      },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');

    const attemptsCount = await this.db.assignmentSubmission.count({
      where: { assignmentId, studentId: user.id },
    });
    if (attemptsCount === 0) {
      throw new BadRequestException(
        'Submit the assignment at least once before requesting a retake',
      );
    }

    const retakeGrant = await this.db.retakeGrant.findUnique({
      where: { assignmentId_studentId: { assignmentId, studentId: user.id } },
      select: { isActive: true },
    });
    // Same formula as getAssignment()/submitAssignment() — no point
    // requesting when a retake is already allowed.
    const alreadyAllowed =
      !!assignment.retakeEnabled &&
      (assignment.maxRetakeAttempts == null ||
        attemptsCount < (assignment.maxRetakeAttempts ?? 0) + 1) &&
      ((assignment.retakeAccessScope ?? 'all') === 'all' ||
        !!retakeGrant?.isActive) &&
      (assignment.maxRetakeAttempts === null ||
        !!assignment.retakeWindowOpen ||
        !!retakeGrant?.isActive);
    if (alreadyAllowed) {
      throw new BadRequestException('A retake is already available for this assignment');
    }

    const existingPending = await this.db.retakeRequest.findFirst({
      where: { assignmentId, studentId: user.id, status: 'pending' },
      select: { id: true },
    });
    if (existingPending) {
      throw new BadRequestException(
        'You already have a pending retake request for this assignment',
      );
    }

    const { schoolId, teacherIds: targetTeacherIds } = await this.retakeTeacherResolver.resolve(
      user.id,
      {
        teacherId: assignment.teacherId,
        schoolId: assignment.schoolId,
        chapterId: assignment.chapterId,
        courseId: assignment.courseId,
      },
    );

    const created = await this.db.retakeRequest.create({
      data: {
        assignmentId,
        studentId: user.id,
        reason: body.reason?.trim() || null,
        schoolId,
        targetTeacherIds,
      },
    });

    if (targetTeacherIds.length > 0) {
      const studentName =
        (
          await this.db.profile.findUnique({
            where: { userId: user.id },
            select: { fullName: true },
          })
        )?.fullName ?? 'A student';
      await this.notificationsService.sendBroadcast(user.id, targetTeacherIds, {
        title: `Retake requested: ${assignment.title}`,
        message: `${studentName} has requested a retake for "${assignment.title}".${
          created.reason ? ` Reason: ${created.reason}` : ''
        }`,
        type: 'assignment_retake_request',
      });
    }

    return {
      retake_request: {
        id: created.id,
        status: created.status,
        reason: created.reason,
        teacher_remarks: created.teacherRemarks,
        created_at: created.createdAt.toISOString(),
        decided_at: null,
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
    // Window is not required when attempts are unlimited — an open window is only
    // needed to grant a time-limited second chance on fixed-attempt assignments.
    const unlimitedAttempts = assignment.maxRetakeAttempts === null;
    const retakeAllowedByWindow =
      unlimitedAttempts ||
      !!assignment.retakeWindowOpen ||
      !!activeRetakeGrant?.isActive;
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

        // The question builder stores `correctAnswer` as the option's TEXT
        // (see AssignmentBuilder.tsx), not its index — so prefer an exact
        // text match against `options` first. That match is unambiguous.
        // Only fall back to treating `expected` as a raw numeric index for
        // legacy rows where no option's text matches it at all — otherwise
        // a numeric-looking option (e.g. options ["1","2","3","4"] with "1"
        // marked correct) gets misread as index 1 ("2") instead of index 0
        // ("1"), silently grading the actually-correct answer as wrong.
        const textMatchIndex = options.findIndex((o) => norm(o) === norm(expected));
        let expectedIndex: number;
        if (textMatchIndex !== -1) {
          expectedIndex = textMatchIndex;
        } else {
          const parsed = parseInt(expected, 10);
          expectedIndex =
            !Number.isNaN(parsed) && parsed >= 0 && parsed < options.length
              ? parsed
              : -1;
        }

        if (
          !Number.isNaN(givenIndex) &&
          givenIndex >= 0 &&
          givenIndex < options.length
        ) {
          isCorrect = givenIndex === expectedIndex;
        } else {
          // Legacy: student answer stored as raw option text instead of index.
          const expectedText =
            expectedIndex !== -1 ? norm(options[expectedIndex]) : norm(expected);
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
      // Drop the shared ranking cache so all dashboards reflect the new score.
      await this.studentRanking.invalidate();
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

    const result = await this.certificateService.issueIfEligible(
      user.id,
      courseId,
      user.id,
    );
    if (!result.issued) {
      throw new BadRequestException(
        result.reason === 'not_enrolled'
          ? 'Not enrolled in this course'
          : 'Course not eligible for certificate (requires 80%+ completion).',
      );
    }

    const cert = await this.db.studentCertificate.findUniqueOrThrow({
      where: { id: result.certificateId },
      select: { id: true, certificateUrl: true },
    });
    return {
      success: true,
      certificate: {
        id: cert.id,
        short_id: certificateSvgUtil.shortCertId(cert.id),
        certificate_url: cert.certificateUrl,
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
        content_id: p.contentId, // required for frontend store hydration
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

    // Fire-and-forget: this content item may have just pushed the course
    // over the 80% eligibility line. issueIfEligible is idempotent (no-ops
    // if already issued or still under 80%), and a failure here must never
    // fail the progress save itself.
    if (value >= 99) {
      this.certificateService
        .issueIfEligible(user.id, courseId)
        .catch(() => {});
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

    // Fire-and-forget: see identical note in saveSimpleProgress above.
    if (value >= 99) {
      this.certificateService
        .issueIfEligible(user.id, courseId)
        .catch(() => {});
    }

    return { success: true, progress: value };
  }

  @Post('last-viewed')
  async saveLastViewed(
    @CurrentUser() user: { id: number },
    @Body() body: { courseId?: string; chapterId?: string; contentId?: string },
  ) {
    const courseId = (body.courseId ?? '').trim();
    const chapterId = (body.chapterId ?? '').trim() || null;
    const contentId = (body.contentId ?? '').trim() || null;
    if (!courseId) throw new BadRequestException('courseId required');

    const enrolled = await this.db.studentCourse.findUnique({
      where: { studentId_courseId: { studentId: user.id, courseId } },
    });
    if (!enrolled) return { success: false };

    const existing = await this.db.courseProgress.findFirst({
      where: { studentId: user.id, courseId, chapterId, contentId },
    });
    if (existing) {
      await this.db.courseProgress.update({
        where: { id: existing.id },
        data: { updatedAt: new Date() },
      });
    } else {
      await this.db.courseProgress.create({
        data: {
          studentId: user.id,
          courseId,
          chapterId,
          contentId,
          progress: 0,
        },
      });
    }
    return { success: true };
  }

  /**
   * Most recently viewed course position, for the dashboard "Jump back in"
   * widget. Returns null when the student has no resumable position (e.g.
   * brand-new, or their last course was unenrolled/unpublished).
   */
  @Get('last-viewed')
  async getLastViewed(@CurrentUser() user: { id: number }) {
    // Prefer rows that point at a chapter (resumable); fall back to any row.
    const rows = await this.db.courseProgress.findMany({
      where: { studentId: user.id, chapterId: { not: null } },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: {
        courseId: true,
        chapterId: true,
        contentId: true,
        progress: true,
        updatedAt: true,
      },
    });
    if (rows.length === 0) return { lastViewed: null };

    // Walk newest→oldest until we find one whose course is still enrolled.
    for (const row of rows) {
      const enrolled = await this.db.studentCourse.findUnique({
        where: {
          studentId_courseId: { studentId: user.id, courseId: row.courseId },
        },
      });
      if (!enrolled) continue;

      const course = await this.db.course.findFirst({
        where: { id: row.courseId, isPublished: true },
        select: { id: true, title: true, thumbnailUrl: true },
      });
      if (!course) continue;

      // A fully-completed course shouldn't surface as "Jump back in /
      // Resume" — it's already done, and showing it here contradicted the
      // Active Courses list/stat cards, which correctly exclude it.
      const courseChapters = await this.db.chapter.findMany({
        where: { courseId: row.courseId },
        select: { id: true },
      });
      const courseChapterIds = courseChapters.map((c) => c.id);
      const courseContents = await this.db.chapterContent.findMany({
        where: { chapterId: { in: courseChapterIds } },
        select: { id: true, chapterId: true },
      });
      const courseProgressRows = await this.db.courseProgress.findMany({
        where: { studentId: user.id, courseId: row.courseId },
        select: {
          contentId: true,
          chapterId: true,
          progress: true,
          completedAt: true,
          updatedAt: true,
        } as any,
      });
      const { status } = computeCourseProgress(
        courseChapters,
        courseContents,
        courseProgressRows as any,
      );
      if (status === 'completed') continue;

      const chapter = row.chapterId
        ? await this.db.chapter.findUnique({
            where: { id: row.chapterId },
            select: { title: true },
          })
        : null;
      const content = row.contentId
        ? await this.db.chapterContent.findUnique({
            where: { id: row.contentId },
            select: { title: true, contentType: true },
          })
        : null;

      return {
        lastViewed: {
          courseId: course.id,
          courseTitle: course.title,
          thumbnailUrl: course.thumbnailUrl ?? null,
          chapterId: row.chapterId,
          chapterTitle: chapter?.title ?? null,
          contentId: row.contentId,
          contentTitle: content?.title ?? null,
          contentType: content?.contentType ?? null,
          progress: row.progress,
          updatedAt: row.updatedAt,
        },
      };
    }
    return { lastViewed: null };
  }

  /**
   * Day-by-day activity feed + learning streak for the dashboard.
   * A day is "active" if the student made learning progress (CourseProgress)
   * or submitted an assignment on that calendar day (UTC).
   */
  @Get('activity')
  async getActivity(@CurrentUser() user: { id: number }) {
    const toKey = (d: Date) => d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

    const [progressRows, submissions] = await Promise.all([
      this.db.courseProgress.findMany({
        where: { studentId: user.id, progress: { gt: 0 } },
        select: { updatedAt: true },
      }),
      this.db.assignmentSubmission.findMany({
        where: { studentId: user.id },
        select: { submittedAt: true },
      }),
    ]);

    const learningDays = new Set(progressRows.map((r) => toKey(r.updatedAt)));
    const assignmentDays = new Set(
      submissions.map((s) => toKey(s.submittedAt)),
    );

    const allKeys = new Set<string>([...learningDays, ...assignmentDays]);
    const activityDays = [...allKeys].sort().map((date) => ({
      date,
      hasLearning: learningDays.has(date),
      hasAssignment: assignmentDays.has(date),
    }));

    // Streaks: consecutive active calendar days.
    const dayMs = 24 * 60 * 60 * 1000;
    const sortedKeys = [...allKeys].sort();
    let longestStreak = 0;
    let run = 0;
    let prevTs: number | null = null;
    for (const key of sortedKeys) {
      const ts = Date.parse(`${key}T00:00:00Z`);
      run = prevTs !== null && ts - prevTs === dayMs ? run + 1 : 1;
      if (run > longestStreak) longestStreak = run;
      prevTs = ts;
    }

    // Current streak: counts back from today (or yesterday) while days are active.
    let currentStreak = 0;
    const todayTs = Date.parse(`${toKey(new Date())}T00:00:00Z`);
    const hasToday = allKeys.has(toKey(new Date(todayTs)));
    const hasYesterday = allKeys.has(toKey(new Date(todayTs - dayMs)));
    if (hasToday || hasYesterday) {
      let cursor = hasToday ? todayTs : todayTs - dayMs;
      while (allKeys.has(toKey(new Date(cursor)))) {
        currentStreak += 1;
        cursor -= dayMs;
      }
    }

    const cutoff = todayTs - 27 * dayMs;
    const activeDaysLast28 = sortedKeys.filter(
      (k) => Date.parse(`${k}T00:00:00Z`) >= cutoff,
    ).length;

    return {
      activityDays,
      currentStreak,
      longestStreak,
      activeDaysLast28,
    };
  }

  @Get('analytics')
  async getAnalytics(
    @CurrentUser() user: { id: number },
    @Query('historyLimit') historyLimitParam?: string,
    @Query('from') fromParam?: string,
    @Query('to') toParam?: string,
  ) {
    // ── 1. School enrollment (grade/section/schoolId) ──────────────────────
    const enrollment = await this.db.studentSchool.findFirst({
      where: { studentId: user.id, isActive: true },
      select: { schoolId: true, grade: true, section: true },
    });
    const schoolId = enrollment?.schoolId ?? null;

    // ── 2. Student-centric: fetch ALL of this student's submissions first ───
    // This avoids the courseAccess dependency that caused course scores to
    // always show 0 when no courseAccess rows existed for the school.
    const ownSubmissions = await this.db.assignmentSubmission.findMany({
      where: { studentId: user.id },
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
    });

    // ── 3. Resolve assignment metadata for all submitted + school-scoped ────
    const submittedIds = [
      ...new Set(ownSubmissions.map((s) => s.assignmentId)),
    ];

    // Also include school-scoped daily assignments the student hasn't submitted
    // yet (so they appear in the subject breakdown even with no submissions).
    const schoolAssignmentIds = schoolId
      ? (
          await this.db.assignment.findMany({
            where: { schoolId, isPublished: true },
            select: { id: true },
          })
        ).map((a) => a.id)
      : [];

    const allAssignmentIds = [
      ...new Set([...submittedIds, ...schoolAssignmentIds]),
    ];

    const allAssignments = allAssignmentIds.length
      ? await this.db.assignment.findMany({
          where: { id: { in: allAssignmentIds } },
          select: {
            id: true,
            assignmentType: true,
            title: true,
            subject: true,
            retakeScoringRule: true,
          },
        })
      : [];

    const asgnMap = new Map(allAssignments.map((a) => [a.id, a]));

    // ── 4. Canonical dedup: graded-only, respect retakeScoringRule ──────────
    // Same selection algorithm StudentRankingService uses for rankings, and
    // the student assignment list/detail endpoints use for their headline
    // score — kept as one shared implementation so this page can never
    // silently diverge from what a teacher/admin/school-admin sees.
    const bestByKey = StudentRankingService.pickBestGraded(
      ownSubmissions,
      (s) => s.assignmentId,
      (assignmentId) =>
        asgnMap.get(assignmentId)?.retakeScoringRule ?? 'latest',
    );
    const bestSubs = [...bestByKey.values()];

    // ── 5. Personal score summary ───────────────────────────────────────────
    let courseScore = 0,
      courseMax = 0,
      dailyScore = 0,
      dailyMax = 0;
    const subjectMap = new Map<string, { total: number; max: number }>();
    for (const s of bestSubs) {
      const asgn = asgnMap.get(s.assignmentId);
      const score = Number(s.score ?? 0);
      const max = Number(s.maxScore ?? 0);
      if (asgn?.assignmentType === 'COURSE') {
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

    // ── 6. Score history (deduplicated best per assignment, configurable limit) ─
    const historyLimit = Math.min(
      100,
      Math.max(1, parseInt(historyLimitParam ?? '20', 10) || 20),
    );
    const fromDate = fromParam ? new Date(fromParam) : null;
    const toDate = toParam ? new Date(toParam) : null;

    const scoreHistory = [...bestSubs]
      .filter((s) => {
        if (!fromDate && !toDate) return true;
        const t = s.submittedAt ? new Date(s.submittedAt).getTime() : 0;
        if (fromDate && t < fromDate.getTime()) return false;
        if (toDate && t > toDate.getTime()) return false;
        return true;
      })
      .sort(
        (a, b) =>
          new Date(a.submittedAt ?? 0).getTime() -
          new Date(b.submittedAt ?? 0).getTime(),
      )
      .slice(-historyLimit)
      .map((s) => {
        const asgn = asgnMap.get(s.assignmentId);
        return {
          assignment_id: s.assignmentId,
          title: asgn?.title ?? '',
          assignment_type: asgn?.assignmentType ?? 'DAILY',
          subject: asgn?.subject ?? 'General',
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
        };
      });

    // ── 7. Subject breakdown ────────────────────────────────────────────────
    const subject_breakdown = [...subjectMap.entries()]
      .map(([subject, s]) => ({
        subject,
        avg_score: s.max > 0 ? Number(((s.total / s.max) * 100).toFixed(2)) : 0,
        submissions: bestSubs.filter(
          (sub) =>
            (asgnMap.get(sub.assignmentId)?.subject ?? 'General') === subject,
        ).length,
      }))
      .sort((a, b) => b.avg_score - a.avg_score);

    // ── 8. Rankings (section / grade / school / system) + leaderboard ─────────
    // Delegated to the shared StudentRankingService so every dashboard agrees.
    const { rows: globalRows, schoolCount } =
      await this.studentRanking.getGlobalRanking();

    // System scope: a student's overall score is global, so dedupe multi-school
    // enrollments to one entry per student.
    const systemUnique = new Map<
      number,
      { studentId: number; overallScore: number }
    >();
    for (const r of globalRows) {
      if (!systemUnique.has(r.studentId)) {
        systemUnique.set(r.studentId, {
          studentId: r.studentId,
          overallScore: r.overallScore,
        });
      }
    }

    const schoolRows = schoolId
      ? globalRows.filter((r) => r.schoolId === schoolId)
      : [];
    const gradeRows = schoolRows.filter(
      (r) => r.grade === (enrollment?.grade ?? ''),
    );
    const sectionRows = gradeRows.filter(
      (r) => r.section === (enrollment?.section ?? ''),
    );

    const rankings = {
      section: this.studentRanking.rankWithin(sectionRows, user.id),
      grade: this.studentRanking.rankWithin(gradeRows, user.id),
      school: this.studentRanking.rankWithin(schoolRows, user.id),
      system: {
        ...this.studentRanking.rankWithin([...systemUnique.values()], user.id),
        schools: schoolCount,
      },
    };

    const school_leaderboard = this.studentRanking
      .buildLeaderboard(schoolRows)
      .map((r) => ({
        rank: r.rank,
        school_rank: r.school_rank,
        grade_rank: r.grade_rank,
        section_rank: r.section_rank,
        student_id: r.student_id,
        student_name: r.student_name,
        grade: r.grade,
        section: r.section,
        course_score: r.course_score,
        daily_score: r.daily_score,
        overall_score: r.overall_score,
        is_self: r.student_id === user.id,
        badge: r.badge,
      }));

    const selfSchoolName =
      globalRows.find((r) => r.studentId === user.id)?.schoolName ?? '';

    const gradedCount = bestSubs.length;
    // 'late' submissions are also ungraded/awaiting-review, not just
    // 'submitted' — omitting them understated how much work was still
    // pending a teacher's grading.
    const submittedCount = ownSubmissions.filter(
      (s) => s.status === 'submitted' || s.status === 'late',
    ).length;

    return {
      summary: {
        course_assignment_score: coursePercent,
        daily_assignment_score: dailyPercent,
        overall_score: overallScore,
        assignments_attempted: ownSubmissions.length,
        graded_count: gradedCount,
        pending_grading: submittedCount,
        badge: StudentRankingService.computeBadge(overallScore),
        grade: enrollment?.grade ?? '',
        section: enrollment?.section ?? '',
        school_name: selfSchoolName,
        // Legacy flat rank fields (kept for backward-compat)
        school_rank: rankings.school.rank,
        grade_rank: rankings.grade.rank,
        section_rank: rankings.section.rank,
      },
      // Structured multi-scope rankings: { rank, total, percentile }
      rankings,
      subject_breakdown,
      score_history: scoreHistory,
      school_leaderboard,
    };
  }
}
