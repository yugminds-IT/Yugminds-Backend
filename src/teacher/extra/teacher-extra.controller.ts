import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Prisma, Role } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { DatabaseService } from '../../database/database.service';
import { RankingService } from '../../common/assignment/ranking.service';
import { NotificationIdParamDto } from './dto/notification-id-param.dto';

interface PlaceholderResponse {
  endpoint: string;
  method: string;
  message: string;
}

@Controller('teacher')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.teacher)
export class TeacherExtraController {
  constructor(
    private readonly db: DatabaseService,
    private readonly ranking: RankingService,
  ) {}

  private async canTeacherAccessAssignment(
    userId: number,
    assignment: {
      teacherId: number | null;
      schoolId: string | null;
      courseId: string | null;
      chapterId: string | null;
    },
  ): Promise<boolean> {
    if (assignment.teacherId === userId) return true;
    const teacherSchools = await this.db.teacherSchool.findMany({
      where: { teacherId: userId },
      select: { schoolId: true },
    });
    const schoolIds = teacherSchools.map((s) => s.schoolId);
    if (!schoolIds.length) return false;
    if (assignment.schoolId && schoolIds.includes(assignment.schoolId))
      return true;

    // chapterId may be null for DAILY assignments; fall back to courseId directly
    const chapter = assignment.chapterId
      ? await this.db.chapter.findUnique({
          where: { id: assignment.chapterId },
          select: { courseId: true },
        })
      : null;
    const courseId = assignment.courseId ?? chapter?.courseId ?? null;
    if (!courseId) return false;

    const courseAccess = await this.db.courseAccess.findFirst({
      where: { courseId, schoolId: { in: schoolIds } },
      select: { id: true },
    });
    return !!courseAccess;
  }

  private async recomputeStudentScores(
    studentId: number,
    assignmentCourseId?: string | null,
  ) {
    await this.ranking.recomputeStudentScores(studentId, assignmentCourseId);
  }

  private async notifyTargetedStudents(
    assignmentId: string,
    schoolId: string,
    assignment: {
      title: string;
      dueDate: Date | null;
      subject: string | null;
      gradeId: string | null;
      assignmentType?: string;
      publishScope?: string;
      publishedGradeIds?: string[];
      publishedSectionIds?: string[];
    },
  ) {
    const enrollments = await this.db.studentSchool.findMany({
      where: { schoolId, isActive: true },
      select: { studentId: true, grade: true, section: true },
    });

    const scope = assignment.publishScope ?? 'grade';
    let studentIds: number[];

    if (scope === 'section' && assignment.publishedSectionIds?.length) {
      // Target specific sections — resolve section names
      const sections = await this.db.section.findMany({
        where: { id: { in: assignment.publishedSectionIds } },
        select: { name: true, grade: { select: { name: true } } },
      });
      const targets = new Set(
        sections.map((s) => `${s.grade.name}::${s.name}`),
      );
      studentIds = enrollments
        .filter((e) => targets.has(`${e.grade ?? ''}::${e.section ?? ''}`))
        .map((e) => e.studentId);
    } else if (assignment.publishedGradeIds?.length) {
      // Target specific grades (publishScope=grade or fallback)
      const grades = await this.db.grade.findMany({
        where: { id: { in: assignment.publishedGradeIds } },
        select: { name: true },
      });
      const gradeNames = new Set(grades.map((g) => g.name));
      studentIds = enrollments
        .filter((e) => gradeNames.has(e.grade ?? ''))
        .map((e) => e.studentId);
    } else if (assignment.gradeId) {
      // Legacy single-grade targeting via gradeId field
      const grade = await this.db.grade.findUnique({
        where: { id: assignment.gradeId },
        select: { name: true },
      });
      const gradeName = grade?.name ?? '';
      studentIds = enrollments
        .filter((e) => e.grade === gradeName)
        .map((e) => e.studentId);
    } else {
      // Broadcast to entire school
      studentIds = enrollments.map((e) => e.studentId);
    }

    if (studentIds.length === 0) return;
    const duePart = assignment.dueDate
      ? ` — Due ${assignment.dueDate.toLocaleDateString('en-IN')}`
      : '';
    const subjectPart = assignment.subject
      ? `. Subject: ${assignment.subject}`
      : '';
    await this.db.notification.createMany({
      data: studentIds.map((userId) => ({
        userId,
        title: `New assignment posted: ${assignment.title}`,
        message: `New assignment posted: ${assignment.title}${duePart}${subjectPart}.`,
        mode: 'assignment_due',
      })),
    });
  }

  private async recomputeStudentScoreSummary(
    _studentId: number,
    schoolId: string | null,
  ) {
    if (!schoolId) return;
    await this.ranking.recomputeStudentScoreSummary(schoolId);
  }

  private buildResponse(endpoint: string, method: string): PlaceholderResponse {
    return {
      endpoint,
      method,
      message:
        'This endpoint is implemented as a placeholder. Replace with real business logic as needed.',
    };
  }

  // Schools: implemented in TeacherSchoolsController (GET /teacher/schools)

  // Attendance: implemented in TeacherAttendanceController

  // Notifications

  @Get('notifications')
  async listNotifications(
    @CurrentUser() user: { id: number },
    @Query('limit') limit?: string,
    @Query('school_id') schoolId?: string,
  ) {
    const take = limit
      ? Math.min(Math.max(parseInt(limit, 10) || 1, 1), 100)
      : 50;
    // If school is provided, ensure teacher is assigned to it
    if (schoolId) {
      const assigned = await this.db.teacherSchool.findFirst({
        where: { teacherId: user.id, schoolId },
      });
      if (!assigned)
        throw new ForbiddenException('Not assigned to this school');
    }
    const notifications = await this.db.notification.findMany({
      where: {
        deletedAt: null,
        OR: [{ userId: user.id }, { senderId: user.id }],
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return {
      notifications: notifications.map((n) => ({
        id: n.id,
        user_id: n.userId,
        title: n.title,
        message: n.message,
        type: n.mode ?? 'general',
        is_read: !!n.readAt,
        sender_id: n.senderId ?? null,
        created_at: n.createdAt.toISOString(),
      })),
    };
  }

  @Post('notifications')
  async createNotification(
    @CurrentUser() user: { id: number },
    @Body()
    body: {
      title?: string;
      message?: string;
      type?: string;
      school_id?: string;
      recipientType?: 'role' | 'individual';
      recipients?: string[];
    },
  ) {
    const title = (body.title ?? '').trim();
    const message = (body.message ?? '').trim();
    if (!title || !message) {
      throw new BadRequestException('Title and message are required');
    }
    const schoolId = (body.school_id ?? '').trim();
    if (!schoolId) throw new BadRequestException('school_id is required');
    const assigned = await this.db.teacherSchool.findFirst({
      where: { teacherId: user.id, schoolId },
    });
    if (!assigned) throw new ForbiddenException('Not assigned to this school');

    const recipientType = body.recipientType ?? 'role';
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];
    if (recipients.length === 0)
      throw new BadRequestException('At least one recipient is required');

    const targetUserIds = new Set<number>();
    if (recipientType === 'role') {
      for (const r of recipients) {
        if (r === 'role:student') {
          const students = await this.db.studentSchool.findMany({
            where: { schoolId, isActive: true },
            select: { studentId: true },
          });
          students.forEach((s) => targetUserIds.add(s.studentId));
        } else if (r === 'role:teacher') {
          const teachers = await this.db.teacherSchool.findMany({
            where: { schoolId },
            select: { teacherId: true },
          });
          teachers.forEach((t) => targetUserIds.add(t.teacherId));
        }
      }
    } else {
      // individual: validate each user belongs to this school (student or teacher)
      const ids = recipients
        .map((x) => parseInt(String(x), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (ids.length === 0) throw new BadRequestException('Invalid recipients');
      const [studentRows, teacherRows] = await Promise.all([
        this.db.studentSchool.findMany({
          where: { schoolId, studentId: { in: ids } },
          select: { studentId: true },
        }),
        this.db.teacherSchool.findMany({
          where: { schoolId, teacherId: { in: ids } },
          select: { teacherId: true },
        }),
      ]);
      studentRows.forEach((s) => targetUserIds.add(s.studentId));
      teacherRows.forEach((t) => targetUserIds.add(t.teacherId));
    }

    // Do not send to self unless explicitly selected as an individual
    if (recipientType === 'role') targetUserIds.delete(user.id);
    const userIds = Array.from(targetUserIds);
    if (userIds.length === 0)
      throw new BadRequestException('No valid recipients for this school');

    const mode = (body.type ?? 'general').trim() || 'general';
    const createdAt = new Date();
    const result = await this.db.notification.createMany({
      data: userIds.map((uid) => ({
        userId: uid,
        senderId: user.id,
        title,
        message,
        mode,
        createdAt,
      })),
    });
    return { sent: result.count };
  }

  @Get('notifications/recipients')
  async listNotificationRecipients(
    @CurrentUser() user: { id: number },
    @Query('school_id') schoolId?: string,
  ) {
    if (!schoolId) {
      return { roles: [], users: [] };
    }
    const assigned = await this.db.teacherSchool.findFirst({
      where: { teacherId: user.id, schoolId },
    });
    if (!assigned) throw new ForbiddenException('Not assigned to this school');

    // Aggregate role-level options (teacher / student) for the school
    const [teacherCount, studentCount] = await Promise.all([
      this.db.teacherSchool.count({ where: { schoolId } }),
      this.db.studentSchool.count({ where: { schoolId } }),
    ]);

    const roles = [
      teacherCount > 0
        ? { id: 'role:teacher', name: 'All Teachers', count: teacherCount }
        : null,
      studentCount > 0
        ? { id: 'role:student', name: 'All Students', count: studentCount }
        : null,
    ].filter(
      (r): r is { id: string; name: string; count: number } => r !== null,
    );

    // Individual users (teachers + students) for the school
    const [teacherUsers, studentUsers] = await Promise.all([
      this.db.teacherSchool.findMany({
        where: { schoolId },
      }),
      this.db.studentSchool.findMany({
        where: { schoolId },
        include: { student: { include: { profile: true } } },
      }),
    ]);

    // Load teacher user records separately since TeacherSchool has only teacherId
    const teacherIds = Array.from(
      new Set(teacherUsers.map((t) => t.teacherId)),
    );
    const teachers =
      teacherIds.length > 0
        ? await this.db.user.findMany({
            where: { id: { in: teacherIds } },
            include: { profile: true },
          })
        : [];
    const teacherById = new Map<number, (typeof teachers)[number]>();
    teachers.forEach((t) => teacherById.set(t.id, t));

    const users = [
      ...(teacherUsers
        .map((ts) => {
          const teacher = teacherById.get(ts.teacherId);
          if (!teacher) return null;
          return {
            id: String(teacher.id),
            name: teacher.profile?.fullName ?? teacher.email,
            email: teacher.email,
            role: 'teacher',
            isActive: true,
          };
        })
        .filter((u) => u !== null) as Array<{
        id: string;
        name: string | null;
        email: string | null;
        role: string;
        isActive: boolean;
      }>),
      ...studentUsers.map((ss) => ({
        id: String(ss.student.id),
        name: ss.student.profile?.fullName ?? ss.student.email,
        email: ss.student.email,
        role: 'student',
        isActive: ss.isActive,
      })),
    ];

    return { roles, users };
  }

  @Get('notifications/:id')
  async getNotification(
    @CurrentUser() user: { id: number },
    @Param() params: NotificationIdParamDto,
  ) {
    const n = await this.db.notification.findFirst({
      where: {
        id: params.id,
        deletedAt: null,
        OR: [{ userId: user.id }, { senderId: user.id }],
      },
    });
    if (!n) throw new BadRequestException('Notification not found');
    return {
      notification: {
        id: n.id,
        user_id: n.userId,
        sender_id: n.senderId ?? null,
        title: n.title,
        message: n.message,
        type: n.mode ?? 'general',
        is_read: !!n.readAt,
        created_at: n.createdAt.toISOString(),
      },
    };
  }

  @Patch('notifications/:id')
  async updateNotification(
    @CurrentUser() user: { id: number },
    @Param('id') id: string,
    @Body() body: { is_read?: boolean },
  ) {
    const notification = await this.db.notification.findUnique({
      where: { id },
    });
    if (!notification || notification.deletedAt)
      throw new BadRequestException('Notification not found');
    if (notification.userId !== user.id) {
      throw new ForbiddenException(
        'You can only update notifications you received',
      );
    }
    const isRead = !!body?.is_read;
    await this.db.notification.update({
      where: { id },
      data: { readAt: isRead ? new Date() : null },
    });
    return { success: true };
  }

  // Reports: implemented in TeacherReportsController

  @Get('analytics')
  async getAnalytics(
    @CurrentUser() user: { id: number },
    @Query('school_id') schoolId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (schoolId) {
      const assigned = await this.db.teacherSchool.findFirst({
        where: { teacherId: user.id, schoolId },
      });
      if (!assigned)
        throw new ForbiddenException('Not assigned to this school');
    }

    const schoolIds = schoolId
      ? [schoolId]
      : (
          await this.db.teacherSchool.findMany({
            where: { teacherId: user.id },
            select: { schoolId: true },
          })
        ).map((s) => s.schoolId);
    if (schoolIds.length === 0) {
      return { analytics: { summary: {}, charts: {} } };
    }

    const now = new Date();
    const fromDate = from
      ? new Date(from + 'T00:00:00.000Z')
      : new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
        );
    const toDate = to ? new Date(to + 'T23:59:59.999Z') : now;
    const safeFrom = isNaN(fromDate.getTime())
      ? new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
        )
      : fromDate;
    const safeTo = isNaN(toDate.getTime()) ? now : toDate;

    const [
      sectionAssignments,
      receivedNotifications,
      sentNotifications,
      reports,
      leaves,
      attendanceRows,
    ] = await Promise.all([
      this.db.teacherSectionAssignment.count({
        where: {
          teacherId: user.id,
          ...(schoolId ? { schoolId } : { schoolId: { in: schoolIds } }),
        },
      }),
      this.db.notification.count({
        where: {
          userId: user.id,
          deletedAt: null,
          createdAt: { gte: safeFrom, lte: safeTo },
        },
      }),
      this.db.notification.count({
        where: {
          senderId: user.id,
          deletedAt: null,
          createdAt: { gte: safeFrom, lte: safeTo },
        },
      }),
      this.db.teacherReport.findMany({
        where: {
          teacherId: user.id,
          schoolId: { in: schoolIds },
          reportDate: { gte: safeFrom, lte: safeTo },
        },
        select: { status: true, reportDate: true },
      }),
      this.db.teacherLeave.findMany({
        where: {
          teacherId: user.id,
          schoolId: { in: schoolIds },
          createdAt: { gte: safeFrom, lte: safeTo },
        },
        select: { status: true, createdAt: true },
      }),
      this.db.attendance.findMany({
        where: {
          teacherId: user.id,
          schoolId: { in: schoolIds },
          date: { gte: safeFrom, lte: safeTo },
        },
        select: { status: true, date: true },
      }),
    ]);

    const norm = (s: string | null | undefined) =>
      String(s ?? '')
        .trim()
        .toLowerCase();
    const approvedReports = reports.filter(
      (r) => norm(r.status) === 'approved',
    ).length;
    const rejectedReports = reports.filter(
      (r) => norm(r.status) === 'rejected',
    ).length;
    const submittedReports = reports.filter(
      (r) => norm(r.status) === 'submitted' || norm(r.status) === 'pending',
    ).length;

    const approvedLeaves = leaves.filter(
      (l) => norm(l.status) === 'approved',
    ).length;
    const rejectedLeaves = leaves.filter(
      (l) => norm(l.status) === 'rejected',
    ).length;
    const pendingLeaves = leaves.filter(
      (l) => norm(l.status) === 'pending',
    ).length;

    const presentDays = new Set(
      attendanceRows
        .filter((a) => a.status === 'Present')
        .map((a) => a.date.toISOString().split('T')[0]),
    ).size;
    const totalAttendanceDays = new Set(
      attendanceRows.map((a) => a.date.toISOString().split('T')[0]),
    ).size;
    const attendancePercentage =
      totalAttendanceDays > 0
        ? Math.round((presentDays / totalAttendanceDays) * 100)
        : 0;

    return {
      analytics: {
        summary: {
          school_ids: schoolIds,
          from: safeFrom.toISOString(),
          to: safeTo.toISOString(),
          assigned_sections: sectionAssignments,
          notifications_received: receivedNotifications,
          notifications_sent: sentNotifications,
          reports_total: reports.length,
          reports_approved: approvedReports,
          reports_flagged: rejectedReports,
          reports_pending: submittedReports,
          leaves_total: leaves.length,
          leaves_approved: approvedLeaves,
          leaves_rejected: rejectedLeaves,
          leaves_pending: pendingLeaves,
          attendance_percentage: attendancePercentage,
        },
        charts: {
          report_status: [
            { name: 'Approved', value: approvedReports },
            { name: 'Pending', value: submittedReports },
            { name: 'Flagged', value: rejectedReports },
          ],
          leave_status: [
            { name: 'Approved', value: approvedLeaves },
            { name: 'Pending', value: pendingLeaves },
            { name: 'Rejected', value: rejectedLeaves },
          ],
        },
      },
    };
  }

  @Get('student-progress')
  async getStudentProgress(
    @CurrentUser() user: { id: number },
    @Query('school_id') schoolId?: string,
    @Query('course_id') courseId?: string,
    @Query('student_id') studentId?: string,
    @Query('section') section?: string,
  ) {
    const assignments = await this.db.teacherSectionAssignment.findMany({
      where: { teacherId: user.id },
      include: { section: true },
    });
    const schoolSectionPairs = new Set<string>();
    assignments.forEach((a) => {
      const sectionName = a.section?.name ?? '';
      schoolSectionPairs.add(`${a.schoolId}:${sectionName}`);
    });
    const studentSchools = await this.db.studentSchool.findMany({
      where: {
        schoolId: {
          in: Array.from(new Set(assignments.map((a) => a.schoolId))),
        },
      },
      select: { studentId: true, schoolId: true, section: true },
    });
    const allowedStudentIds = new Set<number>();
    studentSchools.forEach((ss) => {
      const key = `${ss.schoolId}:${ss.section ?? ''}`;
      if (schoolSectionPairs.has(key)) {
        allowedStudentIds.add(ss.studentId);
      }
    });
    if (allowedStudentIds.size === 0) {
      return {
        students: [],
        summary: {
          total_students: 0,
          students_with_progress: 0,
          students_completed: 0,
          average_system_progress: 0,
          total_courses: 0,
        },
      };
    }
    const studentWhere: { role: Role; id?: number | { in: number[] } } = {
      role: Role.student,
      id: { in: Array.from(allowedStudentIds) },
    };
    if (studentId) {
      const id = parseInt(studentId, 10);
      if (allowedStudentIds.has(id)) {
        studentWhere.id = id;
      }
    }
    const allStudentsRaw = await this.db.user.findMany({
      where: studentWhere,
      include: { profile: true, studentSchools: true },
      orderBy: { createdAt: 'desc' },
    });
    let allStudentsFiltered = allStudentsRaw;
    if (schoolId) {
      allStudentsFiltered = allStudentsFiltered.filter((u) =>
        (u.studentSchools ?? []).some((ss) => ss.schoolId === schoolId),
      );
    }
    if (section) {
      allStudentsFiltered = allStudentsFiltered.filter((u) =>
        (u.studentSchools ?? []).some((ss) => (ss.section ?? '') === section),
      );
    }
    const studentIds = allStudentsFiltered.map((u) => u.id);
    if (studentIds.length === 0) {
      return {
        students: [],
        summary: {
          total_students: 0,
          students_with_progress: 0,
          students_completed: 0,
          average_system_progress: 0,
          total_courses: 0,
        },
      };
    }
    const [studentCourses, courseProgress] = await Promise.all([
      this.db.studentCourse.findMany({
        where: {
          studentId: { in: studentIds },
          ...(courseId ? { courseId } : {}),
        },
      }),
      this.db.courseProgress.findMany({
        where: {
          studentId: { in: studentIds },
          ...(courseId ? { courseId } : {}),
        },
      }),
    ]);
    const courseIdsForQuery = Array.from(
      new Set<string>(studentCourses.map((sc) => sc.courseId)),
    );
    const [courses, schools] = await Promise.all([
      this.db.course.findMany({
        where: courseIdsForQuery.length
          ? { id: { in: courseIdsForQuery } }
          : undefined,
        include: { _count: { select: { chapters: true } } },
      }),
      this.db.school.findMany({
        where: {
          id: {
            in: Array.from(
              new Set(
                allStudentsFiltered.flatMap((u) =>
                  (u.studentSchools ?? []).map((ss) => ss.schoolId),
                ),
              ),
            ),
          },
        },
      }),
    ]);
    // Fetch chapters and contents to calculate progress correctly (same as student's own view)
    const [allChapters, allContents] = courseIdsForQuery.length
      ? await Promise.all([
          this.db.chapter.findMany({
            where: { courseId: { in: courseIdsForQuery } },
            select: { id: true, courseId: true },
          }),
          this.db.chapterContent.findMany({
            where: { chapter: { courseId: { in: courseIdsForQuery } } },
            select: { id: true, chapterId: true },
          }),
        ])
      : [[], []];

    // Build content lookup maps
    const chapterToCourseT = new Map(
      allChapters.map((ch) => [ch.id, ch.courseId]),
    );
    const contentsByCourseT = new Map<
      string,
      Array<{ id: string; chapterId: string }>
    >();
    for (const c of allContents) {
      const cid = chapterToCourseT.get(c.chapterId);
      if (!cid) continue;
      const arr = contentsByCourseT.get(cid) ?? [];
      arr.push(c);
      contentsByCourseT.set(cid, arr);
    }
    const chaptersByCourseT = new Map<string, Array<{ id: string }>>();
    for (const ch of allChapters) {
      const arr = chaptersByCourseT.get(ch.courseId) ?? [];
      arr.push(ch);
      chaptersByCourseT.set(ch.courseId, arr);
    }

    const courseById = new Map(courses.map((c) => [c.id, c]));
    const schoolById = new Map(schools.map((s) => [s.id, s]));
    const studentsDto = allStudentsFiltered.map((u) => {
      const primarySchool = (u.studentSchools ?? [])[0];
      const school = primarySchool
        ? schoolById.get(primarySchool.schoolId)
        : undefined;
      const studentCourseForUser = studentCourses.filter(
        (sc) => sc.studentId === u.id,
      );
      const progressForUser = courseProgress.filter(
        (cp) => cp.studentId === u.id,
      );
      const courseIdsForStudent = Array.from(
        new Set<string>(studentCourseForUser.map((sc) => sc.courseId)),
      );
      const coursesForStudent = courseIdsForStudent.map((cid) => {
        const course = courseById.get(cid);
        const progressEntries = progressForUser.filter(
          (cp) => cp.courseId === cid,
        );
        const last = progressEntries.reduce<Date | null>((latest, p) => {
          const ts = p.completedAt ?? p.updatedAt;
          return !latest ? ts : ts > latest ? ts : latest;
        }, null);

        // Content-item based progress (matches student's own view)
        const courseContents = contentsByCourseT.get(cid) ?? [];
        const totalContentItems = courseContents.length;
        const completedContentIds = new Set(
          progressEntries
            .filter(
              (p) =>
                (p as any).contentId && (p.progress >= 99 || p.completedAt),
            )
            .map((p) => (p as any).contentId as string),
        );
        const completedChapterIds = new Set(
          progressEntries
            .filter((p) => {
              const cntId = (p as any).contentId;
              return (
                (!cntId || cntId === '' || cntId === 'null') &&
                p.chapterId &&
                p.progress >= 99
              );
            })
            .map((p) => p.chapterId as string),
        );
        let hybridCompleted = 0;
        for (const c of courseContents) {
          if (
            completedContentIds.has(c.id) ||
            completedChapterIds.has(c.chapterId)
          ) {
            hybridCompleted++;
          }
        }
        const progressPercentage =
          totalContentItems > 0
            ? Math.min(
                100,
                Math.round((hybridCompleted / totalContentItems) * 100),
              )
            : progressEntries.some((p) => p.progress >= 99)
              ? 100
              : 0;

        // Completed chapters: all contents done OR explicitly marked
        const courseChapters = chaptersByCourseT.get(cid) ?? [];
        const chapterContentsMap = new Map<string, string[]>();
        for (const c of courseContents) {
          const arr = chapterContentsMap.get(c.chapterId) ?? [];
          arr.push(c.id);
          chapterContentsMap.set(c.chapterId, arr);
        }
        let completedChapters = 0;
        for (const ch of courseChapters) {
          const chContents = chapterContentsMap.get(ch.id) ?? [];
          const chDone = completedChapterIds.has(ch.id);
          if (chContents.length > 0) {
            const allDone = chContents.every((id) =>
              completedContentIds.has(id),
            );
            if (allDone || chDone) completedChapters++;
          } else if (chDone) {
            completedChapters++;
          }
        }

        const status: 'completed' | 'in_progress' | 'not_started' =
          progressPercentage >= 100
            ? 'completed'
            : progressPercentage > 0
              ? 'in_progress'
              : 'not_started';
        return {
          course_id: cid,
          course_name: course?.title ?? '',
          total_chapters:
            (courseChapters.length || course?._count?.chapters) ?? 0,
          completed_chapters: completedChapters,
          progress_percentage: progressPercentage,
          last_accessed: last ? last.toISOString() : '',
          enrolled_on:
            studentCourseForUser
              .find((sc) => sc.courseId === cid)
              ?.enrolledAt.toISOString() ?? '',
          status,
        };
      });
      const totalCourses = coursesForStudent.length;
      const completedCourses = coursesForStudent.filter(
        (c) => c.status === 'completed',
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
          return !latest || d > latest ? d : latest;
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
        in_progress_courses: coursesForStudent.filter(
          (c) => c.status === 'in_progress',
        ).length,
        average_progress: Number(avgStudentProgress.toFixed(2)),
        courses: coursesForStudent,
        last_activity: lastActivity,
      };
    });
    const studentsWithProgress = studentsDto.filter((s) => s.total_courses > 0);
    const studentsCompleted = studentsDto.filter(
      (s) => s.total_courses > 0 && s.completed_courses === s.total_courses,
    );
    const averageSystemProgress =
      studentsDto.length > 0
        ? studentsDto.reduce((sum, s) => sum + s.average_progress, 0) /
          studentsDto.length
        : 0;
    return {
      students: studentsDto,
      summary: {
        total_students: studentsDto.length,
        students_with_progress: studentsWithProgress.length,
        students_completed: studentsCompleted.length,
        average_system_progress: Number(averageSystemProgress.toFixed(2)),
        total_courses: Array.from(
          new Set(studentCourses.map((sc) => sc.courseId)),
        ).length,
      },
    };
  }

  // Classes – sections assigned to this teacher for the given school

  @Get('classes')
  async listClasses(
    @CurrentUser() user: { id: number },
    @Query('school_id') schoolId?: string,
  ) {
    const where: { teacherId: number; schoolId?: string } = {
      teacherId: user.id,
    };
    if (schoolId) where.schoolId = schoolId;
    const assignments = await this.db.teacherSectionAssignment.findMany({
      where,
      include: {
        section: { include: { grade: true } },
        school: true,
      },
    });
    const classes = assignments.map((a) => ({
      id: a.section.id,
      name: `${a.section.grade.name} - ${a.section.name}`,
      grade: a.section.grade.name,
      section: a.section.name,
      school_id: a.schoolId,
      grade_id: a.section.gradeId,
      section_id: a.section.id,
    }));
    return { classes };
  }

  // Periods – for the given school

  @Get('periods')
  async listPeriods(
    @CurrentUser() user: { id: number },
    @Query('school_id') schoolId?: string,
    @Query('day') day?: string,
  ) {
    if (!schoolId) return { periods: [] };

    // Build schedule filter — optionally narrow by day of week
    const scheduleWhere: {
      schoolId: string;
      teacherId: number;
      dayOfWeek?: number;
    } = {
      schoolId,
      teacherId: user.id,
    };
    if (day !== undefined && day !== '') {
      const dayNum = TeacherExtraController.DAY_OF_WEEK_MAP[day];
      if (dayNum !== undefined) scheduleWhere.dayOfWeek = dayNum;
    }

    const [periods, schedules] = await Promise.all([
      this.db.period.findMany({
        where: { schoolId },
        orderBy: { periodNumber: 'asc' },
      }),
      this.db.classSchedule.findMany({
        where: scheduleWhere,
      }),
    ]);

    // Build a map from periodId → matching schedule (grade + subject)
    // When filtered by day, each period should map to at most one schedule
    const scheduleByPeriod = new Map<
      string,
      { grade: string | null; subject: string | null }
    >();
    for (const s of schedules) {
      if (!scheduleByPeriod.has(s.periodId)) {
        scheduleByPeriod.set(s.periodId, {
          grade: (s as { grade?: string | null }).grade ?? null,
          subject: (s as { subject?: string | null }).subject ?? null,
        });
      }
    }

    // Only return periods that have a schedule for this teacher (on the given day)
    // If no day filter, return all periods with whatever schedule info we have
    const enrichedPeriods = periods.map((p) => {
      const sched = scheduleByPeriod.get(p.id);
      return {
        id: p.id,
        period_number: p.periodNumber,
        start_time: p.startTime,
        end_time: p.endTime,
        school_id: p.schoolId,
        is_active: (p as { isActive?: boolean }).isActive !== false,
        grade: sched?.grade ?? null,
        subject: sched?.subject ?? null,
        has_schedule: !!sched,
      };
    });

    // When filtered by day, only return periods that this teacher actually has a schedule for
    const result = day
      ? enrichedPeriods.filter((p) => p.has_schedule)
      : enrichedPeriods;

    return { periods: result };
  }

  // Schedules – class schedules for the school, optional filter by day (e.g. "Monday")

  private static readonly DAY_OF_WEEK_MAP: Record<string, number> = {
    Sunday: 0,
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
  };

  @Get('schedules')
  async listSchedules(
    @CurrentUser() user: { id: number },
    @Query('school_id') schoolId?: string,
    @Query('day') day?: string,
  ) {
    if (!schoolId) return { schedules: [] };
    const where: { schoolId: string; teacherId: number; dayOfWeek?: number } = {
      schoolId,
      teacherId: user.id,
    };
    if (day !== undefined && day !== '') {
      const dayNum = TeacherExtraController.DAY_OF_WEEK_MAP[day];
      if (dayNum !== undefined) where.dayOfWeek = dayNum;
    }
    console.log(
      `[TeacherExtraController] listSchedules: userId=${user.id}, schoolId=${schoolId}, day=${day}`,
    );
    const schedules = await this.db.classSchedule.findMany({
      where,
      orderBy: [{ dayOfWeek: 'asc' }, { id: 'asc' }],
    });
    console.log(
      `[TeacherExtraController] listSchedules: found ${schedules.length} records`,
    );
    const periodIds = Array.from(new Set(schedules.map((s) => s.periodId)));
    const roomIds = Array.from(
      new Set(schedules.map((s) => s.roomId).filter(Boolean)),
    ) as string[];
    const teacherIds = Array.from(
      new Set(schedules.map((s) => s.teacherId).filter(Boolean)),
    ) as number[];
    const [periods, rooms, teachers] = await Promise.all([
      periodIds.length > 0
        ? this.db.period.findMany({ where: { id: { in: periodIds } } })
        : ([] as any[]),
      roomIds.length > 0
        ? this.db.room.findMany({ where: { id: { in: roomIds } } })
        : ([] as any[]),
      teacherIds.length > 0
        ? this.db.user.findMany({
            where: { id: { in: teacherIds } },
            include: { profile: true },
          })
        : ([] as any[]),
    ]);
    const periodMap = new Map<string, any>(
      periods.map((p: any) => [p.id, p] as [string, any]),
    );
    const roomMap = new Map<string, any>(
      rooms.map((r: any) => [r.id, r] as [string, any]),
    );
    const teacherMap = new Map<number, any>(
      teachers.map((t: any) => [t.id, t] as [number, any]),
    );
    return {
      schedules: schedules.map((s) => ({
        id: s.id,
        school_id: s.schoolId,
        class_id: (s as { classId?: string | null }).classId ?? null,
        teacher_id: s.teacherId ? String(s.teacherId) : null,
        subject: (s as { subject?: string | null }).subject ?? '',
        grade: (s as { grade?: string | null }).grade ?? '',
        period_id: s.periodId,
        day_of_week: Object.entries(
          TeacherExtraController.DAY_OF_WEEK_MAP,
        ).find(([_, n]) => n === s.dayOfWeek)?.[0],
        day: Object.entries(TeacherExtraController.DAY_OF_WEEK_MAP).find(
          ([_, n]) => n === s.dayOfWeek,
        )?.[0],
        start_time:
          (s as { startTime?: string | null }).startTime ??
          periodMap.get(s.periodId)?.startTime ??
          null,
        end_time:
          (s as { endTime?: string | null }).endTime ??
          periodMap.get(s.periodId)?.endTime ??
          null,
        academic_year:
          (s as { academicYear?: string | null }).academicYear ?? '2024-25',
        is_active: (s as { isActive?: boolean }).isActive !== false,
        notes: (s as { notes?: string | null }).notes ?? null,
        period: (() => {
          const p = periodMap.get(s.periodId);
          return p
            ? {
                id: p.id,
                period_number: p.periodNumber,
                start_time: p.startTime,
                end_time: p.endTime,
              }
            : null;
        })(),
        room: (() => {
          const r = s.roomId ? roomMap.get(s.roomId) : undefined;
          return r
            ? {
                id: r.id,
                room_number: r.roomNumber ?? r.name,
                room_name: r.roomName ?? null,
                capacity: r.capacity ?? null,
              }
            : null;
        })(),
        teacher: (() => {
          const t = s.teacherId ? teacherMap.get(s.teacherId) : undefined;
          return t
            ? {
                id: String(t.id),
                full_name: t.profile?.fullName ?? t.email,
                email: t.email,
              }
            : null;
        })(),
      })),
    };
  }

  @Get('assignments')
  async listAssignments(
    @CurrentUser() user: { id: number },
    @Query('school_id') schoolId?: string,
    @Query('type') type?: string,
  ) {
    const teacherSchools = await this.db.teacherSchool.findMany({
      where: { teacherId: user.id, ...(schoolId ? { schoolId } : {}) },
      select: { schoolId: true },
    });
    const allowedSchoolIds = teacherSchools.map((s) => s.schoolId);
    if (!allowedSchoolIds.length) return { assignments: [] };

    const typeFilter = type ? String(type).toUpperCase() : undefined;

    let assignments: Awaited<ReturnType<typeof this.db.assignment.findMany>> =
      [];

    if (typeFilter === 'COURSE') {
      // Course assignments: find those linked to courses accessible by teacher's schools
      const courseAccess = await this.db.courseAccess.findMany({
        where: { schoolId: { in: allowedSchoolIds } },
        select: { courseId: true },
      });
      const accessibleCourseIds = [
        ...new Set(courseAccess.map((c) => c.courseId)),
      ];
      const chapterIds = accessibleCourseIds.length
        ? (
            await this.db.chapter.findMany({
              where: { courseId: { in: accessibleCourseIds } },
              select: { id: true },
            })
          ).map((ch) => ch.id)
        : [];

      assignments = await this.db.assignment.findMany({
        where: {
          assignmentType: 'COURSE',
          OR: [
            ...(chapterIds.length ? [{ chapterId: { in: chapterIds } }] : []),
            ...(accessibleCourseIds.length
              ? [{ courseId: { in: accessibleCourseIds } }]
              : []),
            { teacherId: user.id, schoolId: { in: allowedSchoolIds } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        include: {
          chapter: { select: { courseId: true } },
          _count: { select: { submissions: true } },
          grade: { select: { name: true } },
          course: { select: { title: true } },
        },
      });
    } else {
      assignments = await this.db.assignment.findMany({
        where: {
          teacherId: user.id,
          schoolId: { in: allowedSchoolIds },
          ...(typeFilter ? { assignmentType: typeFilter } : {}),
        },
        orderBy: { createdAt: 'desc' },
        include: {
          chapter: { select: { courseId: true } },
          _count: { select: { submissions: true } },
          grade: { select: { name: true } },
          course: { select: { title: true } },
        },
      });
    }

    const assignmentIds = assignments.map((a) => a.id);
    const submissionSets = assignmentIds.length
      ? await this.db.assignmentSubmission.groupBy({
          by: ['assignmentId'],
          where: { assignmentId: { in: assignmentIds }, status: 'graded' },
          _avg: { score: true },
          _count: { _all: true },
        })
      : [];
    const avgScoreMap = new Map(
      submissionSets.map((s) => [s.assignmentId, s._avg.score ?? 0]),
    );
    const submissionCountMap = new Map(
      submissionSets.map((s) => [s.assignmentId, s._count._all]),
    );

    return {
      assignments: assignments.map((a) => ({
        id: a.id,
        title: a.title,
        description: a.description,
        assignment_type: (a as any).assignmentType ?? 'COURSE',
        due_date: a.dueDate?.toISOString() ?? null,
        total_marks: a.totalMarks ?? 0,
        school_id: a.schoolId,
        grade_id: a.gradeId,
        grade_name: (a as any).grade?.name ?? null,
        course_id: a.courseId,
        course_title: (a as any).course?.title ?? null,
        subject: a.subject,
        is_published: a.isPublished,
        retake_enabled: a.retakeEnabled,
        retake_rule: a.retakeScoringRule,
        retake_window_open: a.retakeWindowOpen,
        submission_count: (a as any)._count?.submissions ?? 0,
        graded_count: submissionCountMap.get(a.id) ?? 0,
        average_score: avgScoreMap.get(a.id) ?? null,
        academic_year: (a as any).academicYear ?? null,
      })),
    };
  }

  @Post('assignments')
  async createAssignment(
    @CurrentUser() user: { id: number },
    @Body() body: Record<string, unknown>,
  ) {
    let schoolId = String(body.schoolId ?? body.school_id ?? '').trim();
    const title = String(body.title ?? '').trim();
    if (!title) {
      throw new BadRequestException('title is required');
    }
    if (!schoolId) {
      const firstSchool = await this.db.teacherSchool.findFirst({
        where: { teacherId: user.id },
        select: { schoolId: true },
      });
      schoolId = firstSchool?.schoolId ?? '';
    }
    if (!schoolId) {
      throw new BadRequestException('No assigned school found for teacher');
    }
    const teacherSchool = await this.db.teacherSchool.findFirst({
      where: { schoolId, teacherId: user.id },
    });
    if (!teacherSchool)
      throw new ForbiddenException('Not assigned to this school');

    const rawType = String(
      body.assignmentType ?? body.assignment_type ?? 'DAILY',
    ).toUpperCase();
    const assignmentType = rawType === 'COURSE' ? 'COURSE' : 'DAILY';

    // COURSE assignments need a chapter context; DAILY assignments are school-scoped and need none
    let chapterId: string | null = null;
    let linkedCourseId: string | null = body.courseId
      ? String(body.courseId)
      : null;
    if (assignmentType === 'COURSE') {
      const schoolCourses = await this.db.courseAccess.findMany({
        where: { schoolId },
        select: { courseId: true },
        orderBy: { createdAt: 'asc' },
      });
      const schoolCourseIds = [
        ...new Set(schoolCourses.map((c) => c.courseId)),
      ];
      if (!schoolCourseIds.length) {
        throw new BadRequestException(
          'No courses are assigned to this school yet. Please ask admin to assign/publish a course first.',
        );
      }
      const firstChapter = await this.db.chapter.findFirst({
        where: { courseId: { in: schoolCourseIds } },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, courseId: true },
      });
      if (!firstChapter) {
        throw new BadRequestException(
          "No chapters found for this school's courses. Please ask admin to create course content first.",
        );
      }
      chapterId = firstChapter.id;
      linkedCourseId = linkedCourseId ?? firstChapter.courseId;
    }

    const rawPublishScope = String(body.publishScope ?? '');
    const publishScope = ['grade', 'section', 'selected_students'].includes(
      rawPublishScope,
    )
      ? rawPublishScope
      : 'grade';
    const publishedGradeIds = Array.isArray(body.publishedGradeIds)
      ? (body.publishedGradeIds as unknown[]).map(String)
      : [];
    const publishedSectionIds = Array.isArray(body.publishedSectionIds)
      ? (body.publishedSectionIds as unknown[]).map(String)
      : [];

    const assignment = await this.db.assignment.create({
      data: {
        chapterId: chapterId ?? null,
        courseId: linkedCourseId ?? null,
        schoolId,
        teacherId: user.id,
        gradeId: body.gradeId ? String(body.gradeId) : null,
        subject: body.subject ? String(body.subject) : null,
        assignmentType,
        academicYear: body.academicYear ? String(body.academicYear) : null,
        title,
        description: body.description ? String(body.description) : null,
        instructions: body.instructions ? String(body.instructions) : null,
        dueDate: body.dueDate ? new Date(String(body.dueDate)) : null,
        totalMarks: body.totalMarks ? Number(body.totalMarks) : null,
        isPublished: !!body.isPublished,
        publishScope,
        publishedGradeIds,
        publishedSectionIds,
        retakeEnabled: !!body.retakeEnabled,
        maxRetakeAttempts:
          body.maxRetakeAttempts != null
            ? Number(body.maxRetakeAttempts)
            : null,
        retakeScoringRule:
          String(body.retakeScoringRule ?? 'latest').toLowerCase() === 'highest'
            ? 'highest'
            : 'latest',
      },
    });

    // Notify targeted students when published
    if (assignment.isPublished) {
      await this.notifyTargetedStudents(assignment.id, schoolId, assignment);
    }

    const questions = Array.isArray(body.questions)
      ? (body.questions as Array<Record<string, unknown>>)
      : [];
    if (questions.length) {
      await Promise.all(
        questions.map((q, index) =>
          this.db.assignmentQuestion.create({
            data: {
              assignmentId: assignment.id,
              questionType:
                String(
                  q.question_type ?? q.questionType ?? 'MCQ',
                ).toLowerCase() === 'fillblank'
                  ? 'FillBlank'
                  : 'MCQ',
              questionText: String(
                q.question_text ?? q.questionText ?? '',
              ).trim(),
              options: Array.isArray(q.options)
                ? (q.options
                    .map((x) => String(x).trim())
                    .filter(Boolean) as unknown as Prisma.InputJsonValue)
                : undefined,
              correctAnswer:
                String(q.correct_answer ?? q.correctAnswer ?? '').trim() ||
                null,
              marks: Number(q.marks ?? 1) > 0 ? Number(q.marks ?? 1) : 1,
              sortOrder: index + 1,
            },
          }),
        ),
      );
    }
    return { assignment };
  }

  @Get('assignments/:assignmentId')
  async getAssignment(
    @CurrentUser() user: { id: number },
    @Param('assignmentId') assignmentId: string,
  ) {
    const assignment = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      include: {
        questions: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (
      !assignment ||
      !(await this.canTeacherAccessAssignment(user.id, assignment))
    ) {
      throw new NotFoundException('Assignment not found');
    }
    return {
      assignment: {
        id: assignment.id,
        title: assignment.title,
        description: assignment.description,
        due_date: assignment.dueDate?.toISOString() ?? null,
        total_marks: assignment.totalMarks,
        subject: assignment.subject,
        school_id: assignment.schoolId,
        is_published: assignment.isPublished,
        retake_enabled: assignment.retakeEnabled,
        questions: assignment.questions.map((q) => ({
          id: q.id,
          question_type: q.questionType,
          question_text: q.questionText,
          options: q.options,
          correct_answer: q.correctAnswer,
          marks: q.marks,
        })),
      },
    };
  }

  @Patch('assignments/:assignmentId')
  async updateAssignment(
    @CurrentUser() user: { id: number },
    @Param('assignmentId') assignmentId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const current = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        teacherId: true,
        schoolId: true,
        courseId: true,
        chapterId: true,
        isPublished: true,
      },
    });
    if (
      !current ||
      !(await this.canTeacherAccessAssignment(user.id, current))
    ) {
      throw new NotFoundException('Assignment not found');
    }

    const wasPublished = current.isPublished;
    const updated = await this.db.assignment.update({
      where: { id: assignmentId },
      data: {
        title: body.title != null ? String(body.title).trim() : undefined,
        description:
          body.description != null ? String(body.description) : undefined,
        subject: body.subject != null ? String(body.subject) : undefined,
        dueDate:
          body.dueDate != null ? new Date(String(body.dueDate)) : undefined,
        totalMarks:
          body.totalMarks != null ? Number(body.totalMarks) : undefined,
        isPublished: body.isPublished != null ? !!body.isPublished : undefined,
        publishScope:
          body.publishScope != null
            ? ['grade', 'section', 'selected_students'].includes(
                String(body.publishScope),
              )
              ? String(body.publishScope)
              : 'grade'
            : undefined,
        publishedGradeIds: Array.isArray(body.publishedGradeIds)
          ? (body.publishedGradeIds as unknown[]).map(String)
          : undefined,
        publishedSectionIds: Array.isArray(body.publishedSectionIds)
          ? (body.publishedSectionIds as unknown[]).map(String)
          : undefined,
      },
    });

    // Notify students when an assignment is first published via PATCH
    if (!wasPublished && updated.isPublished && updated.schoolId) {
      await this.notifyTargetedStudents(
        assignmentId,
        updated.schoolId,
        updated,
      );
    }

    if (Array.isArray(body.questions)) {
      const questions = body.questions as Array<Record<string, unknown>>;
      await this.db.assignmentQuestion.deleteMany({ where: { assignmentId } });
      if (questions.length) {
        await Promise.all(
          questions.map((q, index) =>
            this.db.assignmentQuestion.create({
              data: {
                assignmentId,
                questionType:
                  String(
                    q.question_type ?? q.questionType ?? 'MCQ',
                  ).toLowerCase() === 'fillblank'
                    ? 'FillBlank'
                    : 'MCQ',
                questionText: String(
                  q.question_text ?? q.questionText ?? '',
                ).trim(),
                options: Array.isArray(q.options)
                  ? (q.options
                      .map((x) => String(x).trim())
                      .filter(Boolean) as unknown as Prisma.InputJsonValue)
                  : undefined,
                correctAnswer:
                  String(q.correct_answer ?? q.correctAnswer ?? '').trim() ||
                  null,
                marks: Number(q.marks ?? 1) > 0 ? Number(q.marks ?? 1) : 1,
                sortOrder: index + 1,
              },
            }),
          ),
        );
      }
    }

    return { assignment: updated };
  }

  @Delete('assignments/:assignmentId')
  async deleteAssignment(
    @CurrentUser() user: { id: number },
    @Param('assignmentId') assignmentId: string,
  ) {
    const assignment = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        teacherId: true,
        schoolId: true,
        courseId: true,
        chapterId: true,
      },
    });
    if (
      !assignment ||
      !(await this.canTeacherAccessAssignment(user.id, assignment))
    ) {
      throw new NotFoundException('Assignment not found');
    }

    await this.db.$transaction([
      this.db.retakeGrant.deleteMany({ where: { assignmentId } }),
      this.db.assignmentSubmission.deleteMany({ where: { assignmentId } }),
      this.db.assignmentQuestion.deleteMany({ where: { assignmentId } }),
      this.db.assignment.delete({ where: { id: assignmentId } }),
    ]);

    return { success: true };
  }

  @Patch('assignments/:assignmentId/retake-settings')
  async updateRetakeSettings(
    @CurrentUser() user: { id: number },
    @Param('assignmentId') assignmentId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const assignment = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        teacherId: true,
        schoolId: true,
        courseId: true,
        chapterId: true,
        retakeEnabled: true,
        maxRetakeAttempts: true,
        retakeScoringRule: true,
        retakeWindowOpen: true,
        retakeAccessScope: true,
      },
    });
    if (
      !assignment ||
      !(await this.canTeacherAccessAssignment(user.id, assignment))
    ) {
      throw new NotFoundException('Assignment not found');
    }
    const updated = await this.db.assignment.update({
      where: { id: assignmentId },
      data: {
        retakeEnabled:
          body.retakeEnabled == null
            ? assignment.retakeEnabled
            : !!body.retakeEnabled,
        maxRetakeAttempts:
          body.maxRetakeAttempts == null
            ? assignment.maxRetakeAttempts
            : Number(body.maxRetakeAttempts),
        retakeScoringRule:
          String(
            body.retakeScoringRule ?? assignment.retakeScoringRule ?? 'latest',
          ).toLowerCase() === 'highest'
            ? 'highest'
            : 'latest',
        retakeWindowOpen:
          body.retakeWindowOpen == null
            ? assignment.retakeWindowOpen
            : !!body.retakeWindowOpen,
        retakeAccessScope:
          String(
            body.retakeAccessScope ?? assignment.retakeAccessScope ?? 'all',
          ).toLowerCase() === 'selected'
            ? 'selected'
            : 'all',
      },
    });
    const submittedStudents = await this.db.assignmentSubmission.findMany({
      where: { assignmentId },
      distinct: ['studentId'],
      select: { studentId: true },
    });
    await Promise.all(
      submittedStudents.map((s) =>
        this.recomputeStudentScores(s.studentId, updated.courseId),
      ),
    );
    return { assignment: updated };
  }

  @Post('assignments/:assignmentId/retake-grants')
  async grantRetake(
    @CurrentUser() user: { id: number },
    @Param('assignmentId') assignmentId: string,
    @Body() body: { studentIds?: Array<string | number>; isActive?: boolean },
  ) {
    const assignment = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        teacherId: true,
        schoolId: true,
        courseId: true,
        chapterId: true,
      },
    });
    if (
      !assignment ||
      !(await this.canTeacherAccessAssignment(user.id, assignment))
    ) {
      throw new NotFoundException('Assignment not found');
    }
    const studentIds = (body.studentIds ?? [])
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0);
    if (!studentIds.length)
      throw new BadRequestException('studentIds are required');

    await Promise.all(
      studentIds.map((studentId) =>
        this.db.retakeGrant.upsert({
          where: { assignmentId_studentId: { assignmentId, studentId } },
          create: {
            assignmentId,
            studentId,
            grantedByTeacherId: user.id,
            isActive: body.isActive ?? true,
          },
          update: {
            grantedByTeacherId: user.id,
            isActive: body.isActive ?? true,
            grantedAt: new Date(),
          },
        }),
      ),
    );
    const fullAssignment = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      select: { title: true, maxRetakeAttempts: true },
    });
    await this.db.notification.createMany({
      data: studentIds.map((studentId) => ({
        userId: studentId,
        senderId: user.id,
        title: `Retake granted: ${fullAssignment?.title ?? 'Assignment'}`,
        message: `Your teacher has allowed a retake for "${fullAssignment?.title ?? 'an assignment'}". Attempts remaining: ${fullAssignment?.maxRetakeAttempts ?? 'Unlimited'}.`,
        mode: 'assignment_due',
      })),
    });
    return { success: true, granted_count: studentIds.length };
  }

  @Post('assignments/:assignmentId/retake-open-all')
  async openRetakeForAll(
    @CurrentUser() user: { id: number },
    @Param('assignmentId') assignmentId: string,
    @Body() body: { gradeId?: string },
  ) {
    const assignment = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        teacherId: true,
        schoolId: true,
        courseId: true,
        chapterId: true,
        title: true,
        maxRetakeAttempts: true,
      },
    });
    if (
      !assignment ||
      !(await this.canTeacherAccessAssignment(user.id, assignment))
    ) {
      throw new NotFoundException('Assignment not found');
    }
    if (!assignment.schoolId)
      throw new BadRequestException('Assignment has no associated school');

    // Open window on the assignment itself
    await this.db.assignment.update({
      where: { id: assignmentId },
      data: {
        retakeEnabled: true,
        retakeWindowOpen: true,
        retakeAccessScope: body.gradeId ? 'selected' : 'all',
      },
    });

    // Find all eligible students
    const enrollments = await this.db.studentSchool.findMany({
      where: {
        schoolId: assignment.schoolId,
        isActive: true,
      },
      select: { studentId: true, grade: true },
    });

    let studentIds = enrollments.map((e) => e.studentId);

    if (body.gradeId) {
      const grade = await this.db.grade.findUnique({
        where: { id: body.gradeId },
        select: { name: true },
      });
      if (grade) {
        studentIds = enrollments
          .filter((e) => e.grade === grade.name)
          .map((e) => e.studentId);
      }
    }

    // Only grant to students who have already submitted at least once
    const submittedStudentIds = (
      await this.db.assignmentSubmission.findMany({
        where: { assignmentId, studentId: { in: studentIds } },
        distinct: ['studentId'],
        select: { studentId: true },
      })
    ).map((s) => s.studentId);

    if (submittedStudentIds.length > 0) {
      await Promise.all(
        submittedStudentIds.map((studentId) =>
          this.db.retakeGrant.upsert({
            where: { assignmentId_studentId: { assignmentId, studentId } },
            create: {
              assignmentId,
              studentId,
              grantedByTeacherId: user.id,
              isActive: true,
              specific: false,
            },
            update: { isActive: true, grantedAt: new Date() },
          }),
        ),
      );
      await this.db.notification.createMany({
        data: submittedStudentIds.map((studentId) => ({
          userId: studentId,
          senderId: user.id,
          title: `Retake now available: ${assignment.title}`,
          message: `Retake window is now open for "${assignment.title}". Attempts allowed: ${assignment.maxRetakeAttempts ?? 'Unlimited'}.`,
          mode: 'assignment_due',
        })),
      });
    }

    return { success: true, retake_granted_count: submittedStudentIds.length };
  }

  @Post('assignments/:assignmentId/retake-close')
  async closeRetakeWindow(
    @CurrentUser() user: { id: number },
    @Param('assignmentId') assignmentId: string,
  ) {
    const assignment = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        teacherId: true,
        schoolId: true,
        courseId: true,
        chapterId: true,
      },
    });
    if (
      !assignment ||
      !(await this.canTeacherAccessAssignment(user.id, assignment))
    ) {
      throw new NotFoundException('Assignment not found');
    }
    await this.db.assignment.update({
      where: { id: assignmentId },
      data: { retakeWindowOpen: false },
    });
    await this.db.retakeGrant.updateMany({
      where: { assignmentId },
      data: { isActive: false },
    });
    return { success: true };
  }

  @Post('assignments/batch-grade')
  async batchGrade(
    @CurrentUser() user: { id: number },
    @Body()
    body: {
      grades: Array<{
        submissionId: string;
        assignmentId: string;
        score: number;
        feedback?: string;
      }>;
    },
  ) {
    if (!Array.isArray(body.grades) || body.grades.length === 0) {
      throw new BadRequestException('grades array is required');
    }
    const results: string[] = [];
    const affectedStudents = new Map<
      number,
      { schoolId: string | null; courseId: string | null }
    >();

    for (const g of body.grades) {
      const assignment = await this.db.assignment.findUnique({
        where: { id: g.assignmentId },
        select: {
          id: true,
          teacherId: true,
          schoolId: true,
          courseId: true,
          chapterId: true,
          title: true,
          totalMarks: true,
        },
      });
      if (
        !assignment ||
        !(await this.canTeacherAccessAssignment(user.id, assignment))
      )
        continue;

      const submission = await this.db.assignmentSubmission.findFirst({
        where: { id: g.submissionId, assignmentId: g.assignmentId },
      });
      if (!submission) continue;

      const updated = await this.db.assignmentSubmission.update({
        where: { id: g.submissionId },
        data: {
          score: Number(g.score),
          feedback: g.feedback ?? null,
          status: 'graded',
          gradedAt: new Date(),
          gradedByTeacherId: user.id,
        },
      });
      results.push(g.submissionId);
      affectedStudents.set(updated.studentId, {
        schoolId: assignment.schoolId ?? null,
        courseId: assignment.courseId ?? null,
      });

      await this.db.notification.create({
        data: {
          userId: updated.studentId,
          senderId: user.id,
          title: `Assignment graded: ${assignment.title}`,
          message: `Your assignment "${assignment.title}" has been graded. Score: ${updated.score ?? 0}/${assignment.totalMarks ?? updated.maxScore ?? 0}.`,
          mode: 'grade_posted',
        },
      });
    }

    // Recompute per-student scores and school-wide summary for all affected students
    await Promise.all(
      [...affectedStudents.entries()].map(
        async ([sid, { schoolId, courseId }]) => {
          await this.recomputeStudentScores(sid, courseId);
          await this.recomputeStudentScoreSummary(sid, schoolId);
        },
      ),
    );

    return { success: true, graded_count: results.length };
  }

  @Get('assignments/:assignmentId/submissions')
  async listAssignmentSubmissions(
    @CurrentUser() user: { id: number },
    @Param('assignmentId') assignmentId: string,
  ) {
    const assignment = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        teacherId: true,
        schoolId: true,
        courseId: true,
        chapterId: true,
      },
    });
    if (
      !assignment ||
      !(await this.canTeacherAccessAssignment(user.id, assignment))
    ) {
      throw new NotFoundException('Assignment not found');
    }
    const submissions = await this.db.assignmentSubmission.findMany({
      where: { assignmentId },
      orderBy: [{ studentId: 'asc' }, { attemptNumber: 'asc' }],
      include: { student: { include: { profile: true } } },
    });
    return {
      submissions: submissions.map((s) => ({
        id: s.id,
        student_id: s.studentId,
        student_name:
          s.student.profile?.fullName ??
          s.student.email ??
          `Student ${s.studentId}`,
        attempt_number: s.attemptNumber,
        status: s.status,
        score: s.score,
        max_score: s.maxScore,
        feedback: s.feedback ?? null,
        submitted_at: s.submittedAt.toISOString(),
        graded_at: s.gradedAt?.toISOString() ?? null,
        is_retake: s.isRetake,
      })),
    };
  }

  @Patch('assignments/:assignmentId/submissions/:submissionId/grade')
  async gradeSubmission(
    @CurrentUser() user: { id: number },
    @Param('assignmentId') assignmentId: string,
    @Param('submissionId') submissionId: string,
    @Body() body: { score?: number; feedback?: string; status?: string },
  ) {
    const assignment = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        teacherId: true,
        schoolId: true,
        courseId: true,
        chapterId: true,
      },
    });
    if (
      !assignment ||
      !(await this.canTeacherAccessAssignment(user.id, assignment))
    ) {
      throw new NotFoundException('Assignment not found');
    }
    const submission = await this.db.assignmentSubmission.findFirst({
      where: { id: submissionId, assignmentId },
    });
    if (!submission) throw new NotFoundException('Submission not found');

    const updated = await this.db.assignmentSubmission.update({
      where: { id: submissionId },
      data: {
        score: body.score == null ? submission.score : Number(body.score),
        feedback:
          body.feedback == null ? submission.feedback : String(body.feedback),
        status: body.status ? String(body.status) : 'graded',
        gradedAt: new Date(),
        gradedByTeacherId: user.id,
      },
    });
    await this.recomputeStudentScores(updated.studentId, assignment.courseId);
    // Also update school-wide summary
    await this.recomputeStudentScoreSummary(
      updated.studentId,
      assignment.schoolId ?? null,
    );

    // Notify student
    const fullAssignment = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      select: { title: true, totalMarks: true },
    });
    if (fullAssignment) {
      await this.db.notification.create({
        data: {
          userId: updated.studentId,
          senderId: user.id,
          title: `Assignment graded: ${fullAssignment.title}`,
          message: `Your assignment "${fullAssignment.title}" has been graded. Score: ${updated.score ?? 0}/${fullAssignment.totalMarks ?? updated.maxScore ?? 0}.`,
          mode: 'grade_posted',
        },
      });
    }
    return { submission: updated };
  }

  @Get('assignments/:assignmentId/attempt-history/:studentId')
  async getAttemptHistory(
    @CurrentUser() user: { id: number },
    @Param('assignmentId') assignmentId: string,
    @Param('studentId') studentId: string,
  ) {
    const assignment = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        teacherId: true,
        schoolId: true,
        courseId: true,
        chapterId: true,
      },
    });
    if (
      !assignment ||
      !(await this.canTeacherAccessAssignment(user.id, assignment))
    ) {
      throw new NotFoundException('Assignment not found');
    }
    const studentIdNum = Number(studentId);
    const attempts = await this.db.assignmentSubmission.findMany({
      where: { assignmentId, studentId: studentIdNum },
      orderBy: { attemptNumber: 'asc' },
      select: {
        id: true,
        attemptNumber: true,
        status: true,
        score: true,
        maxScore: true,
        submittedAt: true,
        gradedAt: true,
      },
    });
    return {
      attempts: attempts.map((a) => ({
        id: a.id,
        attempt_number: a.attemptNumber,
        status: a.status,
        score: a.score,
        max_score: a.maxScore,
        submitted_at: a.submittedAt.toISOString(),
        graded_at: a.gradedAt?.toISOString() ?? null,
      })),
    };
  }

  @Get('assignments/:assignmentId/progress-dashboard')
  async getAssignmentProgressDashboard(
    @CurrentUser() user: { id: number },
    @Param('assignmentId') assignmentId: string,
  ) {
    const assignment = await this.db.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        teacherId: true,
        schoolId: true,
        courseId: true,
        chapterId: true,
      },
    });
    if (
      !assignment ||
      !(await this.canTeacherAccessAssignment(user.id, assignment))
    ) {
      throw new NotFoundException('Assignment not found');
    }
    const latestByStudent = await this.db.assignmentSubmission.findMany({
      where: { assignmentId },
      orderBy: [{ studentId: 'asc' }, { attemptNumber: 'desc' }],
      distinct: ['studentId'],
      select: { studentId: true, score: true, status: true, submittedAt: true },
    });

    const scores = latestByStudent.map((s) => Number(s.score ?? 0));
    const averageScore = scores.length
      ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2))
      : 0;
    const maxScore = scores.length ? Math.max(...scores) : 0;
    const minScore = scores.length ? Math.min(...scores) : 0;
    const submittedCount = latestByStudent.filter((s) =>
      ['submitted', 'graded', 'late'].includes(String(s.status)),
    ).length;

    return {
      dashboard: {
        assignment_id: assignmentId,
        average_score: averageScore,
        highest_score: maxScore,
        lowest_score: minScore,
        submission_completion_rate:
          latestByStudent.length > 0
            ? Math.round((submittedCount / latestByStudent.length) * 100)
            : 0,
        students_count: latestByStudent.length,
      },
    };
  }

  @Get('assignment-analytics')
  async getTeacherAssignmentAnalytics(
    @CurrentUser() user: { id: number },
    @Query('school_id') schoolId?: string,
  ) {
    const teacherSchools = await this.db.teacherSchool.findMany({
      where: { teacherId: user.id, ...(schoolId ? { schoolId } : {}) },
      select: { schoolId: true },
    });
    const schoolIds = teacherSchools.map((s) => s.schoolId);
    const courseAccess = schoolIds.length
      ? await this.db.courseAccess.findMany({
          where: { schoolId: { in: schoolIds } },
          select: { courseId: true },
        })
      : [];
    const visibleCourseIds = [...new Set(courseAccess.map((c) => c.courseId))];
    const assignments = await this.db.assignment.findMany({
      where: {
        isPublished: true,
        OR: [
          { teacherId: user.id },
          { schoolId: { in: schoolIds } },
          { courseId: { in: visibleCourseIds } },
          { chapter: { courseId: { in: visibleCourseIds } } },
        ],
      },
      select: {
        id: true,
        title: true,
        subject: true,
        totalMarks: true,
        assignmentType: true,
        retakeEnabled: true,
        retakeScoringRule: true,
      },
    });
    const assignmentIds = assignments.map((a) => a.id);
    if (!assignmentIds.length) {
      return {
        analytics: {
          summary: {},
          assignments: [],
          top_students: [],
          subject_breakdown: [],
        },
      };
    }
    const allSubmissions = await this.db.assignmentSubmission.findMany({
      where: { assignmentId: { in: assignmentIds } },
      include: { student: { include: { profile: true } } },
      orderBy: [
        { studentId: 'asc' },
        { assignmentId: 'asc' },
        { attemptNumber: 'asc' },
      ],
    });

    // Canonical deduplication: graded-only, respect retakeScoringRule per assignment
    const asgnRuleMap = new Map(
      assignments.map((a) => [
        a.id,
        String(a.retakeScoringRule ?? 'latest').toLowerCase(),
      ]),
    );
    const bestByKey = new Map<string, (typeof allSubmissions)[0]>();
    for (const s of allSubmissions) {
      if (s.status !== 'graded') continue;
      const key = `${s.studentId}:${s.assignmentId}`;
      const rule = asgnRuleMap.get(s.assignmentId) ?? 'latest';
      const existing = bestByKey.get(key);
      if (!existing) {
        bestByKey.set(key, s);
      } else if (
        rule === 'highest' &&
        Number(s.score ?? 0) > Number(existing.score ?? 0)
      ) {
        bestByKey.set(key, s);
      } else if (rule !== 'highest') {
        // latest: ascending order means last write wins
        bestByKey.set(key, s);
      }
    }
    const bestSubmissions = [...bestByKey.values()];

    // Assignment performance table
    const assignmentRows = assignments.map((a) => {
      const rows = bestSubmissions.filter((s) => s.assignmentId === a.id);
      const scores = rows
        .filter((s) => s.status === 'graded')
        .map((s) => Number(s.score ?? 0));
      const maxScores = rows
        .filter((s) => s.status === 'graded')
        .map((s) => Number(s.maxScore ?? 0));
      const totalScore = scores.reduce((sum, v) => sum + v, 0);
      const totalMax = maxScores.reduce((sum, v) => sum + v, 0);
      const retakeCount = allSubmissions.filter(
        (s) => s.assignmentId === a.id && s.attemptNumber > 1,
      ).length;
      return {
        assignment_id: a.id,
        title: a.title,
        subject: a.subject,
        assignment_type: a.assignmentType ?? 'DAILY',
        retake_enabled: a.retakeEnabled,
        total_submissions: rows.length,
        graded_count: scores.length,
        retake_count: retakeCount,
        avg_score_percentage:
          totalMax > 0 ? Number(((totalScore / totalMax) * 100).toFixed(2)) : 0,
        highest_score: scores.length ? Math.max(...scores) : 0,
        lowest_score: scores.length ? Math.min(...scores) : 0,
      };
    });

    // Student leaderboard
    const byStudent = new Map<
      number,
      {
        name: string;
        courseTotal: number;
        courseMax: number;
        dailyTotal: number;
        dailyMax: number;
      }
    >();
    for (const s of bestSubmissions) {
      const asgn = assignments.find((a) => a.id === s.assignmentId);
      const cur = byStudent.get(s.studentId) ?? {
        name:
          s.student.profile?.fullName ??
          s.student.email ??
          `Student ${s.studentId}`,
        courseTotal: 0,
        courseMax: 0,
        dailyTotal: 0,
        dailyMax: 0,
      };
      const score = Number(s.score ?? 0);
      const max = Number(s.maxScore ?? 0);
      if (asgn?.assignmentType === 'COURSE') {
        cur.courseTotal += score;
        cur.courseMax += max;
      } else {
        cur.dailyTotal += score;
        cur.dailyMax += max;
      }
      byStudent.set(s.studentId, cur);
    }
    const ranked = [...byStudent.entries()]
      .map(([id, row]) => {
        const coursePercent =
          row.courseMax > 0 ? (row.courseTotal / row.courseMax) * 100 : 0;
        const dailyPercent =
          row.dailyMax > 0 ? (row.dailyTotal / row.dailyMax) * 100 : 0;
        const overall = coursePercent * 0.6 + dailyPercent * 0.4;
        return {
          student_id: id,
          student_name: row.name,
          course_score: Number(coursePercent.toFixed(2)),
          daily_score: Number(dailyPercent.toFixed(2)),
          overall_score: Number(overall.toFixed(2)),
        };
      })
      .sort((a, b) => b.overall_score - a.overall_score)
      .map((r, idx) => ({ ...r, rank: idx + 1 }));

    // Subject breakdown
    const subjectMap = new Map<
      string,
      { total: number; max: number; count: number }
    >();
    for (const s of bestSubmissions) {
      const asgn = assignments.find((a) => a.id === s.assignmentId);
      const subj = asgn?.subject ?? 'General';
      const sm = subjectMap.get(subj) ?? { total: 0, max: 0, count: 0 };
      sm.total += Number(s.score ?? 0);
      sm.max += Number(s.maxScore ?? 0);
      sm.count += 1;
      subjectMap.set(subj, sm);
    }
    const subject_breakdown = [...subjectMap.entries()]
      .map(([subject, sm]) => ({
        subject,
        avg_score:
          sm.max > 0 ? Number(((sm.total / sm.max) * 100).toFixed(2)) : 0,
        submissions: sm.count,
      }))
      .sort((a, b) => b.avg_score - a.avg_score);

    const allScores = assignmentRows
      .filter((a) => a.graded_count > 0)
      .map((a) => a.avg_score_percentage);
    return {
      analytics: {
        summary: {
          assignments_count: assignments.length,
          total_submissions: bestSubmissions.length,
          graded_count: bestSubmissions.filter((s) => s.status === 'graded')
            .length,
          avg_score: allScores.length
            ? Number(
                (
                  allScores.reduce((a, b) => a + b, 0) / allScores.length
                ).toFixed(2),
              )
            : 0,
          retake_count: allSubmissions.filter((s) => s.attemptNumber > 1)
            .length,
        },
        assignments: assignmentRows,
        top_students: ranked.slice(0, 20),
        subject_breakdown,
      },
    };
  }
}
