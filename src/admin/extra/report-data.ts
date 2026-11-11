import { Role } from '@prisma/client';
import type { DatabaseService } from '../../database/database.service';
import { enrolmentProgress } from '../../common/utils/enrolment-progress';
import type { ReportPdfOptions } from '../../common/reports/report-pdf';

export interface ReportFilters {
  schoolIds?: string[];
  teacherIds?: number[];
  studentIds?: number[];
  courseIds?: string[];
}

export type ReportDoc = Omit<ReportPdfOptions, 'generatedAt'>;

const TAKE = 500;
const DASH = '—';
const date = (d?: Date | null) =>
  d
    ? d.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : DASH;
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 100) : null;
const pctText = (v: number | null) => (v === null ? DASH : String(v));
const top = (m: Map<string, number>, n = 6) =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, value]) => ({ label, value }));
const capNote = (shown: number, total: number, what: string) =>
  total > shown
    ? `Showing the first ${shown.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')} ${what}. Filter by school to see the rest.`
    : undefined;

// ── Schools ──────────────────────────────────────────────────────────────────
async function schoolsReport(
  db: DatabaseService,
  f: ReportFilters,
): Promise<ReportDoc> {
  const where = {
    deletedAt: null,
    ...(f.schoolIds ? { id: { in: f.schoolIds } } : {}),
  };
  const [total, schools] = await Promise.all([
    db.school.count({ where }),
    db.school.findMany({
      where,
      orderBy: { name: 'asc' },
      take: TAKE,
      select: {
        id: true,
        name: true,
        schoolCode: true,
        city: true,
        state: true,
        principalName: true,
        isActive: true,
        createdAt: true,
      },
    }),
  ]);
  const ids = schools.map((s) => s.id);
  const [students, teachers, courses, distinctTeachers] = await Promise.all([
    db.studentSchool.groupBy({
      by: ['schoolId'],
      where: { schoolId: { in: ids }, isActive: true },
      _count: { id: true },
    }),
    db.teacherSchool.groupBy({
      by: ['schoolId'],
      where: { schoolId: { in: ids } },
      _count: { id: true },
    }),
    db.courseAccess.groupBy({
      by: ['schoolId', 'courseId'],
      where: { schoolId: { in: ids } },
    }),
    db.teacherSchool.groupBy({
      by: ['teacherId'],
      where: { schoolId: { in: ids } },
    }),
  ]);
  const sMap = new Map(students.map((r) => [r.schoolId, r._count.id]));
  const tMap = new Map(teachers.map((r) => [r.schoolId, r._count.id]));
  const cMap = new Map<string, number>();
  for (const r of courses)
    cMap.set(r.schoolId, (cMap.get(r.schoolId) ?? 0) + 1);

  const studentTotal = [...sMap.values()].reduce((a, b) => a + b, 0);
  const active = schools.filter((s) => s.isActive).length;
  return {
    title: 'School report',
    scope: `${plural(total, 'school')}, ${active.toLocaleString('en-IN')} active. Shows who teaches and learns at each one.`,
    focus: 'Schools',
    stats: [
      { label: 'Schools', value: total },
      { label: 'Students', value: studentTotal },
      { label: 'Teachers', value: distinctTeachers.length },
      {
        label: 'Courses assigned',
        value: new Set(courses.map((c) => c.courseId)).size,
      },
    ],
    charts:
      schools.length > 1
        ? [
            {
              title: 'Students per school',
              items: top(
                new Map(schools.map((s) => [s.name, sMap.get(s.id) ?? 0])),
                8,
              ),
            },
          ]
        : [],
    columns: [
      { label: 'School' },
      { label: 'Code' },
      { label: 'Principal' },
      { label: 'Students', kind: 'num' },
      { label: 'Teachers', kind: 'num' },
      { label: 'Courses', kind: 'num' },
      { label: 'Status', kind: 'status' },
      { label: 'Registered on', kind: 'date' },
    ],
    rows: schools.map((s) => [
      [s.name, [s.city, s.state].filter(Boolean).join(', ')]
        .filter(Boolean)
        .join('\n'),
      s.schoolCode ?? DASH,
      s.principalName ?? DASH,
      String(sMap.get(s.id) ?? 0),
      String(tMap.get(s.id) ?? 0),
      String(cMap.get(s.id) ?? 0),
      s.isActive ? 'Active' : 'Inactive',
      date(s.createdAt),
    ]),
    footnote: capNote(schools.length, total, 'schools'),
  };
}

// ── Teachers ─────────────────────────────────────────────────────────────────
async function teachersReport(
  db: DatabaseService,
  f: ReportFilters,
): Promise<ReportDoc> {
  const where: any = {
    role: Role.teacher,
    deletedAt: null,
    ...(f.teacherIds ? { id: { in: f.teacherIds } } : {}),
    ...(f.schoolIds && !f.teacherIds
      ? { teacherSchools: { some: { schoolId: { in: f.schoolIds } } } }
      : {}),
  };
  const [total, teachers] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: TAKE,
      select: {
        id: true,
        email: true,
        isActive: true,
        profile: { select: { fullName: true } },
        teacherSchools: {
          select: { subjects: true, school: { select: { name: true } } },
        },
      },
    }),
  ]);
  const ids = teachers.map((t) => t.id);
  const school = f.schoolIds ? { schoolId: { in: f.schoolIds } } : {};
  const [reports, attendance, leaves] = await Promise.all([
    db.teacherReport.groupBy({
      by: ['teacherId'],
      where: { teacherId: { in: ids }, ...school },
      _count: { id: true },
      _sum: { durationHours: true },
      _avg: { studentCount: true },
      _max: { reportDate: true },
    }),
    db.attendance.groupBy({
      by: ['teacherId', 'status'],
      where: { teacherId: { in: ids }, ...school },
      _count: { id: true },
    }),
    db.teacherLeave.findMany({
      where: { teacherId: { in: ids }, status: 'approved', ...school },
      select: { teacherId: true, startDate: true, endDate: true },
    }),
  ]);
  const rep = new Map(reports.map((r) => [r.teacherId, r]));
  const present = new Map<number, number>();
  const marked = new Map<number, number>();
  for (const a of attendance) {
    // Statuses are stored capitalised ("Present", "Leave-Approved", "Unreported"). Approved leave is not an absence.
    const st = a.status.toLowerCase();
    if (st.startsWith('leave')) continue;
    marked.set(a.teacherId, (marked.get(a.teacherId) ?? 0) + a._count.id);
    if (st === 'present')
      present.set(a.teacherId, (present.get(a.teacherId) ?? 0) + a._count.id);
  }
  const leaveDays = new Map<number, number>();
  for (const l of leaves) {
    const days = Math.max(
      1,
      Math.round((l.endDate.getTime() - l.startDate.getTime()) / 86_400_000) +
        1,
    );
    leaveDays.set(l.teacherId, (leaveDays.get(l.teacherId) ?? 0) + days);
  }

  const classes = reports.reduce((a, r) => a + r._count.id, 0);
  const hours = reports.reduce((a, r) => a + (r._sum.durationHours ?? 0), 0);
  const sumPresent = [...present.values()].reduce((a, b) => a + b, 0);
  const sumMarked = [...marked.values()].reduce((a, b) => a + b, 0);
  const name = (t: (typeof teachers)[number]) =>
    t.profile?.fullName ?? t.email ?? DASH;

  return {
    title: 'Teacher performance report',
    scope: `${plural(total, 'teacher')}${f.schoolIds ? ' at the chosen schools' : ''}. Covers classes taught, teaching hours, attendance and leave.`,
    focus: 'Teachers',
    landscape: true,
    stats: [
      { label: 'Teachers', value: total },
      { label: 'Classes taught', value: classes },
      { label: 'Hours taught', value: Math.round(hours) },
      {
        label: 'Attendance rate',
        value:
          pct(sumPresent, sumMarked) === null
            ? DASH
            : `${pct(sumPresent, sumMarked)}%`,
      },
    ],
    charts: [
      {
        title: 'Classes taught',
        items: top(
          new Map(
            teachers.map((t) => [name(t), rep.get(t.id)?._count.id ?? 0]),
          ),
          8,
        ),
      },
    ],
    columns: [
      { label: 'Teacher' },
      { label: 'School' },
      { label: 'Classes', kind: 'num' },
      { label: 'Hours', kind: 'num' },
      { label: 'Avg class size', kind: 'num' },
      { label: 'Attendance', kind: 'bar' },
      { label: 'Leave days', kind: 'num' },
      { label: 'Last class', kind: 'date' },
      { label: 'Status', kind: 'status' },
    ],
    rows: teachers.map((t) => {
      const r = rep.get(t.id);
      const subjects = [...new Set(t.teacherSchools.flatMap((s) => s.subjects))]
        .slice(0, 3)
        .join(', ');
      const schools = [...new Set(t.teacherSchools.map((s) => s.school.name))];
      const classCount = r?._count.id ?? 0;
      return [
        [name(t), t.email].filter(Boolean).join('\n'),
        [
          schools[0] ?? DASH,
          schools.length > 1 ? `+${schools.length - 1} more` : '',
          subjects,
        ]
          .filter(Boolean)
          .join('\n'),
        String(classCount),
        r?._sum.durationHours
          ? String(Math.round(r._sum.durationHours * 10) / 10)
          : DASH,
        r?._avg.studentCount != null
          ? String(Math.round(r._avg.studentCount))
          : DASH,
        pctText(pct(present.get(t.id) ?? 0, marked.get(t.id) ?? 0)),
        String(leaveDays.get(t.id) ?? 0),
        date(r?._max.reportDate),
        t.isActive ? 'Active' : 'Inactive',
      ];
    }),
    footnote: capNote(teachers.length, total, 'teachers'),
  };
}

// ── Students ─────────────────────────────────────────────────────────────────
async function studentsReport(
  db: DatabaseService,
  f: ReportFilters,
): Promise<ReportDoc> {
  const where: any = {
    role: Role.student,
    deletedAt: null,
    ...(f.studentIds ? { id: { in: f.studentIds } } : {}),
    ...(f.schoolIds && !f.studentIds
      ? { studentSchools: { some: { schoolId: { in: f.schoolIds } } } }
      : {}),
  };
  const [total, students] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: TAKE,
      select: {
        id: true,
        email: true,
        createdAt: true,
        profile: { select: { fullName: true } },
        studentSchools: {
          where: f.schoolIds ? { schoolId: { in: f.schoolIds } } : {},
          orderBy: { isActive: 'desc' },
          take: 1,
          select: {
            grade: true,
            section: true,
            school: { select: { name: true } },
          },
        },
      },
    }),
  ]);
  const ids = students.map((s) => s.id);
  // Strip numbers cover everyone matching the filters, not just the rows shown.
  const allIds = f.schoolIds
    ? [
        ...new Set(
          (
            await db.studentSchool.findMany({
              where: { schoolId: { in: f.schoolIds } },
              select: { studentId: true },
            })
          ).map((r) => r.studentId),
        ),
      ]
    : undefined;
  const [prog, certs, schoolGroups, learners, certAll] = await Promise.all([
    enrolmentProgress(db, { studentIds: ids }),
    db.studentCertificate.groupBy({
      by: ['studentId'],
      where: { studentId: { in: ids }, status: { not: 'revoked' } },
      _count: { id: true },
    }),
    db.studentSchool.groupBy({
      by: ['schoolId'],
      where: {
        isActive: true,
        ...(f.schoolIds ? { schoolId: { in: f.schoolIds } } : {}),
      },
    }),
    db.studentCourse.groupBy({
      by: ['studentId'],
      where: allIds ? { studentId: { in: allIds } } : {},
    }),
    db.studentCertificate.count({
      where: {
        status: { not: 'revoked' },
        ...(allIds ? { studentId: { in: allIds } } : {}),
      },
    }),
  ]);
  const certMap = new Map(certs.map((c) => [c.studentId, c._count.id]));
  const perStudent = new Map<number, typeof prog>();
  for (const p of prog)
    (
      perStudent.get(p.studentId) ??
      perStudent.set(p.studentId, []).get(p.studentId)!
    ).push(p);
  const avg = (sid: number) => {
    const list = perStudent.get(sid) ?? [];
    return list.length
      ? list.reduce((a, p) => a + p.progressPercentage, 0) / list.length
      : null;
  };

  const byGrade = new Map<string, number>();
  const stage = {
    'No course yet': 0,
    'Not started': 0,
    'In progress': 0,
    Completed: 0,
  };
  const classOf = (s: (typeof students)[number]) => {
    const ss = s.studentSchools[0];
    // Stored as "Grade 8" / "Section A" in places; show the short form "8-A".
    const short = [
      ss?.grade?.replace(/^grade\s*/i, ''),
      ss?.section?.replace(/^section\s*/i, ''),
    ]
      .filter(Boolean)
      .join('-');
    return short || DASH;
  };
  for (const s of students) {
    const g = classOf(s).split('-')[0];
    if (g !== DASH)
      byGrade.set(
        `Grade ${g.replace(/^grade\s*/i, '')}`,
        (byGrade.get(`Grade ${g.replace(/^grade\s*/i, '')}`) ?? 0) + 1,
      );
    const list = perStudent.get(s.id) ?? [];
    if (!list.length) stage['No course yet']++;
    else if (list.every((p) => p.status === 'completed')) stage.Completed++;
    else if (list.every((p) => p.status === 'not_started'))
      stage['Not started']++;
    else stage['In progress']++;
  }
  const gradeItems = [...byGrade.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .slice(0, 8)
    .map(([label, value]) => ({ label, value }));

  return {
    title: 'Student enrollment report',
    scope: `${plural(total, 'student')}${f.schoolIds ? ' at the chosen schools' : ''}. Shows where each one studies and how far they have got.`,
    focus: 'Students',
    stats: [
      { label: 'Students', value: total },
      { label: 'Schools', value: schoolGroups.length },
      { label: 'Learning in courses', value: learners.length },
      { label: 'Certificates', value: certAll },
    ],
    charts: [
      { title: 'Students by grade', items: gradeItems },
      {
        title: 'Where students are',
        items: Object.entries(stage).map(([label, value]) => ({
          label,
          value,
        })),
      },
    ],
    columns: [
      { label: 'Student' },
      { label: 'School' },
      { label: 'Class' },
      { label: 'Courses', kind: 'num' },
      { label: 'Progress', kind: 'bar' },
      { label: 'Certificates', kind: 'num' },
      { label: 'Enrolled on', kind: 'date' },
    ],
    rows: students.map((s) => {
      const a = avg(s.id);
      return [
        [s.profile?.fullName ?? s.email, s.profile?.fullName ? s.email : '']
          .filter(Boolean)
          .join('\n'),
        s.studentSchools[0]?.school.name ?? DASH,
        classOf(s),
        String((perStudent.get(s.id) ?? []).length),
        a === null ? DASH : String(Math.round(a)),
        String(certMap.get(s.id) ?? 0),
        date(s.createdAt),
      ];
    }),
    footnote: capNote(students.length, total, 'students'),
  };
}

// ── Courses ──────────────────────────────────────────────────────────────────
async function coursesReport(
  db: DatabaseService,
  f: ReportFilters,
): Promise<ReportDoc> {
  const where: any = {
    deletedAt: null,
    ...(f.courseIds ? { id: { in: f.courseIds } } : {}),
    ...(f.schoolIds && !f.courseIds
      ? { courseAccess: { some: { schoolId: { in: f.schoolIds } } } }
      : {}),
  };
  const [total, courses] = await Promise.all([
    db.course.count({ where }),
    db.course.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: TAKE,
      select: {
        id: true,
        title: true,
        isPublished: true,
        createdAt: true,
        _count: {
          select: { chapters: true, courseAccess: true, certificates: true },
        },
      },
    }),
  ]);
  const courseIds = courses.map((c) => c.id);
  // With a school filter, only that school's students count toward progress.
  let studentIds: number[] | undefined;
  if (f.schoolIds) {
    const rows = await db.studentSchool.findMany({
      where: { schoolId: { in: f.schoolIds } },
      select: { studentId: true },
    });
    studentIds = [...new Set(rows.map((r) => r.studentId))];
  }
  const prog =
    studentIds?.length === 0
      ? []
      : await enrolmentProgress(db, { courseIds, studentIds });
  const perCourse = new Map<string, typeof prog>();
  for (const p of prog)
    (
      perCourse.get(p.courseId) ??
      perCourse.set(p.courseId, []).get(p.courseId)!
    ).push(p);

  const stage = { 'Not started': 0, 'In progress': 0, Completed: 0 };
  for (const p of prog) {
    if (p.status === 'completed') stage.Completed++;
    else if (p.status === 'not_started') stage['Not started']++;
    else stage['In progress']++;
  }
  const learners = new Set(prog.map((p) => p.studentId)).size;
  const certTotal = courses.reduce((a, c) => a + c._count.certificates, 0);

  return {
    title: 'Course progress report',
    scope: `${plural(total, 'course')}${f.schoolIds ? ', counting students at the chosen schools' : ''}. Shows who is enrolled and how far they have got.`,
    focus: 'Courses',
    stats: [
      { label: 'Courses', value: total },
      { label: 'Students enrolled', value: learners },
      {
        label: 'Completion rate',
        value:
          pct(stage.Completed, prog.length) === null
            ? DASH
            : `${pct(stage.Completed, prog.length)}%`,
      },
      { label: 'Certificates', value: certTotal },
    ],
    charts: prog.length
      ? [
          {
            title: 'Enrolments by stage',
            items: Object.entries(stage).map(([label, value]) => ({
              label,
              value,
            })),
          },
        ]
      : [],
    columns: [
      { label: 'Course' },
      { label: 'Status', kind: 'status' },
      { label: 'Schools', kind: 'num' },
      { label: 'Enrolled', kind: 'num' },
      { label: 'Completed', kind: 'num' },
      { label: 'Avg progress', kind: 'bar' },
      { label: 'Certificates', kind: 'num' },
      { label: 'Created on', kind: 'date' },
    ],
    rows: courses.map((c) => {
      const list = perCourse.get(c.id) ?? [];
      const avg = list.length
        ? list.reduce((a, p) => a + p.progressPercentage, 0) / list.length
        : null;
      return [
        `${c.title ?? DASH}\n${plural(c._count.chapters, 'chapter')}`,
        c.isPublished ? 'Published' : 'Draft',
        String(c._count.courseAccess),
        String(list.length),
        String(list.filter((p) => p.status === 'completed').length),
        avg === null ? DASH : String(Math.round(avg)),
        String(c._count.certificates),
        date(c.createdAt),
      ];
    }),
    footnote: capNote(courses.length, total, 'courses'),
  };
}

export async function buildReportDoc(
  db: DatabaseService,
  type: string,
  f: ReportFilters,
): Promise<ReportDoc> {
  switch (type) {
    case 'schools':
      return schoolsReport(db, f);
    case 'teachers':
      return teachersReport(db, f);
    case 'students':
      return studentsReport(db, f);
    case 'courses':
      return coursesReport(db, f);
    default: // unknown type: a platform snapshot with no table
      return {
        title: 'System report',
        scope: 'A snapshot of the whole platform.',
        stats: [
          {
            label: 'Schools',
            value: await db.school.count({
              where: { isActive: true, deletedAt: null },
            }),
          },
          {
            label: 'Teachers',
            value: await db.user.count({
              where: { role: Role.teacher, isActive: true },
            }),
          },
          {
            label: 'Students',
            value: await db.user.count({
              where: { role: Role.student, isActive: true },
            }),
          },
          {
            label: 'Courses',
            value: await db.course.count({
              where: { isPublished: true, deletedAt: null },
            }),
          },
        ],
        columns: [],
        rows: [],
      };
  }
}

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Download name, e.g. robocoders-school-report-sri-triveni-high-school-champapet-2026-11-11-1021.pdf
 * Product, report, who it covers, then date and time so repeat downloads never collide as "(1)", "(2)".
 */
export async function reportFileName(
  db: DatabaseService,
  type: string,
  title: string,
  f: ReportFilters,
  at: Date,
): Promise<string> {
  let scope = `all-${type}`;
  if (f.schoolIds?.length) {
    if (f.schoolIds.length === 1) {
      const s = await db.school.findFirst({
        where: { id: f.schoolIds[0] },
        select: { name: true },
      });
      scope = slug(s?.name ?? '').slice(0, 50) || '1-school';
    } else scope = `${f.schoolIds.length}-schools`;
  } else if (
    f.teacherIds?.length ||
    f.studentIds?.length ||
    f.courseIds?.length
  ) {
    scope = `selected-${type}`;
  }
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
  return `robocoders-${slug(title)}-${scope}-${stamp}.pdf`;
}
