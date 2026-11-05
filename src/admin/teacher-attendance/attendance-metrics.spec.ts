import { AdminTeacherAttendanceService } from './teacher-attendance.service';

// Rule: no report = Absent. Past uncovered working days are Absent (even with
// no Attendance row); today stays Unreported.
describe('computeAttendanceMetrics', () => {
  it('counts past uncovered days as absent and today as unreported', () => {
    const svc = new AdminTeacherAttendanceService({} as never, {} as never);
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata',
    });
    const past = (n: number) => {
      const d = new Date(`${today}T00:00:00.000Z`);
      d.setUTCDate(d.getUTCDate() - n);
      return d.toISOString().split('T')[0];
    };
    const m = (svc as any).computeAttendanceMetrics(
      [{ status: 'Present', date: new Date(`${past(3)}T00:00:00.000Z`) }],
      [],
      new Date(`${past(3)}T00:00:00.000Z`),
      new Date(`${today}T23:59:59.999Z`),
      new Set([past(3), past(2), past(1), today]),
    );
    expect(m).toMatchObject({
      present_days: 1,
      absent_days: 2,
      unreported_days: 1,
      total_working_days: 4,
      attendance_percentage: 25,
    });
  });

  it('late_report_days counts Absent days that still have a report (report after 8pm)', () => {
    const svc = new AdminTeacherAttendanceService({} as never, {} as never);
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata',
    });
    const d = (n: number) => {
      const x = new Date(`${today}T00:00:00.000Z`);
      x.setUTCDate(x.getUTCDate() - n);
      return x.toISOString().split('T')[0];
    };
    const m = (svc as any).computeAttendanceMetrics(
      [],
      [],
      new Date(`${d(3)}T00:00:00.000Z`),
      new Date(`${today}T23:59:59.999Z`),
      new Set([d(3), d(2), d(1)]),
      new Set([d(2)]), // reported on d(2) only, yet that day is Absent
    );
    expect(m.absent_days).toBe(3);
    expect(m.late_report_days).toBe(1);
  });
});
