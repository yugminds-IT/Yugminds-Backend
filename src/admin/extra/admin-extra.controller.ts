import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { DatabaseService } from '../../database/database.service';
import { Prisma, Role } from '@prisma/client';
import { AdminCoursesService } from '../courses/courses.service';
import { PasswordResetRequestService } from '../../common/password-reset-request/password-reset-request.service';
import { MonitoringService } from '../../common/monitoring/monitoring.service';
import { generateSecret, generateURI, verify } from 'otplib';
import * as QRCode from 'qrcode';
import { randomUUID } from 'crypto';
import { BatchGenerateCertificatesDto } from './dto/batch-generate-certificates.dto';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { NotificationsService } from '../../common/notifications/notifications.service';
import { StudentExtraController } from '../../student/extra/student-extra.controller';
import { StorageService } from '../../common/storage/storage.service';

interface PlaceholderResponse {
  endpoint: string;
  method: string;
  message: string;
}

@Controller('admin')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminExtraController {
  constructor(
    private readonly db: DatabaseService,
    private readonly coursesService: AdminCoursesService,
    private readonly passwordResetRequestService: PasswordResetRequestService,
    private readonly monitoringService: MonitoringService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly notificationsService: NotificationsService,
    private readonly storage: StorageService,
  ) {}

  private buildResponse(endpoint: string, method: string): PlaceholderResponse {
    return {
      endpoint,
      method,
      message:
        'This endpoint is implemented as a placeholder. Replace with real business logic as needed.',
    };
  }

  // Styled PDF generator using pdfkit — produces a professional report with logo, header, tables, footer.
  private buildStyledPdf(opts: {
    title: string;
    subtitle: string;
    generatedAt: Date;
    filters: Record<string, string>;
    summaryStats: Array<{ label: string; value: string | number }>;
    tableColumns: string[];
    tableRows: string[][];
  }): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const PDFDocument = require('pdfkit');
      const path = require('path');
      const fs = require('fs');

      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ── Brand colours ─────────────────────────────────────────────────────────
      const PRIMARY   = '#1e3a5f'; // dark navy
      const ACCENT    = '#0ea5e9'; // sky blue
      const LIGHT_BG  = '#f0f7ff'; // very light blue
      const TEXT_DARK = '#1a202c';
      const TEXT_MID  = '#4a5568';
      const TEXT_LITE = '#718096';
      const WHITE     = '#ffffff';
      const ROW_ALT   = '#f7fafc';
      const BORDER    = '#e2e8f0';

      const PAGE_W = doc.page.width;
      const PAGE_H = doc.page.height;
      const MARGIN = 50;
      const CONTENT_W = PAGE_W - MARGIN * 2;

      // ── Helper: draw a filled rounded rect ────────────────────────────────────
      const fillRect = (x: number, y: number, w: number, h: number, colour: string, r = 0) => {
        doc.save().roundedRect(x, y, w, h, r).fill(colour).restore();
      };

      // ── HEADER BAND ───────────────────────────────────────────────────────────
      fillRect(0, 0, PAGE_W, 90, PRIMARY);

      // Logo (if file exists)
      const logoPath = path.join(__dirname, '..', '..', '..', 'assets', 'yugminds-logo.png');
      if (fs.existsSync(logoPath)) {
        try {
          doc.image(logoPath, MARGIN, 18, { height: 54, fit: [160, 54] });
        } catch { /* skip logo on error */ }
      }

      // Right side: platform name + report title
      doc
        .fillColor(WHITE)
        .font('Helvetica-Bold')
        .fontSize(18)
        .text('Yugminds Education Platform', 0, 22, { align: 'right' })
        .font('Helvetica')
        .fontSize(10)
        .fillColor(ACCENT)
        .text(opts.title, 0, 46, { align: 'right' });

      // Accent stripe below header
      fillRect(0, 90, PAGE_W, 4, ACCENT);

      let y = 114;

      // ── META ROW ──────────────────────────────────────────────────────────────
      fillRect(MARGIN, y, CONTENT_W, 44, LIGHT_BG, 6);

      const formattedDate = opts.generatedAt.toLocaleDateString('en-IN', {
        day: '2-digit', month: 'long', year: 'numeric',
      });
      const formattedTime = opts.generatedAt.toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', hour12: true,
      });

      const filterStr = Object.entries(opts.filters)
        .filter(([k]) => k !== 'type')
        .map(([k, v]) => `${k}: ${v}`)
        .join('  |  ') || 'All records';

      doc
        .fillColor(TEXT_MID)
        .font('Helvetica')
        .fontSize(9)
        .text(`Generated: ${formattedDate} at ${formattedTime}`, MARGIN + 12, y + 8)
        .text(`Filters applied: ${filterStr}`, MARGIN + 12, y + 22);

      y += 60;

      // ── SUBTITLE ─────────────────────────────────────────────────────────────
      doc
        .fillColor(PRIMARY)
        .font('Helvetica-Bold')
        .fontSize(15)
        .text(opts.subtitle, MARGIN, y);
      y += 22;
      fillRect(MARGIN, y, 48, 3, ACCENT, 2);
      y += 16;

      // ── SUMMARY STATS CARDS ───────────────────────────────────────────────────
      if (opts.summaryStats.length > 0) {
        const cardW = Math.floor(CONTENT_W / opts.summaryStats.length) - 8;
        opts.summaryStats.forEach((stat, i) => {
          const cx = MARGIN + i * (cardW + 8);
          fillRect(cx, y, cardW, 52, WHITE, 6);
          // Border
          doc.save().roundedRect(cx, y, cardW, 52, 6).stroke(BORDER).restore();
          doc
            .fillColor(ACCENT)
            .font('Helvetica-Bold')
            .fontSize(20)
            .text(String(stat.value), cx + 10, y + 8, { width: cardW - 20 });
          doc
            .fillColor(TEXT_LITE)
            .font('Helvetica')
            .fontSize(8)
            .text(stat.label.toUpperCase(), cx + 10, y + 32, { width: cardW - 20 });
        });
        y += 68;
      }

      // ── DATA TABLE ────────────────────────────────────────────────────────────
      if (opts.tableColumns.length > 0) {
        const colCount = opts.tableColumns.length;
        const colW = Math.floor(CONTENT_W / colCount);

        // Table header row
        fillRect(MARGIN, y, CONTENT_W, 24, PRIMARY, 4);
        opts.tableColumns.forEach((col, i) => {
          doc
            .fillColor(WHITE)
            .font('Helvetica-Bold')
            .fontSize(8)
            .text(col.toUpperCase(), MARGIN + i * colW + 8, y + 7, { width: colW - 12, ellipsis: true });
        });
        y += 24;

        // Table body rows
        const ROW_H = 20;
        opts.tableRows.forEach((row, rowIdx) => {
          // Page break check
          if (y + ROW_H > PAGE_H - 70) {
            doc.addPage();
            y = MARGIN;
            // Reprint header on new page
            fillRect(MARGIN, y, CONTENT_W, 24, PRIMARY, 4);
            opts.tableColumns.forEach((col, i) => {
              doc
                .fillColor(WHITE)
                .font('Helvetica-Bold')
                .fontSize(8)
                .text(col.toUpperCase(), MARGIN + i * colW + 8, y + 7, { width: colW - 12, ellipsis: true });
            });
            y += 24;
          }

          const rowBg = rowIdx % 2 === 0 ? WHITE : ROW_ALT;
          fillRect(MARGIN, y, CONTENT_W, ROW_H, rowBg);
          // Bottom border
          doc.save().moveTo(MARGIN, y + ROW_H).lineTo(MARGIN + CONTENT_W, y + ROW_H).stroke(BORDER).restore();

          row.forEach((cell, i) => {
            doc
              .fillColor(TEXT_DARK)
              .font('Helvetica')
              .fontSize(8)
              .text(String(cell ?? '—'), MARGIN + i * colW + 8, y + 5, { width: colW - 12, ellipsis: true });
          });
          y += ROW_H;
        });

        if (opts.tableRows.length === 0) {
          fillRect(MARGIN, y, CONTENT_W, 36, ROW_ALT);
          doc
            .fillColor(TEXT_LITE)
            .font('Helvetica')
            .fontSize(10)
            .text('No records found for the selected filters.', MARGIN, y + 11, { width: CONTENT_W, align: 'center' });
          y += 36;
        }
      }

      // ── FOOTER ────────────────────────────────────────────────────────────────
      const footerY = PAGE_H - 46;
      fillRect(0, footerY, PAGE_W, 46, PRIMARY);
      doc
        .fillColor(WHITE)
        .font('Helvetica')
        .fontSize(8)
        .text('Yugminds Education Platform  ·  www.yugminds.com  ·  Confidential — for school use only', 0, footerY + 10, { align: 'center' })
        .fillColor(ACCENT)
        .text(`Generated on ${formattedDate}`, 0, footerY + 26, { align: 'center' });

      doc.end();
    });
  }

  // Monitoring / analytics / stats

  @Get('student-progress')
  async getStudentProgress(
    @Query('school_id') schoolId?: string,
    @Query('course_id') courseId?: string,
    @Query('student_id') studentId?: string,
    @Query('grade') grade?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const take = limit ? Math.min(parseInt(limit, 10) || 20, 5000) : 20;
    const skip = offset ? Math.max(parseInt(offset, 10) || 0, 0) : 0;

    // Build DB-level filter to avoid loading all students into memory
    const studentWhere: any = { role: Role.student };
    if (studentId) {
      studentWhere.id = parseInt(studentId, 10) || 0;
    }
    if (schoolId || grade) {
      const schoolFilter: any = {};
      if (schoolId) schoolFilter.schoolId = schoolId;
      if (grade) schoolFilter.grade = grade;
      studentWhere.studentSchools = { some: schoolFilter };
    }

    // Run count and page fetch in parallel — no in-memory pagination.
    const [totalStudents, allStudentsFiltered] = await Promise.all([
      this.db.user.count({ where: studentWhere }),
      this.db.user.findMany({
        where: studentWhere,
        select: {
          id: true,
          email: true,
          profile: {
            select: { fullName: true, phone: true },
          },
          studentSchools: {
            select: {
              schoolId: true,
              grade: true,
              section: true,
              joiningCode: true,
              isActive: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
    ]);

    const allStudentIds = allStudentsFiltered.map((u) => u.id);

    if (allStudentIds.length === 0) {
      return {
        students: [],
        schools: [],
        courses: [],
        summary: {
          total_students: 0,
          students_with_progress: 0,
          students_completed: 0,
          average_school_progress: 0,
          average_system_progress: 0,
          total_courses: 0,
          total_teachers: 0,
          total_schools: 0,
        },
        pagination: {
          limit: take,
          offset: skip,
          total: 0,
          hasMore: false,
        },
      };
    }

    const [studentCourses, courseProgress] = await Promise.all([
      this.db.studentCourse.findMany({
        where: {
          studentId: { in: allStudentIds },
          ...(courseId ? { courseId } : {}),
        },
      }),
      this.db.courseProgress.findMany({
        where: {
          studentId: { in: allStudentIds },
          ...(courseId ? { courseId } : {}),
        },
      }),
    ]);

    const courseIdsForQuery: string[] = Array.from(
      new Set<string>(studentCourses.map((sc) => sc.courseId)),
    );

    const [courses, schools] = await Promise.all([
      this.db.course.findMany({
        where: courseIdsForQuery.length
          ? {
              id: {
                in: courseIdsForQuery,
              },
            }
          : undefined,
        include: { _count: { select: { chapters: true } } },
      }),
      this.db.school.findMany({
        where: {
          id: {
            in: Array.from(
              new Set(
                allStudentsFiltered
                  .flatMap((u) => u.studentSchools ?? [])
                  .map((ss) => ss.schoolId),
              ),
            ),
          },
        },
      }),
    ]);

    const courseById = new Map(courses.map((c) => [c.id, c]));
    const schoolById = new Map(schools.map((s) => [s.id, s]));

    type CourseProgressDto = {
      course_id: string;
      course_name: string;
      total_chapters: number;
      completed_chapters: number;
      progress_percentage: number;
      last_accessed: string;
      enrolled_on: string;
      status: 'completed' | 'in_progress' | 'not_started';
    };

    const studentsDtoAll = allStudentsFiltered.map((u) => {
      const schoolsForStudent = u.studentSchools ?? [];
      const primarySchool = schoolsForStudent[0];
      const school = primarySchool
        ? schoolById.get(primarySchool.schoolId)
        : undefined;

      const studentCourseForUser = studentCourses.filter(
        (sc) => sc.studentId === u.id,
      );
      const progressForUser = courseProgress.filter(
        (cp) => cp.studentId === u.id,
      );

      const coursesForStudent: CourseProgressDto[] = [];
      const courseIdsForStudent: string[] = Array.from(
        new Set<string>(studentCourseForUser.map((sc) => sc.courseId)),
      );

      for (const cid of courseIdsForStudent) {
        const course = courseById.get(cid);
        const progressEntries = progressForUser.filter(
          (cp) => cp.courseId === cid,
        );
        const avgProgress =
          progressEntries.length > 0
            ? progressEntries.reduce((sum, p) => sum + p.progress, 0) /
              progressEntries.length
            : 0;
        const last = progressEntries.reduce<Date | null>((latest, p) => {
          const ts = p.completedAt ?? p.updatedAt;
          if (!latest) return ts;
          return ts > latest ? ts : latest;
        }, null);
        const status: 'completed' | 'in_progress' | 'not_started' =
          avgProgress >= 99
            ? 'completed'
            : avgProgress > 0
              ? 'in_progress'
              : 'not_started';

        coursesForStudent.push({
          course_id: cid,
          course_name: course?.title ?? '',
          total_chapters: course?._count?.chapters ?? 0,
          completed_chapters: progressEntries.filter(
            (p) => p.chapterId != null && p.completedAt != null,
          ).length,
          progress_percentage: Number(avgProgress.toFixed(2)),
          last_accessed: last ? last.toISOString() : '',
          enrolled_on:
            studentCourseForUser
              .find((sc) => sc.courseId === cid)
              ?.enrolledAt.toISOString() ?? '',
          status,
        });
      }

      const totalCourses = coursesForStudent.length;
      const completedCourses = coursesForStudent.filter(
        (c) => c.status === 'completed',
      ).length;
      const inProgressCourses = coursesForStudent.filter(
        (c) => c.status === 'in_progress',
      ).length;
      const avgStudentProgress =
        totalCourses > 0
          ? coursesForStudent.reduce(
              (sum, c) => sum + c.progress_percentage,
              0,
            ) / totalCourses
          : 0;
      const lastActivity = coursesForStudent.reduce<Date | null>(
        (latest, c) => {
          if (!c.last_accessed) return latest;
          const d = new Date(c.last_accessed);
          if (!latest || d > latest) return d;
          return latest;
        },
        null,
      );

      return {
        student_id: String(u.id),
        full_name: u.profile?.fullName ?? '',
        email: u.email,
        grade: primarySchool?.grade ?? '',
        section: primarySchool?.section ?? undefined,
        school_id: primarySchool?.schoolId,
        school_name: school?.name,
        total_courses: totalCourses,
        completed_courses: completedCourses,
        in_progress_courses: inProgressCourses,
        average_progress: Number(avgStudentProgress.toFixed(2)),
        courses: coursesForStudent,
        last_activity: lastActivity,
      };
    });

    // Page is already sliced at DB level; rename for clarity.
    const studentsDto = studentsDtoAll;

    const allCourseIds: string[] = Array.from(
      new Set<string>(studentCourses.map((sc) => sc.courseId)),
    );

    const coursesDto = allCourseIds.map((cid) => {
      const course = courseById.get(cid);
      const enrolled = studentCourses.filter((sc) => sc.courseId === cid);
      const enrolledStudentIds = new Set(enrolled.map((sc) => sc.studentId));
      let completedCount = 0;
      let sumProgress = 0;
      let countProgress = 0;

      for (const s of studentsDtoAll) {
        if (!enrolledStudentIds.has(Number(s.student_id))) continue;
        if (s.total_courses === 0) continue;
        const courseProgressEntry = s.courses.find((c) => c.course_id === cid);
        if (!courseProgressEntry) continue;
        sumProgress += courseProgressEntry.progress_percentage;
        countProgress += 1;
        if (courseProgressEntry.status === 'completed') {
          completedCount += 1;
        }
      }

      const enrolledCount = enrolledStudentIds.size;
      const averageProgress =
        countProgress > 0 ? sumProgress / countProgress : 0;
      const completionRate =
        enrolledCount > 0 ? (completedCount / enrolledCount) * 100 : 0;

      return {
        course_id: cid,
        course_name: course?.title ?? '',
        total_chapters: course?._count?.chapters ?? 0,
        enrolled_students: enrolledCount,
        completed_students: completedCount,
        average_progress: Number(averageProgress.toFixed(2)),
        completion_rate: Number(completionRate.toFixed(2)),
      };
    });

    const schoolsDtoMap = new Map<
      string,
      {
        school_id: string;
        school_name: string;
        total_students: number;
        sum_progress: number;
        count: number;
      }
    >();

    for (const s of studentsDtoAll) {
      if (!s.school_id) continue;
      const key = s.school_id;
      if (!schoolsDtoMap.has(key)) {
        schoolsDtoMap.set(key, {
          school_id: key,
          school_name: schoolById.get(key)?.name ?? '',
          total_students: 0,
          sum_progress: 0,
          count: 0,
        });
      }
      const entry = schoolsDtoMap.get(key)!;
      entry.total_students += 1;
      entry.sum_progress += s.average_progress;
      entry.count += 1;
    }

    const schoolsDto = Array.from(schoolsDtoMap.values()).map((s) => ({
      school_id: s.school_id,
      school_name: s.school_name,
      total_students: s.total_students,
      average_progress:
        s.count > 0 ? Number((s.sum_progress / s.count).toFixed(2)) : 0,
    }));

    // ── System-wide summary (NOT page-bound) ──────────────────────────────
    // studentsDtoAll above is only the current page, so every summary metric
    // except total_students must be computed with dedicated scope-aware queries
    // or the cards reflect just the 50 visible students.
    const hasStudentFilter = Boolean(schoolId || grade || studentId);
    const summaryStudentIds = hasStudentFilter
      ? (
          await this.db.user.findMany({
            where: studentWhere,
            select: { id: true },
          })
        ).map((u) => u.id)
      : null;
    const studentScope = summaryStudentIds
      ? { studentId: { in: summaryStudentIds } }
      : {};
    const courseScope = courseId ? { courseId } : {};

    const [
      totalSchoolsCount,
      totalCoursesCount,
      activeStudentGroups,
      enrolledStudentGroups,
      incompleteStudentGroups,
      perStudentAvg,
    ] = await Promise.all([
      schoolId ? Promise.resolve(1) : this.db.school.count(),
      this.db.course.count(),
      this.db.courseProgress.groupBy({
        by: ['studentId'],
        where: { progress: { gt: 0 }, ...studentScope, ...courseScope },
      }),
      this.db.studentCourse.groupBy({
        by: ['studentId'],
        where: { ...studentScope, ...courseScope },
      }),
      this.db.studentCourse.groupBy({
        by: ['studentId'],
        where: { completedAt: null, ...studentScope, ...courseScope },
      }),
      this.db.courseProgress.groupBy({
        by: ['studentId'],
        where: { ...studentScope, ...courseScope },
        _avg: { progress: true },
      }),
    ]);

    const activeStudentsCount = activeStudentGroups.length;
    const enrolledIds = new Set(enrolledStudentGroups.map((g) => g.studentId));
    const incompleteIds = new Set(
      incompleteStudentGroups.map((g) => g.studentId),
    );
    // A student "completed" all courses when they have enrollments and none
    // remain incomplete (StudentCourse.completedAt is the source of truth).
    const completedStudentsCount = [...enrolledIds].filter(
      (id) => !incompleteIds.has(id),
    ).length;
    const systemAvgProgress =
      totalStudents > 0
        ? perStudentAvg.reduce((sum, r) => sum + (r._avg.progress ?? 0), 0) /
          totalStudents
        : 0;

    return {
      students: studentsDto,
      schools: schoolsDto,
      courses: coursesDto,
      summary: {
        total_students: totalStudents,
        students_with_progress: activeStudentsCount,
        students_completed: completedStudentsCount,
        average_school_progress:
          schoolsDto.length > 0
            ? Number(
                (
                  schoolsDto.reduce((sum, s) => sum + s.average_progress, 0) /
                  schoolsDto.length
                ).toFixed(2),
              )
            : 0,
        average_system_progress: Number(systemAvgProgress.toFixed(2)),
        total_courses: totalCoursesCount,
        total_teachers: 0,
        total_schools: totalSchoolsCount,
      },
      pagination: {
        limit: take,
        offset: skip,
        total: totalStudents,
        hasMore: skip + take < totalStudents,
      },
    };
  }

  @Get('teacher-reports')
  async getTeacherReports(
    @Query('school_id') schoolId?: string,
    @Query('teacher_id') teacherIdParam?: string,
    @Query('grade') grade?: string,
    @Query('date') date?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    const where: {
      schoolId?: string;
      teacherId?: number;
      grade?: string;
      reportDate?: { gte?: Date; lte?: Date };
    } = {};

    if (schoolId) {
      where.schoolId = schoolId;
    }

    if (teacherIdParam) {
      const teacherId = parseInt(teacherIdParam, 10);
      if (!Number.isNaN(teacherId)) {
        where.teacherId = teacherId;
      }
    }

    if (grade) {
      where.grade = grade;
    }

    if (date) {
      const start = new Date(`${date}T00:00:00.000Z`);
      const end = new Date(`${date}T23:59:59.999Z`);
      where.reportDate = { gte: start, lte: end };
    } else if (from || to) {
      where.reportDate = {};
      if (from) where.reportDate.gte = new Date(`${from}T00:00:00.000Z`);
      if (to) where.reportDate.lte = new Date(`${to}T23:59:59.999Z`);
    }

    const take = limit
      ? Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500)
      : 100;

    const reports = await this.db.teacherReport.findMany({
      where,
      orderBy: { reportDate: 'desc' },
      take,
    });

    const teacherIds = Array.from(new Set(reports.map((r) => r.teacherId)));
    const schoolIds = Array.from(new Set(reports.map((r) => r.schoolId)));

    const [teachers, schools] = await Promise.all([
      teacherIds.length
        ? this.db.user.findMany({
            where: { id: { in: teacherIds } },
            include: { profile: true },
          })
        : Promise.resolve([] as any[]),
      schoolIds.length
        ? this.db.school.findMany({
            where: { id: { in: schoolIds } },
            select: { id: true, name: true, schoolCode: true },
          })
        : Promise.resolve([] as any[]),
    ]);

    const teacherMap = new Map<
      number,
      { id: number; full_name: string; email: string }
    >();
    for (const t of teachers) {
      teacherMap.set(t.id, {
        id: t.id,
        full_name: t.profile?.fullName ?? t.email ?? '',
        email: t.email ?? '',
      });
    }

    const schoolMap = new Map<
      string,
      { id: string; name: string; school_code: string | null }
    >();
    for (const s of schools) {
      schoolMap.set(s.id, {
        id: s.id,
        name: s.name,
        school_code: s.schoolCode ?? null,
      });
    }

    const searchLower = (search || '').trim().toLowerCase();

    const result = reports
      .map((r) => {
        const teacher = teacherMap.get(r.teacherId);
        const school = schoolMap.get(r.schoolId);
        const dateOnly = r.reportDate.toISOString().split('T')[0];
        return {
          id: r.id,
          teacher_id: String(r.teacherId),
          school_id: r.schoolId,
          date: dateOnly,
          grade: r.grade ?? '',
          topics_taught: r.topicsTaught ?? '',
          student_count: r.studentCount ?? 0,
          duration_hours: r.durationHours ?? 0,
          notes: r.notes ?? '',
          admin_notes: (r as any).adminNotes ?? '',
          status: r.status ?? 'submitted',
          created_at: r.createdAt.toISOString(),
          profiles: teacher
            ? {
                id: String(teacher.id),
                full_name: teacher.full_name,
                email: teacher.email,
              }
            : null,
          schools: school ?? null,
          teacher_name: teacher?.full_name ?? '',
          teacher_email: teacher?.email ?? '',
          school_name: school?.name ?? '',
          class_name: r.grade ?? '',
        };
      })
      .filter((report) => {
        if (!searchLower) return true;
        const haystack = [
          report.teacher_name,
          report.teacher_email,
          report.school_name,
          report.grade,
          report.topics_taught,
          report.notes,
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(searchLower);
      });

    return { reports: result };
  }

  @Patch('teacher-reports')
  async updateTeacherReport(
    @Body() body: { id: string; status?: string; admin_notes?: string },
  ) {
    const { id, status, admin_notes } = body ?? {};
    if (!id) throw new BadRequestException('id is required');

    const allowed = ['submitted', 'reviewed', 'approved', 'rejected'];
    if (status && !allowed.includes(status)) {
      throw new BadRequestException(
        `status must be one of: ${allowed.join(', ')}`,
      );
    }

    const data: Record<string, unknown> = {};
    if (status) data.status = status;
    if (admin_notes !== undefined) data.adminNotes = admin_notes;

    const updated = await this.db.teacherReport.update({
      where: { id },
      data,
    });

    return {
      success: true,
      report: {
        id: updated.id,
        status: updated.status,
        notes: updated.notes,
        admin_notes: (updated as any).adminNotes ?? '',
      },
    };
  }


  @Get('cache-monitor')
  getCacheMonitor() {
    // If a real Redis-backed cache tracker exists, it can be wired here.
    // Returning a stable shape keeps the admin monitoring UI functional.
    return {
      success: true,
      cacheHitRate: 0,
      checked_at: new Date().toISOString(),
    };
  }

  @Post('warm-cache')
  warmCache() {
    return {
      success: true,
      warmed_at: new Date().toISOString(),
    };
  }

  // Settings & security

  @Get('settings')
  async getSettings() {
    const rows = await this.db.systemSetting.findMany({
      orderBy: { key: 'asc' },
      take: 500,
    });
    const settings: Record<string, string> = {};
    for (const r of rows) settings[r.key] = r.value;
    return { settings };
  }

  @Post('settings')
  async updateSettings(@Body() body: Record<string, unknown>) {
    const entries = Object.entries(body || {}).filter(
      ([k]) => k !== 'settings',
    );
    if (entries.length === 0) return { success: true };
    for (const [key, value] of entries) {
      const k = String(key).trim();
      if (!k) continue;
      await this.db.systemSetting.upsert({
        where: { key: k },
        create: { key: k, value: String(value ?? '') },
        update: { value: String(value ?? '') },
      });
    }
    return { success: true };
  }

  @Patch('settings')
  async patchSettings(@Body() body: Record<string, unknown>) {
    // Alias to keep frontend/back route method alignment (PATCH -> same behavior).
    return this.updateSettings(body);
  }

  @Post('settings/export')
  async exportSettings() {
    const [schools, users, courses, settings] = await Promise.all([
      this.db.school.findMany({ take: 2000, orderBy: { createdAt: 'desc' } }),
      this.db.user.findMany({
        take: 2000,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
      }),
      this.db.course.findMany({ take: 2000, orderBy: { createdAt: 'desc' } }),
      this.db.systemSetting.findMany({ take: 2000, orderBy: { key: 'asc' } }),
    ]);
    return {
      export: {
        schools,
        users,
        courses,
        settings,
      },
      exported_at: new Date().toISOString(),
    };
  }

  @Get('settings/export')
  async exportSettingsGet() {
    return this.exportSettings();
  }

  @Post('settings/backup')
  async backupSettings() {
    const snapshot = await this.exportSettings();
    await this.db.systemSetting.upsert({
      where: { key: 'backup:last' },
      create: { key: 'backup:last', value: JSON.stringify(snapshot) },
      update: { value: JSON.stringify(snapshot) },
    });
    return { message: 'Backup snapshot saved.' };
  }

  @Post('settings/cleanup')
  async cleanupSettings() {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 30);
    // Only hard-delete inactive users who have NO active school relations.
    // Users that were soft-deactivated by a school admin (isActive=false on StudentSchool)
    // still have a StudentSchool row — they are excluded here to prevent silent data loss.
    // A school admin must explicitly hard-delete a student to remove them permanently.
    const res = await this.db.user.deleteMany({
      where: {
        isActive: false,
        role: { not: Role.admin },
        createdAt: { lt: cutoff },
        studentSchools: { none: {} }, // no school enrollment at all
        teacherSchools: { none: {} }, // not assigned to any school
        schoolAdmins: { none: {} }, // not a school admin
      },
    });
    return { cleaned: res.count };
  }

  @Patch('settings/notifications')
  async updateNotificationSettings(@Body() body: Record<string, unknown>) {
    await this.db.systemSetting.upsert({
      where: { key: 'settings:notifications' },
      create: {
        key: 'settings:notifications',
        value: JSON.stringify(body ?? {}),
      },
      update: { value: JSON.stringify(body ?? {}) },
    });
    return { success: true };
  }

  @Get('security')
  async getSecurityOverview(@CurrentUser() user: { id: number }) {
    const enabled = await this.db.systemSetting.findUnique({
      where: { key: `mfa:enabled:${user.id}` },
    });
    const lastLogin = await this.db.systemSetting.findUnique({
      where: { key: `security:last_login:${user.id}` },
    });
    const failed = await this.db.systemSetting.findUnique({
      where: { key: `security:failed_login_attempts:${user.id}` },
    });
    return {
      last_login: lastLogin?.value ?? null,
      failed_login_attempts: failed?.value
        ? parseInt(failed.value, 10) || 0
        : 0,
      mfa_enabled: !!enabled?.value,
    };
  }

  @Post('security/mfa')
  async configureMfa(
    @CurrentUser() user: { id: number; email?: string },
    @Body() body: { action?: string; code?: string; factorId?: string },
  ) {
    const action = String(body?.action ?? '')
      .trim()
      .toLowerCase();
    if (action === 'disable') {
      await this.db.systemSetting
        .delete({ where: { key: `mfa:enabled:${user.id}` } })
        .catch(() => {});
      return { success: true };
    }

    if (action === 'enable') {
      const secret = generateSecret();
      const factorId = randomUUID();
      const account = user.email || `user-${user.id}`;
      const otpauth = generateURI({
        secret,
        label: account,
        issuer: 'Yugminds',
      });
      const qr_code = await QRCode.toDataURL(otpauth, {
        margin: 1,
        width: 256,
      });
      await this.db.systemSetting.upsert({
        where: { key: `mfa:pending:${user.id}:${factorId}` },
        create: { key: `mfa:pending:${user.id}:${factorId}`, value: secret },
        update: { value: secret },
      });
      return { qr_code, secret, factorId };
    }

    // verify
    const code = String(body?.code ?? '').trim();
    const factorId = String(body?.factorId ?? '').trim();
    if (!code || !factorId)
      throw new BadRequestException('code and factorId are required');

    const pending = await this.db.systemSetting.findUnique({
      where: { key: `mfa:pending:${user.id}:${factorId}` },
    });
    if (!pending?.value)
      throw new BadRequestException('MFA enrollment not found');

    const ok = await Promise.resolve(
      verify({ token: code, secret: pending.value }),
    );
    if (!ok) throw new BadRequestException('Invalid verification code');

    await this.db.systemSetting.upsert({
      where: { key: `mfa:enabled:${user.id}` },
      create: { key: `mfa:enabled:${user.id}`, value: pending.value },
      update: { value: pending.value },
    });
    await this.db.systemSetting
      .delete({ where: { key: `mfa:pending:${user.id}:${factorId}` } })
      .catch(() => {});
    return { success: true };
  }

  @Delete('security/mfa')
  async unenrollMfa(
    @CurrentUser() user: { id: number },
    @Query('factorId') factorId?: string,
  ) {
    // For compatibility: remove pending factor and/or enabled MFA.
    if (factorId) {
      await this.db.systemSetting
        .delete({
          where: { key: `mfa:pending:${user.id}:${String(factorId)}` },
        })
        .catch(() => {});
    }
    await this.db.systemSetting
      .delete({ where: { key: `mfa:enabled:${user.id}` } })
      .catch(() => {});
    return { success: true };
  }

  // Notifications – list (sent/received), create (broadcast), recipients

  @SkipThrottle({ default: true })
  @Get('notifications')
  async listNotifications(
    @CurrentUser() user: { id: number },
    @Query('limit') limit?: string,
    @Query('mode') mode?: string,
  ) {
    const take = Math.min(
      Math.max(parseInt(limit ?? '50', 10) || 50, 1),
      100,
    );
    const m = mode === 'sent' ? 'sent' : 'received';
    const notifications = await this.notificationsService.listWithProfiles(
      user.id,
      { mode: m, limit: take, excludePasswordReset: m === 'received' },
    );
    return { notifications };
  }

  @Post('notifications')
  async createNotification(
    @CurrentUser() user: { id: number },
    @Body()
    body: {
      title?: string;
      message?: string;
      type?: string;
      recipientType?: string;
      recipients?: string[];
      allowReplies?: boolean;
    },
  ) {
    const title = String(body?.title ?? '').trim();
    const message = String(body?.message ?? '').trim();
    if (!title || !message)
      throw new BadRequestException('Title and message are required');

    const recipientType = body?.recipientType ?? 'all';
    const recipients = Array.isArray(body?.recipients) ? body.recipients : [];
    let userIds: number[] = [];

    if (recipientType === 'all') {
      const users = await this.db.user.findMany({
        where: { id: { not: user.id }, isActive: true },
        select: { id: true },
      });
      userIds = users.map((u) => u.id);
    } else if (recipientType === 'role') {
      const roleFilters: Record<string, () => Promise<number[]>> = {
        'role:teacher': async () =>
          (
            await this.db.user.findMany({
              where: { role: Role.teacher, isActive: true },
              select: { id: true },
            })
          ).map((u) => u.id),
        'role:student': async () =>
          (
            await this.db.user.findMany({
              where: { role: Role.student, isActive: true },
              select: { id: true },
            })
          ).map((u) => u.id),
        'role:admin': async () =>
          (
            await this.db.user.findMany({
              where: { role: Role.admin, isActive: true },
              select: { id: true },
            })
          ).map((u) => u.id),
        'role:school_admin': async () => {
          const saIds = (
            await this.db.schoolAdmin.findMany({ select: { userId: true } })
          ).map((sa) => sa.userId);
          return (
            await this.db.user.findMany({
              where: {
                role: Role.school_admin,
                isActive: true,
                id: { in: saIds },
              },
              select: { id: true },
            })
          ).map((u) => u.id);
        },
      };
      const results = await Promise.all(
        recipients
          .filter((r) => r in roleFilters)
          .map((r) => roleFilters[r]()),
      );
      userIds = results.flat();
    } else if (recipientType === 'school') {
      const schoolResults = await Promise.all(
        recipients.map(async (schoolId) => {
          const [teacherIds, studentIds, adminIds] = await Promise.all([
            this.db.teacherSchool.findMany({
              where: { schoolId },
              select: { teacherId: true },
            }),
            this.db.studentSchool.findMany({
              where: { schoolId },
              select: { studentId: true },
            }),
            this.db.schoolAdmin.findMany({
              where: { schoolId },
              select: { userId: true },
            }),
          ]);
          return [
            ...teacherIds.map((t) => t.teacherId),
            ...studentIds.map((s) => s.studentId),
            ...adminIds.map((a) => a.userId),
          ];
        }),
      );
      userIds = schoolResults.flat();
    } else if (recipientType === 'individual') {
      const parsedIds = recipients
        .map((id) => parseInt(id, 10))
        .filter((n) => !Number.isNaN(n));
      const activeUsers = await this.db.user.findMany({
        where: { id: { in: parsedIds }, isActive: true },
        select: { id: true },
      });
      userIds = activeUsers.map((u) => u.id);
    }

    const { sent } = await this.notificationsService.sendBroadcast(
      user.id,
      userIds,
      {
        title,
        message,
        type: body?.type,
        allowReplies: body?.allowReplies,
      },
    );
    return { recipients: sent, success: true };
  }

  @Get('notifications/recipients')
  async listNotificationRecipients() {
    const schoolAdminUserIds = (
      await this.db.schoolAdmin.findMany({ select: { userId: true } })
    ).map((sa) => sa.userId);

    const [teacherCount, studentCount, schoolAdminCount, adminCount] =
      await Promise.all([
        this.db.user.count({ where: { role: Role.teacher, isActive: true } }),
        this.db.user.count({ where: { role: Role.student, isActive: true } }),
        this.db.user.count({
          where: {
            role: Role.school_admin,
            isActive: true,
            id: { in: schoolAdminUserIds },
          },
        }),
        this.db.user.count({ where: { role: Role.admin, isActive: true } }),
      ]);

    const roles = [
      teacherCount > 0
        ? { id: 'role:teacher', name: 'All Teachers', count: teacherCount }
        : null,
      studentCount > 0
        ? { id: 'role:student', name: 'All Students', count: studentCount }
        : null,
      schoolAdminCount > 0
        ? { id: 'role:school_admin', name: 'All School Admins', count: schoolAdminCount }
        : null,
      adminCount > 0
        ? { id: 'role:admin', name: 'All Admins', count: adminCount }
        : null,
    ].filter((r): r is { id: string; name: string; count: number } => r !== null);

    const [schools, users] = await Promise.all([
      this.db.school.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.db.user.findMany({
        where: {
          isActive: true,
          OR: [
            { role: { not: Role.school_admin } },
            { role: Role.school_admin, id: { in: schoolAdminUserIds } },
          ],
        },
        take: 500,
        include: { profile: { select: { fullName: true } } },
      }),
    ]);

    return {
      roles,
      schools: schools.map((s) => ({ id: s.id, name: s.name })),
      users: users.map((u) => ({
        id: String(u.id),
        name: u.profile?.fullName ?? u.email ?? '',
        email: u.email,
        role: u.role,
      })),
    };
  }

  // Reports

  @Get('reports')
  async getReports(@Query() query: Record<string, string>, @Res() res: any) {
    const type = String(query.type ?? 'system').trim() || 'system';
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10);

    const titleMap: Record<string, string> = {
      schools: 'Schools Report',
      teachers: 'Teacher Performance Report',
      students: 'Student Enrollment Report',
      courses: 'Course Progress Report',
    };
    const title = titleMap[type] ?? 'System Report';

    // ── Parse filter IDs from query params ────────────────────────────────────
    const parseIds = (raw: string | undefined): string[] | undefined => {
      if (!raw || !raw.trim()) return undefined;
      const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
      return ids.length > 0 ? ids : undefined;
    };

    const filterSchoolIds   = parseIds(query.school_ids);
    const filterTeacherIds  = parseIds(query.teacher_ids);
    const filterStudentIds  = parseIds(query.student_ids);
    const filterCourseIds   = parseIds(query.course_ids);

    // ── Resolve human-readable filter labels for PDF display ─────────────────
    const humanFilters: Record<string, string> = {};
    try {
      if (filterSchoolIds) {
        const schools = await this.db.school.findMany({
          where: { id: { in: filterSchoolIds } },
          select: { name: true },
        });
        humanFilters['Schools'] = schools.map((s) => s.name).join(', ');
      }
    } catch { /* non-critical */ }

    // ── Scoped summary counts ─────────────────────────────────────────────────
    let schoolCount = 0, teacherCount = 0, studentCount = 0, courseCount = 0;
    try {
      [schoolCount, teacherCount, studentCount, courseCount] = await Promise.all([
        this.db.school.count({
          where: {
            isActive: true,
            ...(filterSchoolIds ? { id: { in: filterSchoolIds } } : {}),
          },
        }),
        this.db.user.count({
          where: {
            role: Role.teacher,
            isActive: true,
            ...(filterTeacherIds ? { id: { in: filterTeacherIds.map(Number) } } : {}),
            ...(filterSchoolIds && !filterTeacherIds
              ? { teacherSchools: { some: { schoolId: { in: filterSchoolIds } } } }
              : {}),
          },
        }),
        this.db.user.count({
          where: {
            role: Role.student,
            isActive: true,
            ...(filterStudentIds ? { id: { in: filterStudentIds.map(Number) } } : {}),
            ...(filterSchoolIds && !filterStudentIds
              ? { studentSchools: { some: { schoolId: { in: filterSchoolIds } } } }
              : {}),
          },
        }),
        this.db.course.count({
          where: {
            isPublished: true,
            ...(filterCourseIds ? { id: { in: filterCourseIds } } : {}),
          },
        }),
      ]);
    } catch { /* keep zero counts */ }

    const summaryStats = [
      { label: 'Schools', value: schoolCount },
      { label: 'Teachers', value: teacherCount },
      { label: 'Students', value: studentCount },
      { label: 'Courses', value: courseCount },
    ];

    // ── Fetch per-type detailed rows (with filters applied) ───────────────────
    let tableColumns: string[] = [];
    let tableRows: string[][] = [];

    try {
      if (type === 'schools') {
        tableColumns = ['#', 'School Name', 'Code', 'Status', 'Registered On'];
        const schools = await this.db.school.findMany({
          where: {
            ...(filterSchoolIds ? { id: { in: filterSchoolIds } } : {}),
          },
          orderBy: { name: 'asc' },
          take: 500,
          select: { id: true, name: true, schoolCode: true, isActive: true, createdAt: true },
        });
        tableRows = schools.map((s, i) => [
          String(i + 1),
          s.name,
          s.schoolCode ?? '—',
          s.isActive ? 'Active' : 'Inactive',
          s.createdAt ? new Date(s.createdAt).toLocaleDateString('en-IN') : '—',
        ]);
      } else if (type === 'teachers') {
        tableColumns = ['#', 'Name', 'School', 'Classes Taught', 'Attendance', 'Avg Students/Class', 'Leaves Taken', 'Status'];

        const teacherWhere: any = {
          role: Role.teacher,
          ...(filterTeacherIds ? { id: { in: filterTeacherIds.map(Number) } } : {}),
          ...(filterSchoolIds && !filterTeacherIds
            ? { teacherSchools: { some: { schoolId: { in: filterSchoolIds } } } }
            : {}),
        };

        const teachers = await this.db.user.findMany({
          where: teacherWhere,
          orderBy: { createdAt: 'desc' },
          take: 500,
          select: {
            id: true,
            email: true,
            isActive: true,
            createdAt: true,
            profile: { select: { fullName: true } },
            teacherSchools: { take: 1, select: { schoolId: true, school: { select: { name: true } } } },
          },
        });

        const teacherIds = teachers.map((t) => t.id);

        // Fetch performance data in parallel for all teachers
        const schoolIdFilter = filterSchoolIds ?? undefined;
        const [reportAgg, attendanceAgg, leaveAgg] = await Promise.all([
          // TeacherReport: count of reports (classes taught) + avg student count per teacher
          this.db.teacherReport.groupBy({
            by: ['teacherId'],
            where: {
              teacherId: { in: teacherIds },
              ...(schoolIdFilter ? { schoolId: { in: schoolIdFilter } } : {}),
            },
            _count: { id: true },
            _avg: { studentCount: true },
          }),
          // Attendance: count present days per teacher
          this.db.attendance.groupBy({
            by: ['teacherId'],
            where: {
              teacherId: { in: teacherIds },
              status: 'present',
              ...(schoolIdFilter ? { schoolId: { in: schoolIdFilter } } : {}),
            },
            _count: { id: true },
          }),
          // TeacherLeave: count approved leaves per teacher
          this.db.teacherLeave.groupBy({
            by: ['teacherId'],
            where: {
              teacherId: { in: teacherIds },
              status: 'approved',
              ...(schoolIdFilter ? { schoolId: { in: schoolIdFilter } } : {}),
            },
            _count: { id: true },
          }),
        ]);

        // Build lookup maps
        const reportMap = new Map(reportAgg.map((r: any) => [r.teacherId, r]));
        const attendMap = new Map(attendanceAgg.map((r: any) => [r.teacherId, r._count.id]));
        const leaveMap  = new Map(leaveAgg.map((r: any) => [r.teacherId, r._count.id]));

        tableRows = teachers.map((t, i) => {
          const rep   = reportMap.get(t.id) as any;
          const classesTaught = rep?._count?.id ?? 0;
          const avgStudents   = rep?._avg?.studentCount != null
            ? Math.round(rep._avg.studentCount)
            : '—';
          const presentDays   = attendMap.get(t.id) ?? 0;
          const leavesTaken   = leaveMap.get(t.id) ?? 0;

          return [
            String(i + 1),
            (t as any).profile?.fullName ?? t.email ?? '—',
            (t as any).teacherSchools?.[0]?.school?.name ?? '—',
            String(classesTaught),
            presentDays > 0 ? `${presentDays} days` : '—',
            String(avgStudents),
            String(leavesTaken),
            t.isActive ? 'Active' : 'Inactive',
          ];
        });
      } else if (type === 'students') {
        tableColumns = ['#', 'Name', 'Email', 'School', 'Grade', 'Section', 'Enrolled On'];
        const students = await this.db.user.findMany({
          where: {
            role: Role.student,
            ...(filterStudentIds ? { id: { in: filterStudentIds.map(Number) } } : {}),
            ...(filterSchoolIds && !filterStudentIds
              ? { studentSchools: { some: { schoolId: { in: filterSchoolIds } } } }
              : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: 500,
          select: {
            id: true,
            email: true,
            createdAt: true,
            profile: { select: { fullName: true } },
            studentSchools: {
              take: 1,
              select: {
                grade: true,
                section: true,
                school: { select: { name: true } },
              },
            },
          },
        });
        tableRows = students.map((s, i) => {
          const ss = (s as any).studentSchools?.[0];
          return [
            String(i + 1),
            (s as any).profile?.fullName ?? s.email ?? '—',
            s.email ?? '—',
            ss?.school?.name ?? '—',
            ss?.grade ?? '—',
            ss?.section ?? '—',
            s.createdAt ? new Date(s.createdAt).toLocaleDateString('en-IN') : '—',
          ];
        });
      } else if (type === 'courses') {
        tableColumns = ['#', 'Course Title', 'Status', 'School Access', 'Published On'];
        const courses = await this.db.course.findMany({
          where: {
            ...(filterCourseIds ? { id: { in: filterCourseIds } } : {}),
            ...(filterSchoolIds && !filterCourseIds
              ? { courseAccess: { some: { schoolId: { in: filterSchoolIds } } } }
              : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: 500,
          select: {
            id: true,
            title: true,
            isPublished: true,
            createdAt: true,
            _count: { select: { courseAccess: true } },
          },
        });
        tableRows = courses.map((c, i) => [
          String(i + 1),
          c.title ?? '—',
          c.isPublished ? 'Published' : 'Draft',
          String((c as any)._count?.courseAccess ?? 0),
          c.createdAt ? new Date(c.createdAt).toLocaleDateString('en-IN') : '—',
        ]);
      }
    } catch (err) {
      console.error('Report data fetch error:', err);
    }

    const pdf = await this.buildStyledPdf({
      title,
      subtitle: `${title} — ${now.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`,
      generatedAt: now,
      filters: Object.keys(humanFilters).length > 0 ? humanFilters : {},
      summaryStats,
      tableColumns,
      tableRows,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${type}-report-${datePart}.pdf"`,
    );
    return res.send(pdf);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /** Reads image dimensions from raw buffer without any extra dependency.
   *  Returns null for SVG (no pixel dimensions) or unrecognised formats. */
  private readImageDims(
    buffer: Buffer,
    mimetype: string,
  ): { w: number; h: number } | null {
    if (mimetype === 'image/svg+xml') return null;
    if (mimetype === 'image/png') {
      // PNG: bytes 16-19 = width, 20-23 = height (big-endian)
      if (buffer.length < 24) return null;
      return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20) };
    }
    if (mimetype === 'image/jpeg') {
      // Scan JPEG for SOF0/SOF2 markers (0xFF C0 / 0xFF C2)
      let i = 2;
      while (i < buffer.length - 8) {
        if (buffer[i] !== 0xff) break;
        const marker = buffer[i + 1];
        const len = buffer.readUInt16BE(i + 2);
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          marker === 0xc9 ||
          (marker >= 0xca && marker <= 0xcf)
        ) {
          return {
            w: buffer.readUInt16BE(i + 7),
            h: buffer.readUInt16BE(i + 5),
          };
        }
        i += 2 + len;
      }
      return null;
    }
    return null;
  }

  // Logos

  @Get('logos')
  async listLogos(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const take = limit
      ? Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100)
      : 20;
    const skip = offset ? Math.max(parseInt(offset, 10) || 0, 0) : 0;
    const [logos, total] = await Promise.all([
      this.db.logo.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.db.logo.count({ where: { deletedAt: null } }),
    ]);
    const data = logos.map((l) => ({
      id: l.id,
      school_id: (l as any).schoolId ?? null,
      school_name: l.schoolName,
      description: l.description,
      image_url: l.imageUrl,
      upload_date: l.createdAt.toISOString(),
    }));
    return { data, total };
  }

  @Post('logos')
  @UseInterceptors(FileInterceptor('file'))
  async createLogo(
    @UploadedFile() file: any,
    @Body()
    body: { school_name?: string; school_id?: string; description?: string },
  ) {
    let schoolName = (body?.school_name ?? '').trim();
    const schoolId = (body?.school_id ?? '').trim() || null;
    let schoolNumber: number | null = null;

    // Resolve school name from school_id when provided
    if (schoolId) {
      const school = await this.db.school.findUnique({
        where: { id: schoolId },
        select: { name: true, schoolNumber: true },
      });
      if (!school) throw new BadRequestException('School not found');
      schoolName = school.name;
      schoolNumber = school.schoolNumber;
    }

    if (!schoolName) {
      throw new BadRequestException('school_id or school_name is required');
    }
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (!['image/png', 'image/jpeg', 'image/svg+xml'].includes(file.mimetype)) {
      throw new BadRequestException('Only JPG, PNG, SVG allowed');
    }
    if (file.size > 2 * 1024 * 1024) {
      throw new BadRequestException('Max file size is 2MB');
    }
    const dims = this.readImageDims(
      file.buffer as Buffer,
      file.mimetype as string,
    );
    if (dims && (dims.w < 300 || dims.h < 300)) {
      throw new BadRequestException('Minimum image dimensions are 300×300 px');
    }
    const logoKey = this.storage.buildKey(
      `logos/${schoolNumber ?? 'unassigned'}`,
      file.originalname ?? 'logo.png',
    );
    const imageUrl = await this.storage.uploadBuffer(
      logoKey,
      file.buffer,
      file.mimetype,
    );
    const logo = await this.db.logo.create({
      data: {
        schoolName,
        schoolId,
        description: body?.description?.trim() || null,
        imageUrl,
        imageKey: logoKey,
      } as any,
    });
    return {
      id: logo.id,
      school_id: (logo as any).schoolId ?? null,
      school_name: logo.schoolName,
      description: logo.description,
      image_url: logo.imageUrl,
      upload_date: logo.createdAt.toISOString(),
    };
  }

  @Get('logos/:id')
  async getLogo(@Param('id') id: string) {
    const logo = await this.db.logo.findUnique({ where: { id } });
    if (!logo || logo.deletedAt) {
      throw new BadRequestException('Logo not found');
    }
    return {
      id: logo.id,
      school_name: logo.schoolName,
      description: logo.description,
      image_url: logo.imageUrl,
      upload_date: logo.createdAt.toISOString(),
    };
  }

  @Put('logos/:id')
  @UseInterceptors(FileInterceptor('file'))
  async updateLogo(
    @Param('id') id: string,
    @UploadedFile() file: any,
    @Body()
    body: {
      school_name?: string;
      school_id?: string;
      description?: string;
      replace_image?: string;
    },
  ) {
    const existing = await this.db.logo.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new BadRequestException('Logo not found');
    }
    const existingSchoolNumber = existing.schoolId
      ? (
          await this.db.school.findUnique({
            where: { id: existing.schoolId },
            select: { schoolNumber: true },
          })
        )?.schoolNumber
      : null;
    const data: {
      schoolName?: string;
      schoolId?: string | null;
      description?: string | null;
      imageUrl?: string;
      imageKey?: string;
    } = {};
    const newSchoolId = (body?.school_id ?? '').trim() || null;
    if (newSchoolId !== null) {
      const school = await this.db.school.findUnique({
        where: { id: newSchoolId },
        select: { name: true },
      });
      if (!school) throw new BadRequestException('School not found');
      data.schoolName = school.name;
      data.schoolId = newSchoolId;
    } else if (body?.school_name !== undefined) {
      const name = body.school_name.trim();
      if (!name) throw new BadRequestException('school_name cannot be empty');
      data.schoolName = name;
    }
    if (body?.description !== undefined) {
      const desc = body.description.trim();
      data.description = desc || null;
    }
    const wantsReplace = body?.replace_image === 'true';
    if (wantsReplace) {
      if (!file)
        throw new BadRequestException(
          'file is required when replace_image=true',
        );
      if (
        !['image/png', 'image/jpeg', 'image/svg+xml'].includes(file.mimetype)
      ) {
        throw new BadRequestException('Only JPG, PNG, SVG allowed');
      }
      if (file.size > 2 * 1024 * 1024) {
        throw new BadRequestException('Max file size is 2MB');
      }
      const dims = this.readImageDims(
        file.buffer as Buffer,
        file.mimetype as string,
      );
      if (dims && (dims.w < 300 || dims.h < 300)) {
        throw new BadRequestException(
          'Minimum image dimensions are 300×300 px',
        );
      }
      const logoKey = this.storage.buildKey(
        `logos/${existingSchoolNumber ?? 'unassigned'}`,
        file.originalname ?? 'logo.png',
      );
      data.imageUrl = await this.storage.uploadBuffer(
        logoKey,
        file.buffer,
        file.mimetype,
      );
      data.imageKey = logoKey;
    }
    const oldLogoKey = wantsReplace ? existing.imageKey : null;
    const updated = await this.db.logo.update({
      where: { id },
      data: data as any,
    });
    if (oldLogoKey) {
      await this.storage.deleteObject(oldLogoKey).catch(() => {});
    }
    return {
      id: updated.id,
      school_id: (updated as any).schoolId ?? null,
      school_name: updated.schoolName,
      description: updated.description,
      image_url: updated.imageUrl,
      upload_date: updated.createdAt.toISOString(),
    };
  }

  @Delete('logos/:id')
  async deleteLogo(@Param('id') id: string, @Query('hard') hard?: string) {
    const logo = await this.db.logo.findUnique({ where: { id } });
    if (!logo) {
      throw new BadRequestException('Logo not found');
    }
    const hardDelete = hard === 'true' || hard === '1';
    if (hardDelete) {
      await this.db.logo.delete({ where: { id } });
      if (logo.imageKey) {
        await this.storage.deleteObject(logo.imageKey).catch(() => {});
      }
    } else {
      await this.db.logo.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    }
    return { success: true };
  }

  // Password reset requests

  @SkipThrottle({ default: true })
  @Get('password-reset-requests/pending-count')
  async pendingPasswordResetCount() {
    const count = await this.db.passwordResetRequest.count({
      where: { status: 'pending' },
    });
    return { count };
  }

  @Get('password-reset-requests')
  async listPasswordResetRequests(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.passwordResetRequestService.list({
      status: status || undefined,
      limit: limit ? Math.min(parseInt(limit, 10) || 100, 200) : 100,
    });
  }

  @Patch('password-reset-requests')
  async updatePasswordResetRequests(
    @CurrentUser() currentUser: { id: number },
    @Body()
    body: {
      id?: string;
      status?: string;
      notes?: string;
      approved_by?: string;
      temp_password?: string;
    },
  ) {
    return this.passwordResetRequestService.update({
      id: String(body?.id ?? '').trim(),
      status: String(body?.status ?? '').trim(),
      notes: body?.notes,
      approved_by: body?.approved_by ?? String(currentUser.id),
      temp_password: body?.temp_password,
    });
  }

  @Delete('password-reset-requests')
  async deletePasswordResetRequests(@Query('id') id?: string) {
    await this.passwordResetRequestService.delete(String(id ?? '').trim());
    return { success: true };
  }

  // Teacher attendance: implemented in AdminTeacherAttendanceController

  // Leaves: implemented in AdminLeavesController

  // Data maintenance

  @Post('restore-all-data')
  restoreAllData() {
    // Safety: this is intentionally a no-op restore hook in this deployment.
    // If you need actual restore/backfill, implement it in a dedicated service.
    return { success: true, restored_at: new Date().toISOString() };
  }

  // Certificates admin

  @Post('certificates/generate-all-eligible')
  async generateAllEligibleCertificates(
    @CurrentUser() user: { id: number },
  ) {
    // Delegates to batchGenerateCertificates with no filters = all students, all courses.
    return this.batchGenerateCertificates(user, { dry_run: false });
  }

  @Post('certificates/batch-generate')
  async batchGenerateCertificates(
    @CurrentUser() user: { id: number },
    @Body() dto: BatchGenerateCertificatesDto,
  ) {
    const courseIds = Array.isArray(dto?.course_ids)
      ? dto.course_ids.filter(Boolean)
      : [];
    const studentIds = Array.isArray(dto?.student_ids)
      ? dto.student_ids
          .map((id) => parseInt(String(id), 10))
          .filter((id) => Number.isFinite(id) && id > 0)
      : [];
    const dryRun = Boolean(dto?.dry_run);

    const studentsWhere: { id?: { in: number[] }; role: Role } = {
      role: Role.student,
    };
    if (studentIds.length > 0) studentsWhere.id = { in: studentIds };
    const students = await this.db.user.findMany({
      where: studentsWhere,
      select: { id: true, email: true },
      take: 5000,
    });
    if (students.length === 0) {
      return { success: true, dry_run: dryRun, generated: 0, skipped: 0 };
    }

    const enrollments = await this.db.studentCourse.findMany({
      where: {
        studentId: { in: students.map((s) => s.id) },
        ...(courseIds.length > 0 ? { courseId: { in: courseIds } } : {}),
      },
      select: { studentId: true, courseId: true },
      take: 20000,
    });
    const pairs = enrollments.map((e) => ({
      studentId: e.studentId,
      courseId: e.courseId,
    }));
    if (pairs.length === 0) {
      return { success: true, dry_run: dryRun, generated: 0, skipped: 0 };
    }

    const existing = await this.db.studentCertificate.findMany({
      where: {
        OR: pairs.map((p) => ({
          studentId: p.studentId,
          courseId: p.courseId,
        })),
      },
      select: { studentId: true, courseId: true },
      take: 20000,
    });
    const existingSet = new Set(
      existing.map((e) => `${e.studentId}:${e.courseId}`),
    );
    const toCreate = pairs.filter(
      (p) => !existingSet.has(`${p.studentId}:${p.courseId}`),
    );

    if (!dryRun) {
      // Load custom template once for all certificates
      const templateSetting = await this.db.systemSetting.findUnique({
        where: { key: 'certificate:template' },
      });

      // Load student profiles and course titles for SVG generation
      const studentIds = [...new Set(toCreate.map((r) => r.studentId))];
      const courseIds = [...new Set(toCreate.map((r) => r.courseId))];
      const [profiles, courses] = await Promise.all([
        this.db.profile.findMany({
          where: { userId: { in: studentIds } },
          select: { userId: true, fullName: true },
        }),
        this.db.course.findMany({
          where: { id: { in: courseIds } },
          select: { id: true, title: true },
        }),
      ]);
      const profileMap = new Map(
        profiles.map((p) => [p.userId, p.fullName ?? '']),
      );
      const courseMap = new Map(courses.map((c) => [c.id, c.title]));

      for (const row of toCreate) {
        const studentName = profileMap.get(row.studentId) || 'Student';
        const courseTitle = courseMap.get(row.courseId) || 'Course';
        const issuedAt = new Date().toISOString().split('T')[0];
        const certificateName = `${courseTitle} Certificate`;

        // Create first to get the ID for embedding
        const created = await this.db.studentCertificate.create({
          data: {
            studentId: row.studentId,
            courseId: row.courseId,
            certificateName,
            certificateUrl: 'pending',
            issuedBy: user.id,
          },
        });
        const svg = StudentExtraController.buildCertificateSvg(
          { studentName, courseTitle, issuedAt, certificateId: created.id },
          templateSetting?.value ?? null,
        );
        const jpegBuffer = await StudentExtraController.svgToJpegBuffer(svg);
        const certKey = this.storage.buildKey(
          `certificates/${row.studentId}`,
          `${created.id}.jpg`,
        );
        const certUrl = await this.storage.uploadBuffer(
          certKey,
          jpegBuffer,
          'image/jpeg',
        );
        await this.db.studentCertificate.update({
          where: { id: created.id },
          data: { certificateUrl: certUrl, certificateKey: certKey },
        });
      }
    }

    return {
      success: true,
      dry_run: dryRun,
      generated: toCreate.length,
      skipped: pairs.length - toCreate.length,
    };
  }

  // ─── Admin Certificate Management ───────────────────────────────────────────

  @Get('certificates')
  async listAllCertificates(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    const take = Math.min(parseInt(limit ?? '50', 10) || 50, 200);
    const skip = (Math.max(parseInt(page ?? '1', 10) || 1, 1) - 1) * take;

    const where: Record<string, unknown> = {};
    if (search) {
      where.OR = [
        { certificateName: { contains: search, mode: 'insensitive' } },
        { student: { email: { contains: search, mode: 'insensitive' } } },
        {
          student: {
            profile: { fullName: { contains: search, mode: 'insensitive' } },
          },
        },
        { course: { title: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (status === 'active') {
      where.NOT = { certificateUrl: { startsWith: 'pending' } };
    } else if (status === 'pending') {
      where.certificateUrl = { startsWith: 'pending' };
    }

    const [total, certs] = await Promise.all([
      this.db.studentCertificate.count({ where: where as any }),
      this.db.studentCertificate.findMany({
        where: where as any,
        orderBy: { issuedAt: 'desc' },
        skip,
        take,
        include: {
          course: { select: { id: true, title: true } },
          student: {
            select: {
              id: true,
              email: true,
              profile: { select: { fullName: true } },
            },
          },
          issuedByUser: { select: { id: true, email: true } },
        },
      }),
    ]);

    return {
      total,
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      limit: take,
      certificates: certs.map((c) => ({
        id: c.id,
        short_id: StudentExtraController.shortCertId(c.id),
        student_id: c.studentId,
        student_name: c.student?.profile?.fullName ?? c.student?.email ?? '',
        student_email: c.student?.email ?? '',
        course_id: c.courseId,
        course_title: c.course?.title ?? '',
        certificate_name: c.certificateName,
        certificate_url: c.certificateUrl,
        status: c.certificateUrl.startsWith('pending') ? 'pending' : 'active',
        issued_at: c.issuedAt.toISOString(),
        issued_by: c.issuedByUser?.email ?? null,
      })),
    };
  }

  @Post('certificates/:id/regenerate')
  async regenerateCertificate(
    @Param('id') id: string,
    @CurrentUser() admin: { id: number },
  ) {
    const cert = await this.db.studentCertificate.findUnique({
      where: { id },
      include: {
        course: true,
        student: { include: { profile: true } },
      },
    });
    if (!cert) throw new BadRequestException('Certificate not found');

    const templateSetting = await this.db.systemSetting.findUnique({
      where: { key: 'certificate:template' },
    });

    const issuedAt = cert.issuedAt.toISOString().split('T')[0];
    const svg = StudentExtraController.buildCertificateSvg(
      {
        studentName:
          cert.student?.profile?.fullName || cert.student?.email || 'Student',
        courseTitle: cert.course?.title ?? '',
        issuedAt,
        certificateId: cert.id,
      },
      templateSetting?.value ?? null,
    );
    const jpegBuffer = await StudentExtraController.svgToJpegBuffer(svg);
    const oldCertKey = cert.certificateKey;
    const certKey = this.storage.buildKey(
      `certificates/${cert.studentId}`,
      `${cert.id}-regen-${Date.now()}.jpg`,
    );
    const certUrl = await this.storage.uploadBuffer(
      certKey,
      jpegBuffer,
      'image/jpeg',
    );
    const updated = await this.db.studentCertificate.update({
      where: { id },
      data: {
        certificateUrl: certUrl,
        certificateKey: certKey,
        issuedBy: admin.id,
      },
    });
    if (oldCertKey) {
      await this.storage.deleteObject(oldCertKey).catch(() => {});
    }
    return {
      success: true,
      certificate: {
        id: updated.id,
        short_id: StudentExtraController.shortCertId(updated.id),
        certificate_url: updated.certificateUrl,
      },
    };
  }

  @Delete('certificates/:id')
  async revokeCertificate(@Param('id') id: string) {
    const cert = await this.db.studentCertificate.findUnique({ where: { id } });
    if (!cert) throw new BadRequestException('Certificate not found');
    await this.db.studentCertificate.delete({ where: { id } });
    return { success: true };
  }

  @Get('certificate-template')
  async getCertificateTemplate() {
    const setting = await this.db.systemSetting.findUnique({
      where: { key: 'certificate:template' },
    });
    return { template: setting?.value ?? null };
  }

  @Post('certificate-template')
  async saveCertificateTemplate(@Body() body: { template: string }) {
    const tpl = String(body?.template ?? '').trim();
    if (!tpl) throw new BadRequestException('template is required');
    await this.db.systemSetting.upsert({
      where: { key: 'certificate:template' },
      create: { key: 'certificate:template', value: tpl },
      update: { value: tpl },
    });
    return { success: true };
  }

  @Delete('certificate-template')
  async deleteCertificateTemplate() {
    await this.db.systemSetting.deleteMany({
      where: { key: 'certificate:template' },
    });
    return { success: true };
  }

  @Post('courses/:courseId/access')
  async createOrUpdateCourseAccess(
    @Param('courseId') courseId: string,
    @Body()
    body: {
      school_ids?: string[];
      grades?: string[];
    },
  ) {
    const schoolIds = Array.isArray(body.school_ids) ? body.school_ids : [];
    const gradesArr = Array.isArray(body.grades) ? body.grades : [];

    const gradesBySchool = new Map<string, Set<string>>();
    const minLen = Math.min(schoolIds.length, gradesArr.length);

    for (let i = 0; i < minLen; i++) {
      const schoolId = schoolIds[i];
      if (!schoolId) continue;
      if (!gradesBySchool.has(schoolId))
        gradesBySchool.set(schoolId, new Set<string>());
      const g = gradesArr[i];
      if (typeof g === 'string' && g.trim())
        gradesBySchool.get(schoolId)!.add(g.trim());
    }

    // Ensure we keep schools even if grades are missing/short.
    for (const s of schoolIds) {
      if (!s) continue;
      if (!gradesBySchool.has(s)) gradesBySchool.set(s, new Set<string>());
    }

    await this.db.courseAccess.deleteMany({ where: { courseId } });

    const uniqueSchoolIds = Array.from(gradesBySchool.keys());
    if (uniqueSchoolIds.length === 0) {
      return { success: true, course_access: [] };
    }

    for (const schoolId of uniqueSchoolIds) {
      const gradeNames = Array.from(gradesBySchool.get(schoolId) ?? []);
      await this.db.courseAccess.create({
        data: {
          courseId,
          schoolId,
          gradeAccess: {
            create: gradeNames.map((gradeName) => ({ gradeName })),
          },
        },
      });
    }

    // Return the freshly saved access in the frontend shape
    const rows = await this.db.courseAccess.findMany({
      where: { courseId },
      include: { school: { select: { name: true } }, gradeAccess: true },
    });

    const course_access = rows.flatMap((row) => {
      const gradeList =
        row.gradeAccess.length > 0
          ? row.gradeAccess.map((g) => g.gradeName)
          : [''];
      return gradeList.map((grade) => ({
        id: row.id,
        course_id: row.courseId,
        school_id: row.schoolId,
        grade,
        schools: row.school ? { name: row.school.name } : undefined,
      }));
    });

    return { success: true, course_access };
  }

  // ─── Contact Submissions ─────────────────────────────────────────────────────

  @Get('contact-submissions')
  async listContactSubmissions(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    const take = Math.min(Math.max(parseInt(limit ?? '20', 10) || 20, 1), 100);
    const skip = (Math.max(parseInt(page ?? '1', 10) || 1, 1) - 1) * take;

    const where: Record<string, unknown> = {};
    if (status && status !== 'all') where.status = status;
    if (search && search.trim()) {
      const q = search.trim();
      where.OR = [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { message: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [submissions, total] = await Promise.all([
      this.db.contactSubmission.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.db.contactSubmission.count({ where }),
    ]);

    const statusCounts = await this.db.contactSubmission.groupBy({
      by: ['status'],
      _count: { status: true },
    });

    const counts: Record<string, number> = {
      new: 0,
      read: 0,
      replied: 0,
      archived: 0,
    };
    for (const row of statusCounts) {
      counts[row.status] = row._count.status;
    }

    return {
      submissions: submissions.map((s) => ({
        id: s.id,
        first_name: s.firstName,
        last_name: s.lastName,
        email: s.email,
        area_code: s.areaCode,
        phone_number: s.phoneNumber,
        purpose: s.purpose,
        message: s.message,
        status: s.status,
        admin_notes: s.adminNotes,
        source: s.source,
        created_at: s.createdAt.toISOString(),
        updated_at: s.updatedAt.toISOString(),
      })),
      total,
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      limit: take,
      status_counts: counts,
    };
  }

  @Patch('contact-submissions/:id')
  async updateContactSubmission(
    @Param('id') id: string,
    @Body() body: { status?: string; admin_notes?: string },
  ) {
    const validStatuses = ['new', 'read', 'replied', 'archived'];
    const data: { status?: string; adminNotes?: string | null } = {};

    if (body.status !== undefined) {
      if (!validStatuses.includes(body.status)) {
        throw new BadRequestException(
          `status must be one of: ${validStatuses.join(', ')}`,
        );
      }
      data.status = body.status;
    }
    if (body.admin_notes !== undefined) {
      data.adminNotes = body.admin_notes || null;
    }

    const updated = await this.db.contactSubmission.update({
      where: { id },
      data,
    });

    return {
      success: true,
      submission: {
        id: updated.id,
        status: updated.status,
        admin_notes: updated.adminNotes,
        updated_at: updated.updatedAt.toISOString(),
      },
    };
  }

  @Delete('contact-submissions/:id')
  async deleteContactSubmission(@Param('id') id: string) {
    await this.db.contactSubmission.delete({ where: { id } });
    return { success: true };
  }
}
