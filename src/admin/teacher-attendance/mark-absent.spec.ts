import { AdminTeacherAttendanceService } from './teacher-attendance.service';

// Monday. Rule: no (non-rejected) report = Absent, timetable or not.
const MON = new Date('2026-07-27T00:00:00.000Z');

function setup(opts: {
  schedules?: Array<{ teacherId: number; schoolId: string; periodId: string }>;
  reports?: Array<{
    teacherId: number;
    schoolId: string;
    periodId: string | null;
  }>;
  existing?: Array<{ teacherId: number; schoolId: string }>;
  leaves?: Array<{ teacherId: number }>;
}) {
  const createMany = jest.fn().mockResolvedValue({ count: 0 });
  const reportsFind = jest.fn().mockResolvedValue(opts.reports ?? []);
  const db: any = {
    teacherSchool: {
      findMany: jest.fn().mockResolvedValue([{ teacherId: 1, schoolId: 's' }]),
    },
    attendance: {
      findMany: jest.fn().mockResolvedValue(opts.existing ?? []),
      createMany: createMany.mockImplementation(async ({ data }) => ({
        count: data.length,
      })),
    },
    teacherLeave: { findMany: jest.fn().mockResolvedValue(opts.leaves ?? []) },
    teacherWorkingDaysHistory: {
      findMany: jest.fn().mockResolvedValue([
        {
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          workingDays: [1, 2, 3, 4, 5, 6],
        },
      ]),
    },
    classSchedule: {
      findMany: jest.fn().mockResolvedValue(opts.schedules ?? []),
    },
    teacherReport: { findMany: reportsFind },
  };
  const cal: any = { getHolidayDatesForMonth: jest.fn().mockResolvedValue([]) };
  return {
    svc: new AdminTeacherAttendanceService(db, cal),
    createMany,
    reportsFind,
  };
}

const sched = [{ teacherId: 1, schoolId: 's', periodId: 'p1' }];

describe('markAbsentForToday', () => {
  it('marks Absent a teacher with a timetable and no report', async () => {
    const { svc, createMany } = setup({ schedules: sched });
    await svc.markAbsentForToday(MON);
    expect(createMany).toHaveBeenCalledWith({
      data: [{ teacherId: 1, schoolId: 's', date: MON, status: 'Absent' }],
      skipDuplicates: true,
    });
  });

  it('marks Absent a teacher with NO timetable and no report', async () => {
    const { svc, createMany } = setup({});
    await svc.markAbsentForToday(MON);
    expect(createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it('skips a no-timetable teacher who did report', async () => {
    const { svc, createMany } = setup({
      reports: [{ teacherId: 1, schoolId: 's', periodId: 'p9' }],
    });
    await svc.markAbsentForToday(MON);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('skips a teacher whose periods are all reported', async () => {
    const { svc, createMany } = setup({
      schedules: sched,
      reports: [{ teacherId: 1, schoolId: 's', periodId: 'p1' }],
    });
    await svc.markAbsentForToday(MON);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('counts rejected reports as covered (no status filter on the query)', async () => {
    const { svc, reportsFind } = setup({ schedules: sched });
    await svc.markAbsentForToday(MON);
    expect(reportsFind.mock.calls[0][0].where.status).toBeUndefined();
  });

  it('skips teachers on leave or already having a row (idempotent re-run)', async () => {
    const a = setup({ schedules: sched, leaves: [{ teacherId: 1 }] });
    await a.svc.markAbsentForToday(MON);
    expect(a.createMany).not.toHaveBeenCalled();
    const b = setup({
      schedules: sched,
      existing: [{ teacherId: 1, schoolId: 's' }],
    });
    await b.svc.markAbsentForToday(MON);
    expect(b.createMany).not.toHaveBeenCalled();
  });

  it('uses skipDuplicates so a racing late report cannot abort the run', async () => {
    const { svc, createMany } = setup({ schedules: sched });
    await svc.markAbsentForToday(MON);
    expect(createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it("only counts reports submitted before that day's 8pm cutoff (catch-up run: a 9pm report must not rescue the day)", async () => {
    const { svc, reportsFind } = setup({ schedules: sched });
    await svc.markAbsentForToday(MON);
    const where = reportsFind.mock.calls[0][0].where;
    expect(where.createdAt.lt.toISOString()).toBe('2026-07-27T14:30:00.000Z');
  });
});
