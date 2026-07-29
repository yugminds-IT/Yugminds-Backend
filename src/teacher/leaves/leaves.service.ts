import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { tenantContext } from '../../tenants/tenant-context';
import {
  resolveWorkingDaysForDate,
  WorkingDaysHistoryEntry,
} from '../../common/utils/working-days-history.util';

@Injectable()
export class TeacherLeavesService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * For each day in [start, end], figures out which of the teacher's schools
   * they're actually scheduled to work at that day (via each school's
   * working-days history), so a leave request routes only to the school
   * admin(s) it actually affects — not every school the teacher belongs to,
   * and not just whatever school happens to be selected in the teacher's UI.
   * Returns one date sub-range per affected school.
   */
  private async resolveSchoolRangesForLeave(
    teacherId: number,
    start: Date,
    end: Date,
  ): Promise<Map<string, { from: Date; to: Date }>> {
    const teacherSchools = await this.db.teacherSchool.findMany({
      where: { teacherId },
      select: { schoolId: true },
    });
    const schoolIds = teacherSchools.map((s) => s.schoolId);
    const ranges = new Map<string, { from: Date; to: Date }>();
    if (schoolIds.length === 0) return ranges;

    // Deliberately scoped by teacherId only, NOT schoolId — the tenant
    // isolation layer (DatabaseService) rejects any query whose schoolId
    // filter spans more than one school for the current request's tenant.
    // Filtering to `schoolIds` happens in-memory below instead.
    const history = await this.db.teacherWorkingDaysHistory.findMany({
      where: { teacherId },
      select: { schoolId: true, workingDays: true, effectiveFrom: true },
    });
    const historyBySchool = new Map<string, WorkingDaysHistoryEntry[]>();
    for (const h of history) {
      if (!historyBySchool.has(h.schoolId)) {
        historyBySchool.set(h.schoolId, []);
      }
      historyBySchool.get(h.schoolId)!.push(h);
    }

    for (
      let d = new Date(start);
      d <= end;
      d = new Date(d.getTime() + 24 * 60 * 60 * 1000)
    ) {
      const dayOfWeek = d.getUTCDay();
      for (const schoolId of schoolIds) {
        const workingDays = resolveWorkingDaysForDate(
          historyBySchool.get(schoolId) ?? [],
          d,
        );
        if (!workingDays.includes(dayOfWeek)) continue;
        const existing = ranges.get(schoolId);
        if (!existing) {
          ranges.set(schoolId, { from: new Date(d), to: new Date(d) });
        } else {
          if (d < existing.from) existing.from = new Date(d);
          if (d > existing.to) existing.to = new Date(d);
        }
      }
    }
    return ranges;
  }

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

    const assigned = await this.db.teacherSchool.findFirst({
      where: { teacherId, schoolId: school_id },
      select: { schoolId: true },
    });
    if (!assigned) {
      throw new ForbiddenException('Not assigned to this school');
    }

    const schoolRanges = await this.resolveSchoolRangesForLeave(
      teacherId,
      start,
      end,
    );

    // Route to only the school(s) the teacher is actually scheduled at
    // during these dates — split into one request per school if the range
    // spans schools on different working days. Falls back to the
    // teacher-selected school if no working-days schedule is resolvable
    // for these dates (e.g. schedule not configured yet).
    const targets: Array<{ schoolId: string; from: Date; to: Date }> =
      schoolRanges.size > 0
        ? [...schoolRanges.entries()].map(([schoolId, r]) => ({
            schoolId,
            from: r.from,
            to: r.to,
          }))
        : [{ schoolId: school_id, from: start, to: end }];

    // Prevent overlapping leave requests for the same teacher + school.
    // Overlap if existing.start <= new.end AND existing.end >= new.start
    // Each check runs inside that school's own tenant context — the request
    // as a whole is pinned to the caller's selected school_id, so reads
    // against a *different* target school must switch context explicitly
    // or the tenant-isolation layer rejects them as cross-tenant access.
    for (const t of targets) {
      const overlap = await tenantContext.run(t.schoolId, async () =>
        this.db.teacherLeave.findFirst({
          where: {
            teacherId,
            schoolId: t.schoolId,
            startDate: { lte: t.to },
            endDate: { gte: t.from },
            status: { in: ['pending', 'approved'] },
          },
          select: { id: true, status: true, startDate: true, endDate: true },
        }),
      );
      if (overlap) {
        const s = overlap.startDate.toISOString().split('T')[0];
        const e = overlap.endDate.toISOString().split('T')[0];
        const label = overlap.status === 'approved' ? 'approved' : 'pending';
        throw new BadRequestException(
          `You already have a ${label} leave request overlapping ${s} to ${e}.`,
        );
      }
    }

    const leaves = await Promise.all(
      targets.map((t) =>
        tenantContext.run(t.schoolId, async () =>
          this.db.teacherLeave.create({
            data: {
              teacherId,
              schoolId: t.schoolId,
              startDate: t.from,
              endDate: t.to,
              reason: reason ?? null,
              substituteRequired: !!body.substitute_required,
              status: 'pending',
            },
          }),
        ),
      ),
    );

    const toLeaveDto = (leave: (typeof leaves)[number]) => ({
      id: leave.id,
      school_id: leave.schoolId,
      start_date: leave.startDate.toISOString().split('T')[0],
      end_date: leave.endDate.toISOString().split('T')[0],
      reason: leave.reason,
      status: leave.status,
      substitute_required:
        (leave as { substituteRequired?: boolean }).substituteRequired ??
        false,
    });

    return {
      leave: toLeaveDto(leaves[0]),
      leaves: leaves.map(toLeaveDto),
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
