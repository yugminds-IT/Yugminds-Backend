import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { Role } from '@prisma/client';

@Injectable()
export class SchoolAdminLeavesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  private async resolveSchoolId(userId: number): Promise<string> {
    const sa = await this.db.schoolAdmin.findFirst({
      where: { userId },
      select: { schoolId: true },
    });
    if (!sa?.schoolId)
      throw new ForbiddenException('No school assigned to your account');
    return sa.schoolId;
  }

  async list(userId: number, params?: { status?: string }) {
    const schoolId = await this.resolveSchoolId(userId);
    const statusFilter = params?.status?.trim().toLowerCase();

    const where: Record<string, unknown> = { schoolId };
    if (statusFilter && statusFilter !== 'all') {
      where.status = statusFilter;
    }

    const leaves = await this.db.teacherLeave.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { teacher: { include: { profile: true } } },
    });

    const leavesList = leaves.map((l) => {
      const startMs = Date.UTC(
        l.startDate.getUTCFullYear(),
        l.startDate.getUTCMonth(),
        l.startDate.getUTCDate(),
      );
      const endMs = Date.UTC(
        l.endDate.getUTCFullYear(),
        l.endDate.getUTCMonth(),
        l.endDate.getUTCDate(),
      );
      const totalDays = Math.max(
        1,
        Math.round((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1,
      );
      return {
        id: l.id,
        teacher_id: String(l.teacherId),
        school_id: l.schoolId,
        leave_type: 'Leave',
        start_date: l.startDate.toISOString().split('T')[0],
        end_date: l.endDate.toISOString().split('T')[0],
        total_days: totalDays,
        reason: l.reason ?? '',
        status:
          l.status === 'pending'
            ? 'Pending'
            : l.status === 'approved'
              ? 'Approved'
              : 'Rejected',
        applied_at: l.createdAt.toISOString(),
        approved_by: l.approvedBy ?? undefined,
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
      };
    });

    return { leaves: leavesList };
  }

  async get(userId: number, leaveId: string) {
    const schoolId = await this.resolveSchoolId(userId);
    const leave = await this.db.teacherLeave.findFirst({
      where: { id: leaveId, schoolId },
      include: { teacher: { include: { profile: true } } },
    });
    if (!leave) throw new NotFoundException('Leave request not found');

    const startMs = Date.UTC(
      leave.startDate.getUTCFullYear(),
      leave.startDate.getUTCMonth(),
      leave.startDate.getUTCDate(),
    );
    const endMs = Date.UTC(
      leave.endDate.getUTCFullYear(),
      leave.endDate.getUTCMonth(),
      leave.endDate.getUTCDate(),
    );
    const totalDays = Math.max(
      1,
      Math.round((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1,
    );
    return {
      leave: {
        id: leave.id,
        teacher_id: String(leave.teacherId),
        school_id: leave.schoolId,
        leave_type: 'Leave',
        start_date: leave.startDate.toISOString().split('T')[0],
        end_date: leave.endDate.toISOString().split('T')[0],
        total_days: totalDays,
        reason: leave.reason ?? '',
        status:
          leave.status === 'pending'
            ? 'Pending'
            : leave.status === 'approved'
              ? 'Approved'
              : 'Rejected',
        applied_at: leave.createdAt.toISOString(),
        profiles: leave.teacher?.profile
          ? {
              id: leave.teacher.profile.id,
              full_name: leave.teacher.profile.fullName ?? '',
              email: leave.teacher.email,
            }
          : {
              id: '',
              full_name: leave.teacher?.email ?? '',
              email: leave.teacher?.email ?? '',
            },
      },
    };
  }

  async update(
    userId: number,
    leaveId: string,
    body: { action?: string; status?: string; admin_remarks?: string },
  ) {
    const schoolId = await this.resolveSchoolId(userId);

    // Accept either `action` (frontend) or `status` (legacy) field
    const raw = body.action ?? body.status ?? '';
    const normalized = raw.trim().toLowerCase();
    if (
      normalized !== 'approve' &&
      normalized !== 'approved' &&
      normalized !== 'reject' &&
      normalized !== 'rejected'
    ) {
      throw new BadRequestException('action must be "approve" or "reject"');
    }
    const isApproved = normalized === 'approve' || normalized === 'approved';

    const leave = await this.db.teacherLeave.findFirst({
      where: { id: leaveId, schoolId },
    });
    if (!leave) throw new NotFoundException('Leave request not found');
    if (leave.status !== 'pending') {
      throw new BadRequestException('Leave request has already been processed');
    }

    const updated = await this.db.teacherLeave.update({
      where: { id: leaveId },
      data: {
        status: isApproved ? 'approved' : 'rejected',
        adminRemarks: body.admin_remarks ?? leave.adminRemarks,
        approvedBy: isApproved ? String(userId) : leave.approvedBy,
      },
    });

    if (isApproved) {
      const start = new Date(updated.startDate);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(updated.endDate);
      end.setUTCHours(0, 0, 0, 0);

      const dates: Date[] = [];
      for (
        let d = new Date(start);
        d.getTime() <= end.getTime();
        d.setUTCDate(d.getUTCDate() + 1)
      ) {
        dates.push(new Date(d));
      }

      const existingRecords = await this.db.attendance.findMany({
        where: {
          teacherId: updated.teacherId,
          schoolId: updated.schoolId,
          date: { in: dates },
        },
        select: { date: true, status: true },
      });

      const presentDates = new Set(
        existingRecords
          .filter((r) => r.status === 'Present')
          .map((r) => r.date.toISOString()),
      );
      const datesToUpdate = dates.filter(
        (d) => !presentDates.has(d.toISOString()),
      );

      if (datesToUpdate.length > 0) {
        await this.db.attendance.updateMany({
          where: {
            teacherId: updated.teacherId,
            schoolId: updated.schoolId,
            date: { in: datesToUpdate },
            status: { not: 'Present' },
          },
          data: { status: 'Leave-Approved' },
        });
        await this.db.attendance.createMany({
          data: datesToUpdate.map((date) => ({
            teacherId: updated.teacherId,
            schoolId: updated.schoolId,
            date,
            status: 'Leave-Approved',
          })),
          skipDuplicates: true,
        });
      }
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
