import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { NotificationsService } from '../../common/notifications/notifications.service';
import { Role } from '@prisma/client';
import {
  assertAdminMayApproveEmergency,
  isEmergencyLeave,
  leaveStageFields,
  revertLeaveApprovedAttendance,
} from '../../common/utils/leave-rules.util';
import { getTodayIstDateStr } from '../../common/utils/date.util';
import {
  EMERGENCY_LEAVE_TYPE,
  assertEmergencyLeaveAllowed,
  assertLeaveSpan,
} from '../../common/utils/leave-rules.util';

@Injectable()
export class AdminLeavesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * List all teacher leave requests (optional filter by school_id).
   */
  async list(schoolId?: string) {
    const where = schoolId ? { schoolId } : {};
    const leaves = await this.db.teacherLeave.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        teacher: { include: { profile: true } },
      },
    });
    const schoolIds = [...new Set(leaves.map((l) => l.schoolId))];
    const schools = schoolIds.length
      ? await this.db.school.findMany({ where: { id: { in: schoolIds } } })
      : [];
    const schoolMap = new Map(schools.map((s) => [s.id, s]));

    // approvedBy is a numeric user id (as a string) — resolve to a display
    // name/email, same as SchoolAdminExtraController.listLeaves, so a leave
    // reviewed by either dashboard shows a real reviewer identity on both.
    const reviewerIds = Array.from(
      new Set(
        leaves
          .map((l) => (l.approvedBy ? parseInt(String(l.approvedBy), 10) : NaN))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    );
    const reviewers = reviewerIds.length
      ? await this.db.user.findMany({
          where: { id: { in: reviewerIds } },
          include: { profile: true },
        })
      : [];
    const reviewerById = new Map(
      reviewers.map((r) => [
        r.id,
        {
          id: String(r.id),
          full_name: r.profile?.fullName ?? r.email,
          email: r.email,
        },
      ]),
    );

    const leavesList = leaves.map((l) => {
      const start = l.startDate.getTime();
      const end = l.endDate.getTime();
      const totalDays = Math.max(
        1,
        Math.ceil((end - start) / (24 * 60 * 60 * 1000)) + 1,
      );
      const school = schoolMap.get(l.schoolId);
      return {
        id: l.id,
        teacher_id: String(l.teacherId),
        school_id: l.schoolId,
        leave_type: (l as { leaveType?: string }).leaveType ?? 'Leave',
        ...leaveStageFields(l),
        start_date: l.startDate.toISOString().split('T')[0],
        end_date: l.endDate.toISOString().split('T')[0],
        total_days: totalDays,
        reason: l.reason ?? '',
        status:
          l.status === 'pending'
            ? 'Pending'
            : l.status === 'approved'
              ? 'Approved'
              : l.status === 'rejected'
                ? 'Rejected'
                : l.status === 'cancelled'
                  ? 'Cancelled'
                  : l.status,
        applied_at: l.createdAt.toISOString(),
        approved_by: l.approvedBy ?? undefined,
        // Real timestamps (the row's own updatedAt, which only changes when
        // the status transitions) — previously declared/rendered on the
        // frontend but never sent, so "Approved on" / "Rejected on" was
        // permanently dead UI.
        approved_at:
          l.status === 'approved' ? l.updatedAt.toISOString() : undefined,
        rejected_at:
          l.status === 'rejected' ? l.updatedAt.toISOString() : undefined,
        reviewer: l.approvedBy
          ? (reviewerById.get(parseInt(String(l.approvedBy), 10)) ?? null)
          : null,
        // Matches SchoolAdminExtraController.listLeaves — the School Admin
        // dashboard shows this as a "Substitute Required" badge; it was
        // silently missing here, so a System Admin reviewing a request had
        // no way to see whether a substitute was requested.
        substitute_required:
          (l as { substituteRequired?: boolean }).substituteRequired ?? false,
        admin_remarks: l.adminRemarks ?? undefined,
        profiles: l.teacher?.profile
          ? {
              id: l.teacher.profile.id,
              full_name: l.teacher.profile.fullName ?? '',
              email: l.teacher.email,
            }
          : {
              id: '',
              full_name: l.teacher?.email ?? '',
              email: l.teacher?.email ?? '',
            },
        schools: school
          ? {
              id: school.id,
              name: school.name,
              school_code: school.schoolCode ?? '',
            }
          : undefined,
      };
    });
    return { leaves: leavesList };
  }

  /**
   * System admin files an EMERGENCY leave on behalf of a teacher. Same strict
   * rules as the school-admin version (reason required, start at most 2 days
   * back, no time cutoff). The admin filing it is approval stage 2 (approved);
   * the school admin must still approve (stage 1) before it becomes final and
   * attendance changes — both must know and approve.
   */
  async createEmergency(
    body: {
      teacher_id?: number | string;
      school_id?: string;
      start_date?: string;
      end_date?: string;
      reason?: string;
    },
    actorUserId: number,
  ) {
    const teacherId = Number(body?.teacher_id);
    const { school_id, start_date, end_date, reason } = body ?? {};
    if (
      !Number.isInteger(teacherId) ||
      !school_id ||
      !start_date ||
      !end_date
    ) {
      throw new BadRequestException(
        'teacher_id, school_id, start_date and end_date are required',
      );
    }
    const start = new Date(start_date + 'T00:00:00.000Z');
    const end = new Date(end_date + 'T23:59:59.999Z');
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException('Invalid date format. Use YYYY-MM-DD.');
    }
    if (start > end)
      throw new BadRequestException('End date must be on or after start date');
    assertLeaveSpan(start_date, end_date);
    assertEmergencyLeaveAllowed(start_date, reason, getTodayIstDateStr());

    const assigned = await this.db.teacherSchool.findFirst({
      where: { teacherId, schoolId: school_id },
      select: { schoolId: true },
    });
    if (!assigned)
      throw new BadRequestException('Teacher is not assigned to this school');

    const overlap = await this.db.teacherLeave.findFirst({
      where: {
        teacherId,
        schoolId: school_id,
        startDate: { lte: end },
        endDate: { gte: start },
        status: { in: ['pending', 'approved'] },
      },
      select: { id: true },
    });
    if (overlap) {
      throw new BadRequestException(
        'This teacher already has a pending or approved leave overlapping these dates.',
      );
    }

    const leave = await this.db.teacherLeave.create({
      data: {
        teacherId,
        schoolId: school_id,
        startDate: start,
        endDate: end,
        reason: reason!.trim(),
        leaveType: EMERGENCY_LEAVE_TYPE,
        status: 'pending',
        adminStatus: 'approved',
        adminBy: String(actorUserId),
        adminAt: new Date(),
        schoolAdminStatus: 'pending',
      },
    });

    const schoolAdmins = await this.db.schoolAdmin.findMany({
      where: { schoolId: school_id },
      select: { userId: true },
    });
    await this.notifications.sendOne(actorUserId, teacherId, {
      title: 'Emergency leave recorded — awaiting school admin approval',
      message: `The admin recorded an emergency leave for ${start_date} to ${end_date} (reason: ${reason!.trim()}). It is approved by the admin and waiting for your school admin's approval — please contact them.`,
      type: 'system_alert',
      allowReplies: false,
    });
    await Promise.all(
      schoolAdmins.map((sa) =>
        this.notifications.sendOne(actorUserId, sa.userId, {
          title: 'Emergency leave awaiting your approval',
          message: `The admin recorded an emergency leave for one of your teachers (${start_date} to ${end_date}). Your approval is needed to finalise it.`,
          type: 'system_alert',
          allowReplies: false,
        }),
      ),
    );
    await this.realtimeGateway.emitDashboardStatsForUsers([
      teacherId,
      ...schoolAdmins.map((s) => s.userId),
    ]);
    return { success: true, leave_id: leave.id };
  }

  /**
   * Update a leave request (approve or reject). Body: id, status ('Approved' | 'Rejected'), admin_remarks?, approved_by?
   */
  async update(body: {
    id: string;
    status: string;
    admin_remarks?: string;
    approved_by?: string;
    /**
     * Set from JWT in controller; preferred over client-supplied approved_by.
     * Must be the numeric user id as a string (NOT an email) — the
     * school-admin dashboard's reviewer-identity lookup does
     * `parseInt(approvedBy, 10)` to resolve who reviewed a leave (see
     * SchoolAdminExtraController.listLeaves). This field used to be set to
     * the acting admin's email, which silently broke that lookup (parseInt
     * on an email is NaN) — a leave a System Admin approved would show
     * "Reviewed by: N/A" on the School Admin dashboard.
     */
    actor_user_id?: string;
  }) {
    const { id, status, admin_remarks, approved_by, actor_user_id } = body;
    if (!id) throw new BadRequestException('id is required');
    const normalized = status?.trim().toLowerCase();
    if (normalized !== 'approved' && normalized !== 'rejected') {
      throw new BadRequestException('status must be Approved or Rejected');
    }

    const leave = await this.db.teacherLeave.findUnique({ where: { id } });
    if (!leave) throw new NotFoundException('Leave request not found');
    if (leave.status === 'cancelled') {
      throw new BadRequestException(
        'This leave request was cancelled by the teacher.',
      );
    }
    // Emergency leave: the admin is approval stage 2 — approving requires the
    // school admin's approval first. Rejecting is always allowed.
    const emergency = isEmergencyLeave(leave);
    if (emergency && normalized === 'approved')
      assertAdminMayApproveEmergency(leave);

    const updated = await this.db.teacherLeave.update({
      where: { id },
      data: {
        status: normalized === 'approved' ? 'approved' : 'rejected',
        ...(emergency && {
          adminStatus: normalized,
          adminBy: actor_user_id ?? approved_by ?? null,
          adminAt: new Date(),
        }),
        adminRemarks: admin_remarks ?? leave.adminRemarks,
        approvedBy: actor_user_id ?? approved_by ?? leave.approvedBy,
      },
    });

    // Update attendance records for the leave date range.
    // - Approved: mark each day as Leave-Approved (unless already Present)
    // - Rejected: do not force status; leave as-is (teacher reports/other processes may mark Present)
    if (normalized === 'approved') {
      // PERFORMANCE FIX (HIGH-04): Bulk fetch and update instead of N+1 queries
      const start = new Date(updated.startDate);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(updated.endDate);
      end.setUTCHours(0, 0, 0, 0);

      // Generate all dates in range
      const dates: Date[] = [];
      for (
        let d = new Date(start);
        d.getTime() <= end.getTime();
        d.setUTCDate(d.getUTCDate() + 1)
      ) {
        dates.push(new Date(d));
      }

      // Bulk fetch existing attendance records
      const existingRecords = await this.db.attendance.findMany({
        where: {
          teacherId: updated.teacherId,
          schoolId: updated.schoolId,
          date: { in: dates },
        },
        select: { date: true, status: true },
      });

      // Create a set of dates that are already marked as Present (don't override these)
      const presentDates = new Set(
        existingRecords
          .filter((r) => r.status === 'Present')
          .map((r) => r.date.toISOString()),
      );

      // Filter dates that need to be updated
      const datesToUpdate = dates.filter(
        (d) => !presentDates.has(d.toISOString()),
      );

      if (datesToUpdate.length > 0) {
        // Use createMany with skipDuplicates for new records
        const recordsToCreate = datesToUpdate.map((date) => ({
          teacherId: updated.teacherId,
          schoolId: updated.schoolId,
          date,
          status: 'Leave-Approved',
        }));

        // First, update existing non-Present records
        await this.db.attendance.updateMany({
          where: {
            teacherId: updated.teacherId,
            schoolId: updated.schoolId,
            date: { in: datesToUpdate },
            status: { not: 'Present' },
          },
          data: { status: 'Leave-Approved' },
        });

        // Then create any missing records (this will skip duplicates)
        await this.db.attendance.createMany({
          data: recordsToCreate,
          skipDuplicates: true,
        });
      }
    }

    if (normalized === 'rejected') {
      await revertLeaveApprovedAttendance(
        this.db,
        updated,
        getTodayIstDateStr(),
      );
    }

    // Notify the teacher when their leave is approved or rejected (in-app).
    // Skip no-op rewrites of the same status so retries don't spam the inbox.
    if (leave.status !== normalized) {
      const school = await this.db.school.findUnique({
        where: { id: updated.schoolId },
        select: { name: true },
      });
      const startLabel = updated.startDate.toISOString().split('T')[0];
      const endLabel = updated.endDate.toISOString().split('T')[0];
      const dateLabel =
        startLabel === endLabel ? startLabel : `${startLabel} to ${endLabel}`;
      const schoolLabel = school?.name?.trim() || 'your school';
      const statusLabel = normalized === 'approved' ? 'approved' : 'rejected';
      const remarks = updated.adminRemarks?.trim()
        ? ` Remarks: ${updated.adminRemarks.trim()}`
        : '';
      const senderId = actor_user_id
        ? parseInt(String(actor_user_id), 10)
        : NaN;
      await this.notifications.sendOne(
        Number.isFinite(senderId) && senderId > 0
          ? senderId
          : updated.teacherId,
        updated.teacherId,
        {
          title: `Leave request ${statusLabel}`,
          message: `Your leave request for ${dateLabel} at ${schoolLabel} has been ${statusLabel}.${remarks}`,
          type: 'system_alert',
          allowReplies: false,
        },
      );
    }

    const [schoolAdmins, adminUsers] = await Promise.all([
      this.db.schoolAdmin.findMany({
        where: { schoolId: updated.schoolId },
        select: { userId: true },
      }),
      this.db.user.findMany({
        where: { role: Role.admin },
        select: { id: true },
      }),
    ]);
    await this.realtimeGateway.emitDashboardStatsForUsers([
      updated.teacherId,
      ...schoolAdmins.map((s) => s.userId),
      ...adminUsers.map((u) => u.id),
    ]);

    return {
      leave: {
        id: updated.id,
        status: updated.status === 'approved' ? 'Approved' : 'Rejected',
        admin_remarks: updated.adminRemarks,
      },
    };
  }
}
