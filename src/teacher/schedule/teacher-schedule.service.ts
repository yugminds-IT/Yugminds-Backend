import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AdminCalendarService } from '../../admin/calendar/calendar.service';
import { resolveWorkingDaysForDate } from '../../common/utils/working-days-history.util';

export interface TeacherWorkStatusForDate {
  /** Schools where the teacher is actually on duty today: assigned that weekday (per history) AND not a declared Holiday/Break, OR a declared CompensatoryWork day. */
  workingSchoolIds: string[];
  /** Schools closed today (Holiday/Break in SchoolCalendar), regardless of the teacher's weekly pattern. */
  holidaySchoolIds: string[];
  /** Schools open today but not part of the teacher's weekly working-days pattern at that school. */
  offScheduleSchoolIds: string[];
}

/**
 * Single source of truth for "which of a teacher's assigned schools is
 * this teacher actually supposed to be at on date D" — combining
 * TeacherWorkingDaysHistory (per-school weekly pattern, date-effective)
 * with SchoolCalendar (Holiday/Break/CompensatoryWork). Previously
 * `getToday`, report Present-marking, and the dashboard's "today's
 * classes" stat each derived "today" purely from ClassSchedule.dayOfWeek,
 * which can silently drift from the working-days/calendar system (e.g. a
 * teacher reassigned off Fridays at a school whose old Friday
 * ClassSchedule rows were never cleaned up). Every "today" call site
 * should resolve through here instead of re-deriving it locally.
 */
@Injectable()
export class TeacherScheduleService {
  constructor(
    private readonly db: DatabaseService,
    private readonly calendar: AdminCalendarService,
  ) {}

  async getWorkStatusForDate(
    teacherId: number,
    schoolIds: string[],
    date: Date,
  ): Promise<TeacherWorkStatusForDate> {
    const result: TeacherWorkStatusForDate = {
      workingSchoolIds: [],
      holidaySchoolIds: [],
      offScheduleSchoolIds: [],
    };
    if (schoolIds.length === 0) return result;

    const dateStr = date.toISOString().split('T')[0];
    const dayOfWeek = date.getUTCDay();
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;

    await Promise.all(
      schoolIds.map(async (schoolId) => {
        const [history, holidayEntries, compDates] = await Promise.all([
          this.db.teacherWorkingDaysHistory.findMany({
            where: { teacherId, schoolId, effectiveFrom: { lte: date } },
            select: { effectiveFrom: true, workingDays: true },
            orderBy: { effectiveFrom: 'asc' },
          }),
          this.calendar.getHolidayDatesForMonth(schoolId, year, month),
          this.calendar.getCompensatoryDatesForMonth(schoolId, year, month),
        ]);

        const isHoliday = holidayEntries.some(
          (e) => e.date === dateStr && (e.type === 'Holiday' || e.type === 'Break'),
        );
        const isCompWork = compDates.includes(dateStr);
        const isAssignedToday = resolveWorkingDaysForDate(history, date).includes(dayOfWeek);

        if (isCompWork) {
          result.workingSchoolIds.push(schoolId);
        } else if (isHoliday) {
          result.holidaySchoolIds.push(schoolId);
        } else if (isAssignedToday) {
          result.workingSchoolIds.push(schoolId);
        } else {
          result.offScheduleSchoolIds.push(schoolId);
        }
      }),
    );

    return result;
  }
}
