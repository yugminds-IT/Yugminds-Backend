import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { DatabaseService } from '../../database/database.service';
import { Role } from '@prisma/client';

type JwtPayload = {
  sub: number;
  exp?: number;
  iat?: number;
};

export type RealtimeNotification = {
  id: string;
  title: string;
  message: string;
  type: string | null;
  is_read: boolean;
  created_at: string;
};

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((o) =>
  o.trim(),
) ?? ['http://localhost:3000'];

@Injectable()
@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: allowedOrigins, credentials: true },
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
  ) {}

  private getRoom(userId: number): string {
    return `user:${userId}`;
  }

  private extractToken(client: Socket): string | null {
    const fromAuth = client.handshake.auth?.token;
    if (typeof fromAuth === 'string' && fromAuth.trim()) {
      return fromAuth.replace(/^Bearer\s+/i, '').trim();
    }

    const authHeader = client.handshake.headers?.authorization;
    if (typeof authHeader === 'string' && authHeader.trim()) {
      return authHeader.replace(/^Bearer\s+/i, '').trim();
    }

    return null;
  }

  private async resolveUserId(client: Socket): Promise<number> {
    const token = this.extractToken(client);
    if (!token) {
      throw new UnauthorizedException('Missing socket auth token');
    }

    const accessSecret = this.config.get<string>('JWT_ACCESS_SECRET');
    if (!accessSecret || !String(accessSecret).trim()) {
      throw new UnauthorizedException('JWT access secret not configured');
    }

    const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
      secret: String(accessSecret),
    });
    if (!payload?.sub) {
      throw new UnauthorizedException('Invalid socket token payload');
    }

    const user = await this.db.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, tokenVersion: true, isActive: true },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not active');
    }

    return user.id;
  }

  private async buildDashboardStatsForUser(
    userId: number,
  ): Promise<Record<string, unknown>> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!user) return {};

    if (user.role === Role.admin) {
      const [
        totalSchools,
        totalTeachers,
        totalStudents,
        activeCourses,
        pendingLeaves,
      ] = await Promise.all([
        this.db.tenant.count(),
        this.db.user.count({ where: { role: Role.teacher, isActive: true } }),
        this.db.user.count({ where: { role: Role.student, isActive: true } }),
        this.db.course.count({ where: { isPublished: true } }),
        this.db.teacherLeave.count({ where: { status: 'pending' } }),
      ]);
      return {
        totalSchools,
        totalTeachers,
        totalStudents,
        activeCourses,
        pendingLeaves,
      };
    }

    if (user.role === Role.school_admin) {
      const sa = await this.db.schoolAdmin.findFirst({
        where: { userId },
        select: { schoolId: true },
      });
      const schoolId = sa?.schoolId ?? null;
      if (!schoolId) {
        return {
          totalStudents: 0,
          totalTeachers: 0,
          activeCourses: 0,
          pendingReports: 0,
          pendingLeaves: 0,
          averageAttendance: 0,
        };
      }
      const since = new Date();
      since.setDate(since.getDate() - 30);
      const [
        totalStudents,
        totalTeachers,
        activeCourses,
        pendingReports,
        pendingLeaves,
        attendanceAgg,
      ] = await Promise.all([
        this.db.studentSchool.count({ where: { schoolId, isActive: true } }),
        this.db.teacherSchool.count({ where: { schoolId } }),
        this.db.courseAccess.count({
          where: { schoolId, course: { isPublished: true } } as any,
        }),
        this.db.teacherReport.count({
          where: { schoolId, status: 'submitted' },
        }),
        this.db.teacherLeave.count({ where: { schoolId, status: 'pending' } }),
        this.db.attendance.groupBy({
          by: ['status'],
          where: { schoolId, date: { gte: since } },
          _count: { _all: true },
        }),
      ]);
      let totalAttendance = 0;
      let presentAttendance = 0;
      for (const row of attendanceAgg ?? []) {
        const c = row._count?._all ?? 0;
        totalAttendance += c;
        if (String(row.status ?? '').toLowerCase() === 'present')
          presentAttendance += c;
      }
      const averageAttendance =
        totalAttendance > 0
          ? Math.round((presentAttendance / totalAttendance) * 100)
          : 0;
      return {
        totalStudents,
        totalTeachers,
        activeCourses,
        pendingReports,
        pendingLeaves,
        averageAttendance,
      };
    }

    if (user.role === Role.teacher) {
      const schoolIds = (
        await this.db.teacherSchool.findMany({
          where: { teacherId: userId },
          select: { schoolId: true },
        })
      ).map((s) => s.schoolId);
      if (schoolIds.length === 0) {
        return {
          todaysClasses: 0,
          pendingReports: 0,
          totalClasses: 0,
          monthlyAttendance: 0,
          pendingLeaves: 0,
          totalStudents: 0,
        };
      }
      const now = new Date();
      const dayOfWeek = now.getUTCDay();
      const dayStart = new Date(now);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(now);
      dayEnd.setUTCHours(23, 59, 59, 999);
      const monthStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
      );
      const monthEnd = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth() + 1,
          0,
          23,
          59,
          59,
          999,
        ),
      );

      const assignments = await this.db.teacherSectionAssignment.findMany({
        where: { teacherId: userId, schoolId: { in: schoolIds } },
        include: { section: true },
      });
      const totalClasses = assignments.length;
      const bySchool = new Map<string, Set<string>>();
      for (const a of assignments) {
        if (!bySchool.has(a.schoolId)) bySchool.set(a.schoolId, new Set());
        const name = a.section?.name ?? '';
        if (name) bySchool.get(a.schoolId)?.add(name);
      }
      const studentCounts = await Promise.all(
        Array.from(bySchool.entries()).map(async ([sid, sections]) => {
          const sec = Array.from(sections);
          if (sec.length === 0) return 0;
          return this.db.studentSchool.count({
            where: { schoolId: sid, section: { in: sec }, isActive: true },
          });
        }),
      );
      const totalStudents = studentCounts.reduce((sum, n) => sum + n, 0);
      const schedulesToday = await this.db.classSchedule.findMany({
        where: {
          teacherId: userId,
          schoolId: { in: schoolIds },
          dayOfWeek,
          isActive: true,
        },
        select: { periodId: true },
      });
      const todaysClasses = new Set(schedulesToday.map((s) => s.periodId)).size;
      const [pendingReports, pendingLeaves, attendanceRows] = await Promise.all(
        [
          this.db.teacherReport.count({
            where: {
              teacherId: userId,
              schoolId: { in: schoolIds },
              reportDate: { gte: dayStart, lte: dayEnd },
              status: 'submitted',
            },
          }),
          this.db.teacherLeave.count({
            where: {
              teacherId: userId,
              schoolId: { in: schoolIds },
              status: 'pending',
            },
          }),
          this.db.attendance.findMany({
            where: {
              teacherId: userId,
              schoolId: { in: schoolIds },
              date: { gte: monthStart, lte: monthEnd },
            },
            select: { status: true, date: true },
          }),
        ],
      );
      const presentDays = new Set(
        attendanceRows
          .filter((a) => a.status === 'Present')
          .map((a) => a.date.toISOString().split('T')[0]),
      ).size;
      const totalAttendanceDays = new Set(
        attendanceRows.map((a) => a.date.toISOString().split('T')[0]),
      ).size;
      const monthlyAttendance =
        totalAttendanceDays > 0
          ? Math.round((presentDays / totalAttendanceDays) * 100)
          : 0;
      return {
        todaysClasses,
        pendingReports,
        totalClasses,
        monthlyAttendance,
        pendingLeaves,
        totalStudents,
      };
    }

    // Student
    const enrollments = await this.db.studentCourse.findMany({
      where: { studentId: userId },
      select: { courseId: true },
    });
    if (enrollments.length === 0) {
      const unreadNotifications = await this.db.notification.count({
        where: { userId, readAt: null, deletedAt: null },
      });
      return {
        activeCourses: 0,
        completedCourses: 0,
        pendingAssignments: 0,
        completedAssignments: 0,
        unreadNotifications,
      };
    }
    const courseIds = enrollments.map((e) => e.courseId);
    const [chapters, progressRows, unreadNotifications] = await Promise.all([
      this.db.chapter.findMany({
        where: { courseId: { in: courseIds } },
        select: { id: true, courseId: true },
      }),
      this.db.courseProgress.findMany({
        where: { studentId: userId, courseId: { in: courseIds } },
        select: { courseId: true, chapterId: true, progress: true },
      }),
      this.db.notification.count({
        where: { userId, readAt: null, deletedAt: null },
      }),
    ]);
    const chaptersByCourse = new Map<string, string[]>();
    for (const ch of chapters) {
      const arr = chaptersByCourse.get(ch.courseId) ?? [];
      arr.push(ch.id);
      chaptersByCourse.set(ch.courseId, arr);
    }
    const progressByCourse = new Map<
      string,
      Array<{ chapterId: string | null; progress: number }>
    >();
    for (const p of progressRows) {
      const arr = progressByCourse.get(p.courseId) ?? [];
      arr.push({ chapterId: p.chapterId ?? null, progress: p.progress ?? 0 });
      progressByCourse.set(p.courseId, arr);
    }
    let activeCourses = 0;
    let completedCourses = 0;
    for (const courseId of courseIds) {
      const courseChapters = chaptersByCourse.get(courseId) ?? [];
      const pRows = (progressByCourse.get(courseId) ?? []).filter(
        (p) => !!p.chapterId,
      );
      const totalChapters = courseChapters.length;
      const completedChapters = new Set(
        pRows
          .filter((p) => (p.progress ?? 0) >= 99 && p.chapterId)
          .map((p) => p.chapterId as string),
      ).size;
      const pct =
        totalChapters > 0
          ? Math.round((completedChapters / totalChapters) * 100)
          : 0;
      if (pct >= 100) completedCourses += 1;
      else activeCourses += 1;
    }
    const chapterIds = chapters.map((c) => c.id);
    const assignmentIds =
      chapterIds.length > 0
        ? await this.db.assignment.findMany({
            where: { chapterId: { in: chapterIds } },
            select: { id: true },
          })
        : [];
    const submissionCount =
      assignmentIds.length > 0
        ? await this.db.assignmentSubmission.count({
            where: {
              studentId: userId,
              assignmentId: { in: assignmentIds.map((a) => a.id) },
            },
          })
        : 0;
    const completedAssignments = submissionCount;
    const pendingAssignments = Math.max(
      0,
      assignmentIds.length - submissionCount,
    );
    return {
      activeCourses,
      completedCourses,
      pendingAssignments,
      completedAssignments,
      unreadNotifications,
    };
  }

  async handleConnection(client: Socket) {
    try {
      const userId = await this.resolveUserId(client);
      const room = this.getRoom(userId);
      await client.join(room);
      client.data.userId = userId;
      this.logger.debug(`Socket connected: ${client.id} -> ${room}`);
      const stats = await this.buildDashboardStatsForUser(userId);
      client.emit('dashboard:stats', stats);
    } catch (_err) {
      this.logger.warn(`Socket rejected: ${client.id}`);
      client.emit('socket:error', {
        message: 'Unauthorized socket connection',
      });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Socket disconnected: ${client.id}`);
  }

  @SubscribeMessage('notifications:sync')
  async handleNotificationsSync(
    @ConnectedSocket() client: Socket,
    @MessageBody() _body?: unknown,
  ) {
    const userId = Number(client.data.userId);
    if (!Number.isFinite(userId) || userId <= 0) return;

    const unreadCount = await this.db.notification.count({
      where: { userId, readAt: null, deletedAt: null },
    });
    client.emit('notification:unread_count', { count: unreadCount });
  }

  @SubscribeMessage('dashboard:sync')
  async handleDashboardSync(
    @ConnectedSocket() client: Socket,
    @MessageBody() _body?: unknown,
  ) {
    const userId = Number(client.data.userId);
    if (!Number.isFinite(userId) || userId <= 0) return;
    const stats = await this.buildDashboardStatsForUser(userId);
    client.emit('dashboard:stats', stats);
  }

  emitNotificationNew(userId: number, payload: RealtimeNotification): void {
    this.server.to(this.getRoom(userId)).emit('notification:new', payload);
  }

  emitNotificationRead(
    userId: number,
    payload: { notification_id?: string; mark_all?: boolean; read_at?: string },
  ): void {
    this.server.to(this.getRoom(userId)).emit('notification:read', payload);
  }

  emitUnreadCount(userId: number, count: number): void {
    this.server
      .to(this.getRoom(userId))
      .emit('notification:unread_count', { count });
  }

  emitToUser(
    userId: number,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    this.server.to(this.getRoom(userId)).emit(event, payload);
  }

  emitDashboardStats(userId: number, payload: Record<string, unknown>): void {
    this.server.to(this.getRoom(userId)).emit('dashboard:stats', payload);
  }

  async emitDashboardStatsForUser(userId: number): Promise<void> {
    const payload = await this.buildDashboardStatsForUser(userId);
    this.emitDashboardStats(userId, payload);
  }

  async emitDashboardStatsForUsers(userIds: number[]): Promise<void> {
    const uniqueUserIds = Array.from(new Set(userIds)).filter(
      (id) => Number.isFinite(id) && id > 0,
    );
    await Promise.all(
      uniqueUserIds.map((userId) => this.emitDashboardStatsForUser(userId)),
    );
  }
}
