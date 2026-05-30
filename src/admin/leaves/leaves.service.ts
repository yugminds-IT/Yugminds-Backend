import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { Role } from '@prisma/client';

@Injectable()
export class AdminLeavesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtimeGateway: RealtimeGateway,
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
              : l.status === 'rejected'
                ? 'Rejected'
                : l.status,
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
   * Update a leave request (approve or reject). Body: id, status ('Approved' | 'Rejected'), admin_remarks?, approved_by?
   */
  async update(body: {
    id: string;
    status: string;
    admin_remarks?: string;
    approved_by?: string;
    /** Set from JWT in controller; preferred over client-supplied approved_by */
    actor_email?: string;
  }) {
    const { id, status, admin_remarks, approved_by, actor_email } = body;
    if (!id) throw new BadRequestException('id is required');
    const normalized = status?.trim().toLowerCase();
    if (normalized !== 'approved' && normalized !== 'rejected') {
      throw new BadRequestException('status must be Approved or Rejected');
    }

    const leave = await this.db.teacherLeave.findUnique({ where: { id } });
    if (!leave) throw new NotFoundException('Leave request not found');

    const updated = await this.db.teacherLeave.update({
      where: { id },
      data: {
        status: normalized === 'approved' ? 'approved' : 'rejected',
        adminRemarks: admin_remarks ?? leave.adminRemarks,
        approvedBy: actor_email ?? approved_by ?? leave.approvedBy,
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
      const rejStart = new Date(updated.startDate);
      rejStart.setUTCHours(0, 0, 0, 0);
      const rejEnd = new Date(updated.endDate);
      rejEnd.setUTCHours(23, 59, 59, 999);
      await this.db.attendance.updateMany({
        where: {
          teacherId: updated.teacherId,
          schoolId: updated.schoolId,
          date: { gte: rejStart, lte: rejEnd },
          status: 'Leave-Approved',
        },
        data: { status: 'Unreported' },
      });
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
