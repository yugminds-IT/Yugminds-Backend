import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { DatabaseService } from '../../database/database.service';
import { AdminCalendarService } from '../../admin/calendar/calendar.service';
import { resolveWorkingDaysForDate } from '../../common/utils/working-days-history.util';

export interface TeacherScheduleDayDto {
  date: string;
  school_id: string;
  school_name: string;
}

/**
 * Read-only calendar view for the teacher's own assigned schools — the
 * teacher-facing counterpart to /admin/calendar, scoped so a teacher can
 * never see another school's calendar. Answers "why did today behave
 * differently at School A vs School B" (holiday at one, not the other),
 * and now also "which school(s) am I actually at on a given day" via
 * `schedule` — resolved per day from TeacherWorkingDaysHistory so a
 * mid-month schedule swap between schools shows correctly on both sides
 * of the effective date instead of one flat pattern for the whole month.
 */
@Controller('teacher/calendar')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.teacher)
export class TeacherCalendarController {
  constructor(
    private readonly db: DatabaseService,
    private readonly calendar: AdminCalendarService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: { id: number },
    @Query('year') year?: string,
    @Query('month') month?: string,
  ) {
    const now = new Date();
    const y = year ?? String(now.getUTCFullYear());
    const m = month ?? String(now.getUTCMonth() + 1).padStart(2, '0');

    const teacherSchools = await this.db.teacherSchool.findMany({
      where: { teacherId: user.id },
      select: { schoolId: true, school: { select: { name: true } } },
    });
    const assignedSchoolIds = teacherSchools.map((s) => s.schoolId);
    const schoolNameById = new Map(
      teacherSchools.map((s) => [s.schoolId, s.school?.name ?? '']),
    );

    const [calendarResult, { schedule, unassignedDates }] = await Promise.all([
      this.calendar.listForSchools(assignedSchoolIds, y, m),
      this.resolveMonthlySchedule(user.id, Number(y), Number(m), schoolNameById),
    ]);

    return { ...calendarResult, schedule, unassigned_dates: unassignedDates };
  }

  /**
   * For each day in [year, month], which of the teacher's schools they're
   * actually scheduled to work at — deliberately queries
   * TeacherWorkingDaysHistory scoped by teacherId only (NOT schoolId): the
   * tenant-isolation layer in DatabaseService rejects any query whose
   * schoolId filter spans more than the caller's current tenant, so a
   * multi-school teacher's own history must be read unfiltered and grouped
   * in-memory instead (same pattern as
   * TeacherLeavesService.resolveSchoolRangesForLeave).
   */
  private async resolveMonthlySchedule(
    teacherId: number,
    year: number,
    month: number,
    schoolNameById: Map<string, string>,
  ): Promise<{ schedule: TeacherScheduleDayDto[]; unassignedDates: string[] }> {
    const history = await this.db.teacherWorkingDaysHistory.findMany({
      where: { teacherId },
      select: { schoolId: true, workingDays: true, effectiveFrom: true },
    });
    const historyBySchool = new Map<
      string,
      Array<{ effectiveFrom: Date; workingDays: number[] }>
    >();
    for (const h of history) {
      if (!historyBySchool.has(h.schoolId)) historyBySchool.set(h.schoolId, []);
      historyBySchool.get(h.schoolId)!.push(h);
    }

    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0));
    const schedule: TeacherScheduleDayDto[] = [];
    // A day with no scheduled school is ambiguous on its own — it could mean
    // "genuinely off under your current pattern" (e.g. Sunday) or "you had
    // no assignment at ANY school yet" (true for every weekday before your
    // first-ever assignment, not just the structurally-off ones). The
    // frontend previously labeled both "Weekly off," which is only accurate
    // for the first case — flag the second explicitly so it can say
    // something like "Not yet assigned" instead.
    const unassignedDates: string[] = [];
    for (
      let d = new Date(start);
      d <= end;
      d = new Date(d.getTime() + 24 * 60 * 60 * 1000)
    ) {
      const dayOfWeek = d.getUTCDay();
      const dateStr = d.toISOString().split('T')[0];
      let assignedSomewhere = false;
      for (const [schoolId, entries] of historyBySchool) {
        if (entries.some((e) => e.effectiveFrom <= d)) assignedSomewhere = true;
        if (!resolveWorkingDaysForDate(entries, d).includes(dayOfWeek)) continue;
        schedule.push({
          date: dateStr,
          school_id: schoolId,
          school_name: schoolNameById.get(schoolId) ?? '',
        });
      }
      if (!assignedSomewhere) unassignedDates.push(dateStr);
    }
    return { schedule, unassignedDates };
  }
}
