import { TeacherAttendanceService } from './attendance.service';

jest.mock('../../common/utils/date.util', () => ({
  ...jest.requireActual('../../common/utils/date.util'),
  getTodayIstDateStr: () => '2026-07-27',
  isBeforeAttendanceCutoff: jest.fn(() => true),
}));
import { isBeforeAttendanceCutoff } from '../../common/utils/date.util';

// getToday with no Attendance row yet: status is inferred.
function make() {
  const db: any = {
    teacherSchool: {
      findMany: jest.fn().mockResolvedValue([{ schoolId: 's1' }]),
      findFirst: jest.fn().mockResolvedValue({ schoolId: 's1' }),
    },
    classSchedule: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ periodId: 'p1', startTime: '09:00' }]),
    },
    period: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'p1', startTime: '09:00', endTime: '09:40' },
        ]),
    },
    teacherReport: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ periodId: 'p1', status: 'submitted' }]),
    },
    attendance: { findFirst: jest.fn().mockResolvedValue(null) },
    teacherLeave: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const schedule: any = {
    getWorkStatusForDate: jest.fn().mockResolvedValue({
      workingSchoolIds: ['s1'],
      holidaySchoolIds: [],
      offScheduleSchoolIds: [],
      holidays: {},
    }),
  };
  return new TeacherAttendanceService(db, schedule);
}

describe('getToday inferred status (no attendance row)', () => {
  it('before the cutoff with every period reported -> Present', async () => {
    const r = await make().getToday(1, 's1', '2026-07-27');
    expect(r.attendance.status).toBe('Present');
    expect(r.before_cutoff).toBe(true);
  });
  it('after the cutoff a missing row is Absent — a late report never makes the day Present', async () => {
    (isBeforeAttendanceCutoff as jest.Mock)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const r = await make().getToday(1, 's1', '2026-07-27');
    expect(r.attendance.status).toBe('Absent');
    expect(r.attendance.late_report).toBe(true);
    (isBeforeAttendanceCutoff as jest.Mock).mockReturnValue(true);
  });
  it('a past date with no row is Absent', async () => {
    const r = await make().getToday(1, 's1', '2026-07-24');
    expect(r.attendance.status).toBe('Absent');
  });
});
