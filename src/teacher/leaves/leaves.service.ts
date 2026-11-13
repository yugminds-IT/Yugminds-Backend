import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { NotificationsService } from '../../common/notifications/notifications.service';
import { Role } from '@prisma/client';
import {
  getTodayIstDateStr,
  isBeforeAttendanceCutoff,
} from '../../common/utils/date.util';
import {
  EMERGENCY_LEAVE_TYPE,
  assertEmergencyLeaveAllowed,
  assertLeaveSpan,
  leaveStageFields,
} from '../../common/utils/leave-rules.util';

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
      is_emergency?: boolean;
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
    assertLeaveSpan(start_date, end_date);
    // Server clock (IST), never the browser's.
    const serverToday = getTodayIstDateStr();
    const isEmergency = body.is_emergency === true;
    if (isEmergency) {
      // Emergency: no 8pm cutoff, but strict — reason required and the start
      // may be at most 2 days back. Approval then has no cutoff either.
      assertEmergencyLeaveAllowed(start_date, reason, serverToday);
    } else {
      // Regular leave: accepted only before the 8pm cutoff (attendance for
      // the day is settled then) and can't be backdated.
      if (start_date < serverToday) {
        throw new BadRequestException(
          `Leave cannot start in the past (today is ${serverToday}).`,
        );
      }
      if (!isBeforeAttendanceCutoff()) {
        throw new BadRequestException(
          'Leave requests must be submitted before 8:00 PM IST. For a genuine emergency, submit it as an emergency leave.',
        );
      }
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
        leaveType: isEmergency ? EMERGENCY_LEAVE_TYPE : 'General',
        // Emergency leave needs two sequential approvals: school admin, then admin.
        ...(isEmergency && {
          schoolAdminStatus: 'pending',
          adminStatus: 'pending',
        }),
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
        title: `${isEmergency ? 'EMERGENCY leave request' : 'Leave request'}: ${teacherLabel}`,
        message: `${teacherLabel} requested ${isEmergency ? 'EMERGENCY ' : ''}leave (${dateLabel})${reason ? `: ${reason}` : '.'}${isEmergency ? ' Needs approval from the school admin first, then the admin.' : ''}`,
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
      ...leaveStageFields(leave),
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
   * Teacher cancels their own leave request. Allowed while it is still pending,
   * or while an approved leave has not started yet (it can't be cancelled once
   * it has begun — attendance for those days is already settled). Cancelling an
   * approved leave clears its Leave-Approved days. Rejected/cancelled leaves
   * can't be cancelled again.
   */
  async cancel(teacherId: number, id: string) {
    const leave = await this.db.teacherLeave.findFirst({
      where: { id, teacherId },
    });
    if (!leave) throw new NotFoundException('Leave request not found');
    if (leave.status === 'cancelled') {
      throw new BadRequestException('This leave request is already cancelled.');
    }
    if (leave.status === 'rejected') {
      throw new BadRequestException(
        'A rejected leave request cannot be cancelled.',
      );
    }
    const startStr = leave.startDate.toISOString().split('T')[0];
    if (leave.status === 'approved' && startStr <= getTodayIstDateStr()) {
      throw new BadRequestException(
        'An approved leave can only be cancelled before it starts. Please contact your administrator.',
      );
    }

    await this.db.teacherLeave.update({
      where: { id },
      data: { status: 'cancelled' },
    });
    if (leave.status === 'approved') {
      // Clear the days this leave had marked Leave-Approved (all in the future here).
      await this.db.attendance.deleteMany({
        where: {
          teacherId,
          schoolId: leave.schoolId,
          date: { gte: leave.startDate, lte: leave.endDate },
          status: 'Leave-Approved',
        },
      });
    }

    const teacher = await this.db.user.findUnique({
      where: { id: teacherId },
      select: { profile: { select: { fullName: true } }, email: true },
    });
    const teacherLabel =
      teacher?.profile?.fullName?.trim() || teacher?.email || 'A teacher';
    const [schoolAdmins, adminUsers] = await Promise.all([
      this.db.schoolAdmin.findMany({
        where: { schoolId: leave.schoolId },
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
    const endStr = leave.endDate.toISOString().split('T')[0];
    await this.notifications.createManyRespectingPrefs(
      recipientIds.map((userId) => ({
        userId,
        senderId: teacherId,
        title: `Leave request cancelled: ${teacherLabel}`,
        message: `${teacherLabel} cancelled their leave request (${startStr} to ${endStr}).`,
        mode: 'teacher_leave',
        allowReplies: false,
      })),
    );
    return { leave: { id, status: 'Cancelled' } };
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
      if (!assigned)
        throw new ForbiddenException('Not assigned to this school');
    }
    const where: { teacherId: number; schoolId?: string } = { teacherId };
    if (schoolId) where.schoolId = schoolId;
    const leaves = await this.db.teacherLeave.findMany({
      where,
      orderBy: { startDate: 'desc' },
    });
    // Resolve who decided each request (ids are stored as strings).
    const idOf = (v?: string | null) => (v ? parseInt(v, 10) : NaN);
    const userIds = [
      ...new Set(
        leaves
          .flatMap((l) => [l.approvedBy, l.schoolAdminBy, l.adminBy])
          .map(idOf)
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    ];
    const users = userIds.length
      ? await this.db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, role: true, email: true, profile: { select: { fullName: true } } },
        })
      : [];
    const who = (v?: string | null) => {
      const u = users.find((x) => x.id === idOf(v));
      return u
        ? {
            name: u.profile?.fullName?.trim() || u.email,
            role: u.role === Role.admin ? 'Admin' : 'School admin',
          }
        : null;
    };
    const norm = (s: string) =>
      s === 'pending'
        ? 'Pending'
        : s === 'approved'
          ? 'Approved'
          : s === 'rejected'
            ? 'Rejected'
            : s === 'cancelled'
              ? 'Cancelled'
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
        leave_type: l.leaveType,
        ...leaveStageFields(l),
        admin_remarks: l.adminRemarks,
        // Whoever last approved/rejected it, and when.
        // (kept on cancelled leave too: approvedBy is only set once decided)
        reviewer: l.status === 'pending' ? null : who(l.approvedBy),
        reviewed_at:
          l.status === 'pending' || !l.approvedBy
            ? null
            : l.updatedAt.toISOString(),
        school_admin_by: who(l.schoolAdminBy)?.name ?? null,
        admin_by: who(l.adminBy)?.name ?? null,
        substitute_required:
          (l as { substituteRequired?: boolean }).substituteRequired ?? false,
        created_at: l.createdAt.toISOString(),
      })),
    };
  }
}
