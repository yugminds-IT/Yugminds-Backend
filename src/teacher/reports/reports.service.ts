import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { Role } from '@prisma/client';
import { TeacherScheduleService } from '../schedule/teacher-schedule.service';
import { toReportUiStatus } from '../../common/utils/report-status.util';
import { getTodayIstDateStr } from '../../common/utils/date.util';

@Injectable()
export class TeacherReportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly teacherSchedule: TeacherScheduleService,
  ) {}

  private static tryComputeDurationHours(startTime?: string, endTime?: string) {
    const s = (startTime ?? '').trim();
    const e = (endTime ?? '').trim();
    if (!s || !e) return null;
    const parse = (t: string) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(t);
      if (!m) return null;
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      if (
        Number.isNaN(hh) ||
        Number.isNaN(mm) ||
        hh < 0 ||
        hh > 23 ||
        mm < 0 ||
        mm > 59
      )
        return null;
      return hh * 60 + mm;
    };
    const sm = parse(s);
    const em = parse(e);
    if (sm === null || em === null) return null;
    const diff = em - sm;
    if (diff <= 0) return null;
    return Number((diff / 60).toFixed(2));
  }

  /**
   * Submit a daily teaching report. Creates TeacherReport and marks attendance as Present for that date.
   */
  async create(
    teacherId: number,
    body: {
      school_id: string;
      grade?: string;
      date: string;
      period_id?: string;
      start_time?: string;
      end_time?: string;
      topics_taught?: string;
      activities?: string;
      notes?: string;
      student_count?: number;
      duration_hours?: number;
    },
  ) {
    const schoolId = body.school_id;
    const dateStr = body.date;
    if (!schoolId || !dateStr) {
      throw new BadRequestException('school_id and date are required');
    }
    if (!body.period_id) {
      throw new BadRequestException('period_id is required');
    }
    const reportDate = new Date(dateStr + 'T12:00:00.000Z');
    if (isNaN(reportDate.getTime())) {
      throw new BadRequestException('Invalid date format. Use YYYY-MM-DD.');
    }
    // A report describes teaching that already happened — nothing client- or
    // server-side previously stopped submitting one for an arbitrary future
    // date (and its accompanying attendance side-effect).
    if (dateStr > getTodayIstDateStr()) {
      throw new BadRequestException('Cannot submit a report for a future date.');
    }

    // A teacher can only submit reports for a school they're actually
    // assigned to — without this, a report could silently attach to a
    // school that never assigned this teacher there.
    const assigned = await this.db.teacherSchool.findFirst({
      where: { teacherId, schoolId },
      select: { schoolId: true },
    });
    if (!assigned) {
      throw new ForbiddenException('Not assigned to this school');
    }

    // Block reports on a day the school has declared a Holiday/Break —
    // catches the case where a stale ClassSchedule row still exists for a
    // day the school calendar has since closed.
    const dateOnly = new Date(reportDate);
    dateOnly.setUTCHours(0, 0, 0, 0);
    const workStatus = await this.teacherSchedule.getWorkStatusForDate(
      teacherId,
      [schoolId],
      dateOnly,
    );
    if (workStatus.holidaySchoolIds.includes(schoolId)) {
      throw new BadRequestException(
        'This school has declared a holiday/break on this date — reports cannot be submitted.',
      );
    }

    // Server-side duplicate protection (one report per teacher+school+date+period)
    const existing = await this.db.teacherReport.findFirst({
      where: {
        teacherId,
        schoolId,
        reportDate: {
          gte: new Date(dateStr + 'T00:00:00.000Z'),
          lte: new Date(dateStr + 'T23:59:59.999Z'),
        },
        periodId: body.period_id,
      },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(
        'A report for this period has already been submitted for this date.',
      );
    }

    const computedDuration =
      typeof body.duration_hours === 'number' &&
      !Number.isNaN(body.duration_hours)
        ? body.duration_hours
        : TeacherReportsService.tryComputeDurationHours(
            body.start_time,
            body.end_time,
          );

    // Derive dayOfWeek from the date string to stay consistent with the local calendar date.
    const [fy, fm, fd] = dateStr.split('-').map(Number);
    const dayOfWeek = new Date(fy, fm - 1, fd).getDay(); // 0=Sun..6=Sat
    const dateEnd = new Date(dateOnly);
    dateEnd.setUTCHours(23, 59, 59, 999);

    // Report creation + the attendance side-effect it implies must succeed
    // or fail together — previously these were two independent calls with
    // no transaction, so a failure in the attendance upsert could leave a
    // report committed with no corresponding attendance update.
    const { report, attendanceMarkedPresent } = await this.db.$transaction(
      async (tx) => {
        const created = await tx.teacherReport.create({
          data: {
            teacherId,
            schoolId,
            reportDate,
            grade: body.grade ?? null,
            periodId: body.period_id,
            status: 'submitted',
            startTime: body.start_time?.trim() || null,
            endTime: body.end_time?.trim() || null,
            topicsTaught: body.topics_taught?.trim() || null,
            activities: body.activities?.trim() || null,
            studentCount:
              typeof body.student_count === 'number' &&
              !Number.isNaN(body.student_count)
                ? body.student_count
                : null,
            durationHours:
              typeof computedDuration === 'number' &&
              !Number.isNaN(computedDuration)
                ? computedDuration
                : null,
            notes: body.notes?.trim() || null,
          },
        });

        // Mark attendance as Present only when ALL scheduled periods for
        // that day have been reported — this ensures the UI promise
        // ("submit all reports → marked Present") matches backend behavior.
        const scheduledPeriods = await tx.classSchedule.findMany({
          where: { teacherId, schoolId, dayOfWeek, isActive: true },
          select: { periodId: true },
        });
        const scheduledPeriodIds = [
          ...new Set(scheduledPeriods.map((s) => s.periodId).filter(Boolean)),
        ];

        const allCovered =
          scheduledPeriodIds.length === 0 // no schedule → any report counts as Present
            ? true
            : (await tx.teacherReport.count({
                where: {
                  teacherId,
                  schoolId,
                  reportDate: { gte: dateOnly, lte: dateEnd },
                  periodId: { in: scheduledPeriodIds },
                },
              })) >= scheduledPeriodIds.length;

        let marked = false;
        if (allCovered) {
          // Never clobber an approved-leave day — a teacher on approved
          // leave who still submits a report for part of the day (e.g.
          // covering one class) must not have their leave status silently
          // overwritten to Present.
          const existingAttendance = await tx.attendance.findUnique({
            where: {
              teacherId_schoolId_date: { teacherId, schoolId, date: dateOnly },
            },
            select: { status: true },
          });
          if (existingAttendance?.status !== 'Leave-Approved') {
            await tx.attendance.upsert({
              where: {
                teacherId_schoolId_date: { teacherId, schoolId, date: dateOnly },
              },
              create: { teacherId, schoolId, date: dateOnly, status: 'Present' },
              update: { status: 'Present' },
            });
            marked = true;
          }
        }

        return { report: created, attendanceMarkedPresent: marked };
      },
    );

    const [schoolAdmins, adminUsers] = await Promise.all([
      this.db.schoolAdmin.findMany({
        where: { schoolId },
        select: { userId: true },
      }),
      this.db.user.findMany({
        where: { role: Role.admin },
        select: { id: true },
      }),
    ]);
    await this.realtimeGateway.emitDashboardStatsForUsers([
      teacherId,
      ...schoolAdmins.map((s) => s.userId),
      ...adminUsers.map((u) => u.id),
    ]);

    return {
      report: {
        id: report.id,
        school_id: report.schoolId,
        date: report.reportDate.toISOString().split('T')[0],
        grade: report.grade,
        period_id: report.periodId,
        start_time: (report as { startTime?: string | null }).startTime ?? null,
        end_time: (report as { endTime?: string | null }).endTime ?? null,
        report_status: toReportUiStatus(report.status),
        topics_taught: report.topicsTaught,
        activities:
          (report as { activities?: string | null }).activities ?? null,
        student_count: report.studentCount,
        duration_hours: report.durationHours,
        notes: report.notes,
      },
      // Lets the frontend show an accurate toast — attendance is only
      // actually flipped to Present once every scheduled period for the day
      // has been reported, and never when the day is already Leave-Approved.
      attendance_marked_present: attendanceMarkedPresent,
    };
  }

  /**
   * List reports for the current teacher (optional filters: school_id, date range).
   */
  async list(
    teacherId: number,
    query: {
      school_id?: string;
      date?: string;
      from?: string;
      to?: string;
      limit?: number;
    },
  ) {
    const where: {
      teacherId: number;
      schoolId?: string;
      reportDate?: { gte?: Date; lte?: Date };
    } = { teacherId };
    if (query.school_id) where.schoolId = query.school_id;
    if (query.date) {
      const start = new Date(query.date + 'T00:00:00.000Z');
      const end = new Date(query.date + 'T23:59:59.999Z');
      where.reportDate = { gte: start, lte: end };
    } else if (query.from || query.to) {
      where.reportDate = {};
      if (query.from)
        where.reportDate.gte = new Date(query.from + 'T00:00:00.000Z');
      if (query.to)
        where.reportDate.lte = new Date(query.to + 'T23:59:59.999Z');
    }
    const limit = Math.min(Number(query.limit) || 100, 500);
    // Real COUNT(*) queries, independent of the `take` cap above — the
    // Analytics page's "Total Reports (All time)" and "Approval Rate" cards
    // used to be derived from this same capped `findMany` result, silently
    // undercounting for any teacher with more than `limit` (max 500) reports
    // and dead-code-listing 'Rejected'/'Reviewed' reports as a nonexistent
    // 'Flagged' status. `approved`/`rejected` deliberately exclude
    // 'submitted'/'reviewed' so "Approval Rate" can be computed against only
    // the reports an admin has actually decided on, not diluted by ones
    // still awaiting review.
    const [total, pending, reviewed, approved, rejected] = await Promise.all([
      this.db.teacherReport.count({ where }),
      this.db.teacherReport.count({ where: { ...where, status: 'submitted' } }),
      this.db.teacherReport.count({ where: { ...where, status: 'reviewed' } }),
      this.db.teacherReport.count({ where: { ...where, status: 'approved' } }),
      this.db.teacherReport.count({ where: { ...where, status: 'rejected' } }),
    ]);
    const reports = await this.db.teacherReport.findMany({
      where,
      orderBy: { reportDate: 'desc' },
      take: limit,
    });
    return {
      reports: reports.map((r) => ({
        id: r.id,
        school_id: r.schoolId,
        date: r.reportDate.toISOString().split('T')[0],
        grade: r.grade,
        period_id: r.periodId,
        start_time: (r as { startTime?: string | null }).startTime ?? null,
        end_time: (r as { endTime?: string | null }).endTime ?? null,
        report_status: toReportUiStatus(r.status),
        topics_taught: r.topicsTaught,
        activities: (r as { activities?: string | null }).activities ?? null,
        student_count: r.studentCount,
        duration_hours: r.durationHours,
        notes: r.notes,
      })),
      stats: {
        total,
        pending,
        reviewed,
        approved,
        rejected,
      },
    };
  }
}
