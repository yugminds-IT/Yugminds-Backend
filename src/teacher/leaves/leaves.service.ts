import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { NotificationsService } from '../../common/notifications/notifications.service';
import { Role } from '@prisma/client';

@Injectable()
export class TeacherLeavesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Create a leave request for the current teacher at the school they selected.
   * Always pins to `school_id` — never re-routes to another school based on
   * working-days history. Silent re-routing hid requests from the teacher
   * (history filtered by active school) and from the school admin of the
   * school they thought they submitted against.
   */
  async create(
    teacherId: number,
    body: {
      school_id: string;
      start_date: string;
      end_date: string;
      reason?: string;
      substitute_required?: boolean;
    },
  ) {
    const { school_id, start_date, end_date, reason } = body;
    if (!school_id || !start_date || !end_date) {
      throw new BadRequestException(
        'school_id, start_date and end_date are required',
      );
    }
    const start = new Date(start_date + 'T00:00:00.000Z');
    const end = new Date(end_date + 'T23:59:59.999Z');
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException('Invalid date format. Use YYYY-MM-DD.');
    }
    if (start > end) {
      throw new BadRequestException('End date must be on or after start date');
    }

    const assigned = await this.db.teacherSchool.findFirst({
      where: { teacherId, schoolId: school_id },
      select: { schoolId: true },
    });
    if (!assigned) {
      throw new ForbiddenException('Not assigned to this school');
    }

    // Prevent overlapping leave requests for the same teacher + school.
    // Overlap if existing.start <= new.end AND existing.end >= new.start
    const overlap = await this.db.teacherLeave.findFirst({
      where: {
        teacherId,
        schoolId: school_id,
        startDate: { lte: end },
        endDate: { gte: start },
        status: { in: ['pending', 'approved'] },
      },
      select: { id: true, status: true, startDate: true, endDate: true },
    });
    if (overlap) {
      const s = overlap.startDate.toISOString().split('T')[0];
      const e = overlap.endDate.toISOString().split('T')[0];
      const label = overlap.status === 'approved' ? 'approved' : 'pending';
      throw new BadRequestException(
        `You already have a ${label} leave request overlapping ${s} to ${e}.`,
      );
    }

    const leave = await this.db.teacherLeave.create({
      data: {
        teacherId,
        schoolId: school_id,
        startDate: start,
        endDate: end,
        reason: reason ?? null,
        substituteRequired: !!body.substitute_required,
        status: 'pending',
      },
    });

    // Notify school admins (for this school) + system admins — honors prefs.
    const teacher = await this.db.user.findUnique({
      where: { id: teacherId },
      select: { profile: { select: { fullName: true } }, email: true },
    });
    const teacherLabel =
      teacher?.profile?.fullName?.trim() || teacher?.email || 'A teacher';
    const [schoolAdmins, adminUsers] = await Promise.all([
      this.db.schoolAdmin.findMany({
        where: { schoolId: school_id },
        select: { userId: true },
      }),
      this.db.user.findMany({
        where: { role: Role.admin, isActive: true },
        select: { id: true },
      }),
    ]);
    const recipientIds = [
      ...new Set([
        ...schoolAdmins.map((s) => s.userId),
        ...adminUsers.map((a) => a.id),
      ]),
    ];
    const dateLabel = `${start_date} to ${end_date}`;
    await this.notifications.createManyRespectingPrefs(
      recipientIds.map((userId) => ({
        userId,
        senderId: teacherId,
        title: `Leave request: ${teacherLabel}`,
        message: `${teacherLabel} requested leave (${dateLabel})${reason ? `: ${reason}` : '.'}`,
        mode: 'teacher_leave',
        allowReplies: false,
      })),
    );

    const toLeaveDto = (l: typeof leave) => ({
      id: l.id,
      school_id: l.schoolId,
      start_date: l.startDate.toISOString().split('T')[0],
      end_date: l.endDate.toISOString().split('T')[0],
      reason: l.reason,
      status: l.status,
      substitute_required:
        (l as { substituteRequired?: boolean }).substituteRequired ?? false,
    });

    const dto = toLeaveDto(leave);
    return {
      leave: dto,
      leaves: [dto],
    };
  }

  /**
   * List leave requests for the current teacher (optional filter by school_id).
   */
  async list(teacherId: number, schoolId?: string) {
    if (schoolId) {
      const assigned = await this.db.teacherSchool.findFirst({
        where: { teacherId, schoolId },
        select: { schoolId: true },
      });
      if (!assigned) throw new ForbiddenException('Not assigned to this school');
    }
    const where: { teacherId: number; schoolId?: string } = { teacherId };
    if (schoolId) where.schoolId = schoolId;
    const leaves = await this.db.teacherLeave.findMany({
      where,
      orderBy: { startDate: 'desc' },
    });
    const norm = (s: string) =>
      s === 'pending'
        ? 'Pending'
        : s === 'approved'
          ? 'Approved'
          : s === 'rejected'
            ? 'Rejected'
            : s;
    return {
      leaves: leaves.map((l) => ({
        id: l.id,
        teacher_id: l.teacherId,
        school_id: l.schoolId,
        start_date: l.startDate.toISOString().split('T')[0],
        end_date: l.endDate.toISOString().split('T')[0],
        reason: l.reason,
        status: norm(l.status),
        substitute_required:
          (l as { substituteRequired?: boolean }).substituteRequired ?? false,
        created_at: l.createdAt.toISOString(),
      })),
    };
  }
}
