import { Injectable, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class TeacherLeavesService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Create a leave request for the current teacher.
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
    return {
      leave: {
        id: leave.id,
        school_id: leave.schoolId,
        start_date: start_date,
        end_date: end_date,
        reason: leave.reason,
        status: leave.status,
        substitute_required:
          (leave as { substituteRequired?: boolean }).substituteRequired ??
          false,
      },
    };
  }

  /**
   * List leave requests for the current teacher (optional filter by school_id).
   */
  async list(teacherId: number, schoolId?: string) {
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
