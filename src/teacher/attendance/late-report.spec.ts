import { TeacherAttendanceService } from './attendance.service';

// An Absent day that still has a report = the report came after the 8pm cutoff.
describe('TeacherAttendanceService.list late_report flag', () => {
  const rec = (id: string, date: string, status: string) => ({
    id,
    schoolId: 's1',
    date: new Date(`${date}T00:00:00.000Z`),
    status,
    createdAt: new Date(),
  });
  function make(reports: Array<{ schoolId: string; reportDate: Date }>) {
    const db: any = {
      teacherSchool: {
        findFirst: jest.fn().mockResolvedValue({ schoolId: 's1' }),
        findMany: jest.fn().mockResolvedValue([{ schoolId: 's1' }]),
      },
      attendance: {
        findMany: jest.fn().mockResolvedValue([
          rec('a', '2026-07-20', 'Absent'), // has a report -> late
          rec('b', '2026-07-21', 'Absent'), // no report -> plain absent
          rec('c', '2026-07-22', 'Present'),
        ]),
      },
      teacherReport: { findMany: jest.fn().mockResolvedValue(reports) },
      teacherLeave: { findMany: jest.fn().mockResolvedValue([]) },
      teacherWorkingDaysHistory: { findMany: jest.fn().mockResolvedValue([]) },
      schoolCalendar: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return new TeacherAttendanceService(db, {} as any);
  }
  it('flags only Absent days that have a submitted report', async () => {
    const svc = make([
      { schoolId: 's1', reportDate: new Date('2026-07-20T12:00:00.000Z') },
    ]);
    const { attendance } = await svc.list(1, 's1', '2026-07-20', '2026-07-22');
    expect(attendance.find((a) => a.id === 'a')).toMatchObject({
      late_report: true,
    });
    expect(attendance.find((a) => a.id === 'b')?.late_report).toBeUndefined();
    expect(attendance.find((a) => a.id === 'c')?.late_report).toBeUndefined();
  });
});

// A past working day with no stored row must show as Absent, matching getMonthly's totals.
describe('TeacherAttendanceService.list missing days', () => {
  it('adds Absent for past scheduled days with no record, never for recorded days', async () => {
    const db: any = {
      teacherSchool: {
        findFirst: jest.fn().mockResolvedValue({ schoolId: 's1' }),
        findMany: jest.fn().mockResolvedValue([{ schoolId: 's1' }]),
      },
      attendance: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'p',
            schoolId: 's1',
            date: new Date('2020-01-06T00:00:00.000Z'),
            status: 'Present',
            createdAt: new Date(),
          },
        ]),
      },
      teacherReport: { findMany: jest.fn().mockResolvedValue([]) },
      teacherLeave: { findMany: jest.fn().mockResolvedValue([]) },
      // Mon-Tue working, from before the range
      teacherWorkingDaysHistory: {
        findMany: jest.fn().mockResolvedValue([
          {
            effectiveFrom: new Date('2019-01-01T00:00:00.000Z'),
            workingDays: [1, 2],
            workingDaySlots: null,
          },
        ]),
      },
      schoolCalendar: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const svc = new TeacherAttendanceService(db, {} as any);
    const { attendance } = await svc.list(1, 's1', '2020-01-06', '2020-01-07');
    expect(attendance.map((a) => [a.date, a.status])).toEqual([
      ['2020-01-07', 'Absent'],
      ['2020-01-06', 'Present'],
    ]);
  });
});

// School figure = that school's days only; overall = all schools combined, with a per-school split.
describe('TeacherAttendanceService.getMonthly school vs overall', () => {
  const hist = (days: number[]) => ({
    effectiveFrom: new Date('2019-01-01T00:00:00.000Z'),
    workingDays: days,
    workingDaySlots: null,
  });
  const make = () => {
    const db: any = {
      teacherSchool: {
        findFirst: jest.fn().mockResolvedValue({ schoolId: 's1' }),
        findMany: jest
          .fn()
          .mockResolvedValue([{ schoolId: 's1' }, { schoolId: 's2' }]),
      },
      // s1 works Mondays, s2 works Tuesdays; only the s1 Monday was attended.
      attendance: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'p',
            schoolId: 's1',
            date: new Date('2020-01-06T00:00:00.000Z'),
            status: 'Present',
            createdAt: new Date(),
          },
        ]),
      },
      teacherLeave: { findMany: jest.fn().mockResolvedValue([]) },
      teacherWorkingDaysHistory: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }: any) =>
            Promise.resolve([hist(where.schoolId === 's1' ? [1] : [2])]),
          ),
      },
      schoolCalendar: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return new TeacherAttendanceService(db, {} as any);
  };
  const jan = (r: any) => r.monthlyData.find((m: any) => m.month === '2020-01');

  it('scopes to one school, and splits overall by school', async () => {
    const svc = make();
    const s1 = jan(await svc.getMonthly(1, 's1', 1, '2020-01'));
    const s2 = jan(await svc.getMonthly(1, 's2', 1, '2020-01'));
    const all = jan(await svc.getMonthly(1, undefined, 1, '2020-01'));
    expect(s1.by_school).toBeUndefined();
    expect(s1.present_days).toBeGreaterThan(0);
    expect(s2.present_days).toBe(0);
    expect(s2.absent_days).toBeGreaterThan(0);
    expect(all.present_days).toBe(s1.present_days + s2.present_days);
    expect(all.total_working_days).toBe(
      s1.total_working_days + s2.total_working_days,
    );
    expect(
      all.by_school.map((b: any) => [b.school_id, b.present_days]),
    ).toEqual([
      ['s1', s1.present_days],
      ['s2', 0],
    ]);
  });
});
