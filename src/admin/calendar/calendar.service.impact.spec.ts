import { AdminCalendarService } from './calendar.service';

describe('AdminCalendarService.impact', () => {
  // 2026-11-09 is a Monday (getUTCDay() === 1)
  const monday = new Date('2026-11-09T00:00:00Z');
  const entry = (over: Record<string, unknown> = {}) => ({
    id: 'e1',
    schoolId: 's1',
    date: monday,
    endDate: null,
    type: 'Holiday',
    name: 'Diwali',
    school: { id: 's1', name: 'Alpha School' },
    ...over,
  });
  const teacher = (teacherId: number, schoolId: string, name: string) => ({
    teacherId,
    schoolId,
    teacher: { email: `${name}@x.org`, profile: { fullName: name } },
  });
  let db: any;
  let service: AdminCalendarService;
  beforeEach(() => {
    db = {
      schoolCalendar: { findMany: jest.fn().mockResolvedValue([entry()]) },
      teacherSchool: { findMany: jest.fn().mockResolvedValue([]) },
      classSchedule: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new AdminCalendarService(db);
  });

  it('lists teachers who have classes on that weekday, with how many', async () => {
    db.teacherSchool.findMany.mockResolvedValue([
      teacher(1, 's1', 'Asha'),
      teacher(2, 's1', 'Bala'),
    ]);
    db.classSchedule.findMany.mockResolvedValue([
      { schoolId: 's1', teacherId: 1, dayOfWeek: 1 },
      { schoolId: 's1', teacherId: 1, dayOfWeek: 1 },
      { schoolId: 's1', teacherId: 1, dayOfWeek: 2 }, // a Tuesday class: not affected
      { schoolId: 's1', teacherId: 2, dayOfWeek: 3 },
    ]);
    const r = await service.impact(['e1']);
    expect(r.teachers).toEqual([
      {
        id: 1,
        name: 'Asha',
        email: 'Asha@x.org',
        classes: 2,
        schools: [{ id: 's1', name: 'Alpha School', classes: 2 }],
      },
    ]);
    expect(r.without_classes).toEqual([{ id: 2, name: 'Bala' }]);
    expect(r.schools).toEqual([
      { id: 's1', name: 'Alpha School', teachers: 1 },
    ]);
  });

  it('counts a class once for each matching date in a multi-day break', async () => {
    db.schoolCalendar.findMany.mockResolvedValue([
      entry({ endDate: new Date('2026-11-16T00:00:00Z'), type: 'Break' }),
    ]); // Mon..next Mon = two Mondays
    db.teacherSchool.findMany.mockResolvedValue([teacher(1, 's1', 'Asha')]);
    db.classSchedule.findMany.mockResolvedValue([
      { schoolId: 's1', teacherId: 1, dayOfWeek: 1 },
    ]);
    const r = await service.impact(['e1']);
    expect(r.teachers[0].classes).toBe(2);
  });

  it('names every school of a batch and each teacher once, across schools', async () => {
    db.schoolCalendar.findMany.mockResolvedValue([
      entry(),
      entry({
        id: 'e2',
        schoolId: 's2',
        school: { id: 's2', name: 'Beta School' },
      }),
    ]);
    db.teacherSchool.findMany.mockResolvedValue([
      teacher(1, 's1', 'Asha'),
      teacher(1, 's2', 'Asha'),
    ]);
    db.classSchedule.findMany.mockResolvedValue([
      { schoolId: 's1', teacherId: 1, dayOfWeek: 1 },
      { schoolId: 's2', teacherId: 1, dayOfWeek: 1 },
    ]);
    const r = await service.impact(['e1', 'e2']);
    expect(r.schools.map((s) => s.name)).toEqual([
      'Alpha School',
      'Beta School',
    ]);
    expect(r.teachers).toHaveLength(1);
    expect(r.teachers[0].schools.map((s) => s.name)).toEqual([
      'Alpha School',
      'Beta School',
    ]);
  });

  it('ignores a teacher who was assigned to the school only after these dates', async () => {
    db.teacherSchool.findMany.mockResolvedValue([
      {
        ...teacher(1, 's1', 'Asha'),
        assignedFrom: new Date('2026-12-01T00:00:00Z'),
        assignedUntil: null,
      },
      {
        ...teacher(2, 's1', 'Bala'),
        assignedFrom: new Date('2026-01-01T00:00:00Z'),
        assignedUntil: null,
      },
    ]);
    db.classSchedule.findMany.mockResolvedValue([
      { schoolId: 's1', teacherId: 1, dayOfWeek: 1 },
      { schoolId: 's1', teacherId: 2, dayOfWeek: 1 },
    ]);
    const r = await service.impact(['e1']);
    expect(r.teachers.map((t) => t.name)).toEqual(['Bala']);
    expect(r.without_classes).toEqual([]); // the later hire is not "assigned here" yet either
  });

  it('includes a teacher who has classes in the timetable but no assignment row', async () => {
    db.classSchedule.findMany.mockResolvedValue([
      { schoolId: 's1', teacherId: 9, dayOfWeek: 1 },
    ]);
    db.user.findMany.mockResolvedValue([
      { id: 9, email: 'z@x.org', profile: { fullName: 'Zed' } },
    ]);
    const r = await service.impact(['e1']);
    expect(r.teachers).toEqual([
      {
        id: 9,
        name: 'Zed',
        email: 'z@x.org',
        classes: 1,
        schools: [{ id: 's1', name: 'Alpha School', classes: 1 }],
      },
    ]);
  });

  it('skips a timetable teacher who is no longer active', async () => {
    db.classSchedule.findMany.mockResolvedValue([
      { schoolId: 's1', teacherId: 9, dayOfWeek: 1 },
    ]);
    db.user.findMany.mockResolvedValue([]); // inactive or deleted: filtered out by the query
    expect((await service.impact(['e1'])).teachers).toEqual([]);
  });

  it('refuses an empty list and an unknown entry', async () => {
    await expect(service.impact([])).rejects.toThrow(
      'Provide at least one entry id',
    );
    db.schoolCalendar.findMany.mockResolvedValue([]);
    await expect(service.impact(['nope'])).rejects.toThrow(
      'Calendar entry not found',
    );
  });
});
