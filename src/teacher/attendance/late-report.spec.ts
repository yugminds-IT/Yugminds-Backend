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
