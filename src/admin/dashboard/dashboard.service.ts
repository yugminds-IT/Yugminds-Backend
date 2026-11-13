import { ExamAnalyticsService } from '../../common/assignment/exam-analytics.service';
import { AssignmentReportService } from '../../common/assignment/assignment-report.service';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import {
  MONITORING_ROLES,
  MonitoringRole,
  MonitoringService,
} from '../../common/monitoring/monitoring.service';
import { MonitoringHistoryService } from '../../common/monitoring/monitoring-history.service';
import { StudentRankingService } from '../../common/assignment/student-ranking.service';
import { AdminTeacherAttendanceService } from '../teacher-attendance/teacher-attendance.service';
import { Role } from '@prisma/client';
import { enrolmentProgress } from '../../common/utils/enrolment-progress';

@Injectable()
export class AdminDashboardService {
  private analyticsCache: { data: unknown; expiresAt: number } | null = null;
  private readonly ANALYTICS_TTL_MS = 2 * 60 * 1000; // 2 minutes

  constructor(
    private readonly db: DatabaseService,
    private readonly monitoring: MonitoringService,
    private readonly monitoringHistory: MonitoringHistoryService,
    private readonly studentRanking: StudentRankingService,
    private readonly teacherAttendance: AdminTeacherAttendanceService,
    private readonly examAnalytics: ExamAnalyticsService,
    private readonly assignmentReport: AssignmentReportService,
  ) {}

  async getStats() {
    const [
      totalSchools,
      totalTeachers,
      totalStudents,
      activeCourses,
      pendingLeaves,
      pendingEmergencyLeaves,
    ] = await Promise.all([
      // Keep school totals aligned with Admin Schools Management,
      // which is tenant-backed and excludes orphan School rows.
      this.db.tenant.count(),
      this.db.user.count({ where: { role: Role.teacher, isActive: true } }),
      this.db.user.count({ where: { role: Role.student, isActive: true } }),
      this.db.course.count({ where: { isPublished: true } }),
      // TeacherLeave.teacherId/schoolId have no enforced DB-level FK (see
      // schema comment history), so hard-deleting a teacher or school can
      // leave orphaned "pending" rows behind — a plain status count would
      // include leave requests for teachers/schools that no longer exist.
      this.db.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT COUNT(*)::bigint as count FROM "TeacherLeave" tl JOIN "User" u ON u.id = tl."teacherId" JOIN "School" sc ON sc.id = tl."schoolId" WHERE tl.status = 'pending'`.then(
        (rows) => Number(rows[0]?.count ?? 0),
      ),
      // Of those, how many are emergency leaves (shown separately on the dashboard).
      this.db.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT COUNT(*)::bigint as count FROM "TeacherLeave" tl JOIN "User" u ON u.id = tl."teacherId" JOIN "School" sc ON sc.id = tl."schoolId" WHERE tl.status = 'pending' AND tl."leaveType" = 'Emergency'`.then(
        (rows) => Number(rows[0]?.count ?? 0),
      ),
    ]);

    return {
      stats: {
        totalSchools,
        totalTeachers,
        totalStudents,
        activeCourses,
        pendingLeaves,
        pendingEmergencyLeaves,
      },
    };
  }

  private monthLabel(date: Date): string {
    const MONTHS = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return `${MONTHS[date.getMonth()]} ${String(date.getFullYear()).slice(-2)}`;
  }

  async getAnalytics(from?: string, to?: string, force = false) {
    // Serve from cache when no date range is specified (default dashboard view)
    const isDefaultRange = !from && !to;
    if (
      !force &&
      isDefaultRange &&
      this.analyticsCache &&
      Date.now() < this.analyticsCache.expiresAt
    ) {
      return this.analyticsCache.data;
    }

    try {
      const now = to ? new Date(`${to}T23:59:59.999Z`) : new Date();
      const [schoolCount, teacherCount, studentCount, activeCourses] =
        await Promise.all([
          // Keep analytics card totals aligned with school listing source of truth.
          this.db.tenant.count(),
          this.db.user.count({
            where: { role: Role.teacher, isActive: true, deletedAt: null },
          }),
          this.db.user.count({
            where: { role: Role.student, isActive: true, deletedAt: null },
          }),
          this.db.course.count({
            where: { isPublished: true, deletedAt: null },
          }),
        ]);

      // ── "as of last month" totals, for the trend % shown next to each
      // Total card. These must be CUMULATIVE totals as of a month ago, not
      // this month's vs last month's new-signup counts (which is a
      // different metric — see monthlyGrowth below) — otherwise the
      // percentage next to "Total Schools: 3" doesn't answer the question
      // the card's own "from last month" label asks.
      const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const [
        schoolsAsOfLastMonth,
        teachersAsOfLastMonth,
        studentsAsOfLastMonth,
        coursesAsOfLastMonth,
      ] = await Promise.all([
        this.db.tenant.count({
          where: { createdAt: { lt: startOfThisMonth } },
        }),
        this.db.user.count({
          where: {
            role: Role.teacher,
            isActive: true,
            deletedAt: null,
            createdAt: { lt: startOfThisMonth },
          },
        }),
        this.db.user.count({
          where: {
            role: Role.student,
            isActive: true,
            deletedAt: null,
            createdAt: { lt: startOfThisMonth },
          },
        }),
        this.db.course.count({
          where: {
            isPublished: true,
            deletedAt: null,
            createdAt: { lt: startOfThisMonth },
          },
        }),
      ]);

      // Month-to-date, same rule as the Teacher attendance tab: no report on a past working day = absent.
      // Reading stored Attendance rows alone misses those days and reads ~100%.
      const monthlyAttendance = (await this.teacherAttendance.monthly())
        .monthlyData;
      const ratedTeachers = monthlyAttendance.filter(
        (m) => m.total_working_days > 0,
      );
      const avgAttendance =
        ratedTeachers.length > 0
          ? Math.round(
              ratedTeachers.reduce(
                (sum, m) => sum + m.attendance_percentage,
                0,
              ) / ratedTeachers.length,
            )
          : 0;

      // How far enrolled students are through their courses: the same live-content calculation the Course
      // progress page uses, over every enrolment in a course that still exists, for students still active.
      const [liveCourses, activeStudents] = await Promise.all([
        this.db.course.findMany({
          where: { deletedAt: null },
          select: { id: true },
        }),
        this.db.user.findMany({
          where: { role: Role.student, isActive: true, deletedAt: null },
          select: { id: true },
        }),
      ]);
      const liveCourseIds = liveCourses.map((c) => c.id);
      const activeStudentIds = activeStudents.map((u) => u.id);
      const enrolments =
        liveCourseIds.length > 0 && activeStudentIds.length > 0
          ? await enrolmentProgress(this.db, {
              courseIds: liveCourseIds,
              studentIds: activeStudentIds,
            })
          : [];
      const completionRate =
        enrolments.length > 0
          ? Math.round(
              enrolments.reduce((sum, e) => sum + e.progressPercentage, 0) /
                enrolments.length,
            )
          : 0;

      // ── Monthly Growth (new additions per month, last 6 months) ─────────────
      // PERFORMANCE FIX (HIGH-03): Use single aggregation query instead of N+1
      const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

      // Aggregate all data in parallel with single queries
      const [schoolsByMonth, teachersByMonth, studentsByMonth, coursesByMonth] =
        await Promise.all([
          this.db.$queryRaw<Array<{ month: string; count: bigint }>>`
        SELECT TO_CHAR(DATE_TRUNC('month', "createdAt"), 'Mon YY') as month, COUNT(*) as count
        FROM "Tenant"
        WHERE "createdAt" >= ${sixMonthsAgo}
        GROUP BY DATE_TRUNC('month', "createdAt")
        ORDER BY DATE_TRUNC('month', "createdAt")
      `,
          this.db.$queryRaw<Array<{ month: string; count: bigint }>>`
        SELECT TO_CHAR(DATE_TRUNC('month', "createdAt"), 'Mon YY') as month, COUNT(*) as count
        FROM "User"
        WHERE role = 'teacher' AND "isActive" = true AND "deletedAt" IS NULL AND "createdAt" >= ${sixMonthsAgo}
        GROUP BY DATE_TRUNC('month', "createdAt")
        ORDER BY DATE_TRUNC('month', "createdAt")
      `,
          this.db.$queryRaw<Array<{ month: string; count: bigint }>>`
        SELECT TO_CHAR(DATE_TRUNC('month', "createdAt"), 'Mon YY') as month, COUNT(*) as count
        FROM "User"
        WHERE role = 'student' AND "isActive" = true AND "deletedAt" IS NULL AND "createdAt" >= ${sixMonthsAgo}
        GROUP BY DATE_TRUNC('month', "createdAt")
        ORDER BY DATE_TRUNC('month', "createdAt")
      `,
          this.db.$queryRaw<Array<{ month: string; count: bigint }>>`
        SELECT TO_CHAR(DATE_TRUNC('month', "createdAt"), 'Mon YY') as month, COUNT(*) as count
        FROM "Course"
        WHERE "isPublished" = true AND "deletedAt" IS NULL AND "createdAt" >= ${sixMonthsAgo}
        GROUP BY DATE_TRUNC('month', "createdAt")
        ORDER BY DATE_TRUNC('month', "createdAt")
      `,
        ]);

      // Create maps for quick lookup
      const schoolsMap = new Map(
        schoolsByMonth.map((r) => [r.month, Number(r.count)]),
      );
      const teachersMap = new Map(
        teachersByMonth.map((r) => [r.month, Number(r.count)]),
      );
      const studentsMap = new Map(
        studentsByMonth.map((r) => [r.month, Number(r.count)]),
      );
      const coursesMap = new Map(
        coursesByMonth.map((r) => [r.month, Number(r.count)]),
      );

      // Build monthly growth array
      const monthlyGrowth: Array<{
        name: string;
        schools: number;
        teachers: number;
        students: number;
        courses: number;
      }> = [];
      for (let i = 5; i >= 0; i--) {
        const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const label = this.monthLabel(monthStart);

        monthlyGrowth.push({
          name: label,
          schools: schoolsMap.get(label) ?? 0,
          teachers: teachersMap.get(label) ?? 0,
          students: studentsMap.get(label) ?? 0,
          courses: coursesMap.get(label) ?? 0,
        });
      }

      // ── School Distribution (by schoolType) ─────────────────────────────────
      // Only count schools that have a matching Tenant (real schools, not orphan School records)
      const tenants = await this.db.tenant.findMany({ select: { id: true } });
      const tenantIds = tenants.map((t) => t.id);
      const schools = await this.db.school.findMany({
        where: { id: { in: tenantIds }, isActive: true },
        select: { schoolType: true },
      });
      const typeMap = new Map<string, number>();
      for (const s of schools) {
        const key = s.schoolType?.trim() || 'Unknown';
        typeMap.set(key, (typeMap.get(key) ?? 0) + 1);
      }
      const COLORS = [
        '#0088FE',
        '#00C49F',
        '#FFBB28',
        '#FF8042',
        '#8884d8',
        '#82ca9d',
      ];
      const totalSchoolsForDist = schools.length || 1;
      const schoolDistribution = Array.from(typeMap.entries()).map(
        ([name, value], idx) => ({
          name,
          value,
          color: COLORS[idx % COLORS.length],
          percentage: Math.round((value / totalSchoolsForDist) * 100),
        }),
      );

      // ── Top Schools (by student count) ───────────────────────────────────────
      let topSchools: Array<{ name: string; engagement: number }> = [];
      try {
        const schoolStudentCounts = await this.db.studentSchool.groupBy({
          by: ['schoolId'],
          where: { isActive: true, studentId: { in: activeStudentIds } },
          _count: { studentId: true },
          orderBy: { _count: { studentId: 'desc' } },
          take: 5,
        });
        if (schoolStudentCounts.length > 0) {
          const schoolIds = schoolStudentCounts.map((r) => r.schoolId);
          // Use tenant name as school name (source of truth)
          const schoolNames = await this.db.tenant.findMany({
            where: { id: { in: schoolIds } },
            select: { id: true, name: true },
          });
          const nameMap = new Map(schoolNames.map((s) => [s.id, s.name]));
          const maxStudents = schoolStudentCounts[0]?._count?.studentId || 1;
          topSchools = schoolStudentCounts.map((r) => ({
            name: nameMap.get(r.schoolId) ?? r.schoolId,
            engagement: Math.round(
              ((r._count?.studentId ?? 0) / maxStudents) * 100,
            ),
          }));
        }
      } catch (e) {
        console.error('[Analytics] topSchools error:', e);
      }

      // ── Popular Courses (by enrollment) ─────────────────────────────────────
      let popularCourses: Array<{ name: string; students: number }> = [];
      try {
        const courseEnrollments = await this.db.studentCourse.groupBy({
          by: ['courseId'],
          where: {
            courseId: { in: liveCourseIds },
            studentId: { in: activeStudentIds },
          },
          _count: { studentId: true },
          orderBy: { _count: { studentId: 'desc' } },
          take: 5,
        });
        if (courseEnrollments.length > 0) {
          const courseIds = courseEnrollments.map((r) => r.courseId);
          const courseNames = await this.db.course.findMany({
            where: { id: { in: courseIds } },
            select: { id: true, title: true },
          });
          const courseNameMap = new Map(
            courseNames.map((c) => [c.id, c.title]),
          );
          popularCourses = courseEnrollments.map((r) => ({
            name: courseNameMap.get(r.courseId) ?? r.courseId,
            students: r._count?.studentId ?? 0,
          }));
        }
      } catch (e) {
        console.error('[Analytics] popularCourses error:', e);
      }

      // ── Teacher Performance (based on attendance) ────────────────────────────
      let teacherPerformance = {
        excellent: 0,
        good: 0,
        average: 0,
        needsImprovement: 0,
        /** active teachers with no attendance record in the period: no data, not poor attendance */
        noRecords: 0,
      };
      try {
        const allTeachers = await this.db.user.findMany({
          where: { role: Role.teacher, isActive: true, deletedAt: null },
          select: { id: true },
        });

        if (allTeachers.length > 0) {
          const rateByTeacher = new Map(
            monthlyAttendance.map((m) => [
              Number(m.teacher_id),
              m.total_working_days > 0 ? m.attendance_percentage : null,
            ]),
          );

          let excellent = 0,
            good = 0,
            average = 0,
            needsImprovement = 0,
            noRecords = 0;
          for (const t of allTeachers) {
            const rate = rateByTeacher.get(t.id);
            if (rate == null) {
              noRecords++;
              continue;
            }
            if (rate >= 90) excellent++;
            else if (rate >= 75) good++;
            else if (rate >= 50) average++;
            else needsImprovement++;
          }
          teacherPerformance = {
            excellent,
            good,
            average,
            needsImprovement,
            noRecords,
          };
        }
      } catch (e) {
        console.error('[Analytics] teacherPerformance error:', e);
      }

      // ── Course Engagement (last 6 months) ────────────────────────────────────
      // PERFORMANCE FIX (HIGH-03): Use aggregation queries instead of N+1
      // Enrolments per month by enrolment date. A completion is an enrolment whose live progress says
      // "completed", counted in the month of its last activity. (StudentCourse.completedAt is never
      // written anywhere, so it cannot be used.)
      const enrollmentsMap = new Map<string, number>();
      const completionsMap = new Map<string, number>();
      const bump = (m: Map<string, number>, d: Date) =>
        m.set(this.monthLabel(d), (m.get(this.monthLabel(d)) ?? 0) + 1);
      for (const e of enrolments) {
        if (e.enrolledAt >= sixMonthsAgo) bump(enrollmentsMap, e.enrolledAt);
        if (
          e.status === 'completed' &&
          e.lastAccessed &&
          e.lastAccessed >= sixMonthsAgo
        )
          bump(completionsMap, e.lastAccessed);
      }

      const courseEngagement: Array<{
        name: string;
        engagement: number;
        completion: number;
      }> = [];
      for (let i = 5; i >= 0; i--) {
        const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const label = this.monthLabel(monthStart);

        const enrolled = enrollmentsMap.get(label) ?? 0;
        const completed = completionsMap.get(label) ?? 0;
        const engagement =
          enrolled > 0
            ? Math.min(
                100,
                Math.round((enrolled / Math.max(studentCount, 1)) * 100),
              )
            : 0;
        const completion =
          enrolled > 0
            ? Math.min(
                100,
                Math.round((completed / Math.max(enrolled, 1)) * 100),
              )
            : 0;
        courseEngagement.push({ name: label, engagement, completion });
      }

      // % change of the CUMULATIVE total vs a month ago — matches what the
      // "Total X" cards' "from last month" label actually claims. Returns
      // null (not a flat 100) when there's no prior-month baseline to
      // compare against, since "0 -> 1" and "0 -> 1000" are both
      // mathematically undefined growth, not interchangeably "100%".
      const calcChange = (curr: number, prev: number): number | null =>
        prev === 0
          ? curr > 0
            ? null
            : 0
          : Math.round(((curr - prev) / prev) * 100);

      // Derive real system health from monitoring success rate (last N requests)
      const monitorSnapshot = this.monitoring.getSnapshot();
      const { totalRequests, successfulRequests } = monitorSnapshot.metrics;
      const systemHealth =
        totalRequests > 0
          ? Math.round((successfulRequests / totalRequests) * 100)
          : 100;

      const result = {
        generatedAt: new Date().toISOString(),
        analytics: {
          totalSchools: schoolCount,
          totalTeachers: teacherCount,
          totalStudents: studentCount,
          activeCourses,
          systemHealth,
          avgAttendance,
          completionRate,
        },
        trends: {
          schoolsChange: calcChange(schoolCount, schoolsAsOfLastMonth),
          teachersChange: calcChange(teacherCount, teachersAsOfLastMonth),
          studentsChange: calcChange(studentCount, studentsAsOfLastMonth),
          coursesChange: calcChange(activeCourses, coursesAsOfLastMonth),
        },
        monthlyGrowth,
        schoolDistribution,
        topSchools,
        popularCourses,
        teacherPerformance,
        courseEngagement,
      };

      if (isDefaultRange) {
        this.analyticsCache = {
          data: result,
          expiresAt: Date.now() + this.ANALYTICS_TTL_MS,
        };
      }
      return result;
    } catch (err) {
      console.error('[AdminDashboardService] getAnalytics failed:', err);
      return {
        generatedAt: new Date().toISOString(),
        analytics: {
          totalSchools: 0,
          totalTeachers: 0,
          totalStudents: 0,
          activeCourses: 0,
          systemHealth: 100,
          avgAttendance: 0,
          completionRate: 0,
        },
        trends: {
          schoolsChange: 0,
          teachersChange: 0,
          studentsChange: 0,
          coursesChange: 0,
        },
        monthlyGrowth: [],
        schoolDistribution: [],
        topSchools: [],
        popularCourses: [],
        teacherPerformance: {
          excellent: 0,
          good: 0,
          average: 0,
          needsImprovement: 0,
          noRecords: 0,
        },
        courseEngagement: [],
      };
    }
  }

  refreshViews() {
    return { success: true, refreshed_at: new Date().toISOString() };
  }

  /** Live traffic since the server started, optionally for one role and/or one school. */
  async getMonitoring(role?: string, schoolId?: string) {
    const r = MONITORING_ROLES.includes(role as MonitoringRole)
      ? (role as MonitoringRole)
      : undefined;
    const snap = this.monitoring.getSnapshot({
      role: r,
      schoolId: schoolId || undefined,
    });
    const ids = [
      ...new Set(
        snap.recent.map((x) => x.schoolId).filter((x): x is string => !!x),
      ),
    ];
    const names = ids.length
      ? new Map(
          (
            await this.db.school.findMany({
              where: { id: { in: ids } },
              select: { id: true, name: true },
            })
          ).map((s) => [s.id, s.name]),
        )
      : new Map<string, string>();
    return {
      ...snap,
      recent: snap.recent.map((x) => ({
        ...x,
        schoolName: x.schoolId ? (names.get(x.schoolId) ?? null) : null,
      })),
    };
  }

  /** Hourly totals kept in the database (survive restarts, deleted after the retention period). */
  getMonitoringHistory(hours?: string, role?: string, schoolId?: string) {
    return this.monitoringHistory.history({
      hours: hours ? Number(hours) : undefined,
      role: MONITORING_ROLES.includes(role as MonitoringRole)
        ? (role as MonitoringRole)
        : undefined,
      schoolId: schoolId || undefined,
    });
  }

  getMaterializedViewStats() {
    // No DB-level matview introspection in Prisma here; return empty list as actual state.
    return { views: [], checked_at: new Date().toISOString() };
  }

  /** All schools by default; `schoolId` narrows to one. The school list is always the full set (for the filter). */
  getAssignmentReport(assignmentId: string) {
    return this.assignmentReport.get(assignmentId);
  }

  async getExamAnalytics(schoolId?: string) {
    const schools = await this.db.school.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
    const ids = schoolId ? schools.filter((x) => x.id === schoolId).map((x) => x.id) : schools.map((x) => x.id);
    const analytics = await this.examAnalytics.compute(ids);
    return { analytics: { ...analytics, schools } };
  }

  async getAssignmentAnalytics() {
    const assignments = await this.db.assignment.findMany({
      // Matches school-admin's equivalent counts (stats.service.ts) — an
      // unpublished draft assignment isn't visible to any student and
      // shouldn't count toward "Assignments" or a school's assignments_created.
      // Exams are reported by getExamAnalytics, not in course/daily totals.
      where: { isPublished: true, assignmentType: { not: 'EXAM' } },
      select: {
        id: true,
        title: true,
        schoolId: true,
        courseId: true,
        chapterId: true,
        retakeEnabled: true,
        retakeScoringRule: true,
        assignmentType: true,
      },
    });
    if (!assignments.length) {
      return {
        analytics: {
          school_rankings: [],
          school_details: [],
          platform_completion_rate: 0,
          retake_usage: 0,
        },
      };
    }
    const assignmentIds = assignments.map((a) => a.id);
    const submissions = await this.db.assignmentSubmission.findMany({
      where: { assignmentId: { in: assignmentIds } },
      select: {
        assignmentId: true,
        studentId: true,
        score: true,
        maxScore: true,
        attemptNumber: true,
      },
    });

    // Assignments are frequently course-level (schoolId = null), so we attribute
    // every metric to the SUBMITTING STUDENT'S school instead of the assignment's.
    const submittingStudentIds = [
      ...new Set(submissions.map((s) => s.studentId)),
    ];
    // COURSE-type assignments almost always link via `chapterId` — their own
    // `courseId` column is legacy/rarely populated (confirmed: real course
    // assignments in production have courseId=null and only chapterId set,
    // resolved through Chapter.courseId below). Resolving only off the
    // direct courseId column would treat every real course assignment as
    // "not linked to any school."
    const chapterIds = [
      ...new Set(
        assignments.map((a) => a.chapterId).filter((c): c is string => !!c),
      ),
    ];
    const chapters = chapterIds.length
      ? await this.db.chapter.findMany({
          where: { id: { in: chapterIds } },
          select: { id: true, courseId: true },
        })
      : [];
    const courseIdByChapter = new Map(chapters.map((c) => [c.id, c.courseId]));
    const courseIdOf = (a: {
      courseId: string | null;
      chapterId: string | null;
    }) =>
      a.courseId ??
      (a.chapterId ? (courseIdByChapter.get(a.chapterId) ?? null) : null);

    const courseIds = [
      ...new Set(
        assignments.map((a) => courseIdOf(a)).filter((c): c is string => !!c),
      ),
    ];
    const [schools, enrollmentCounts, studentSchoolRows, courseAccessRows] =
      await Promise.all([
        // All schools — the leaderboard shows the full platform, not just ones with submissions.
        this.db.school.findMany({ select: { id: true, name: true } }),
        this.db.studentSchool.groupBy({
          by: ['schoolId'],
          where: { isActive: true },
          _count: { studentId: true },
        }),
        submittingStudentIds.length
          ? this.db.studentSchool.findMany({
              where: {
                studentId: { in: submittingStudentIds },
                isActive: true,
              },
              select: { studentId: true, schoolId: true },
            })
          : Promise.resolve([]),
        // Which courses are actually published/granted to which schools —
        // needed to count only assignments a school's students can actually
        // see, instead of stamping the platform-wide total on every row.
        courseIds.length
          ? this.db.courseAccess.findMany({
              where: { courseId: { in: courseIds } },
              select: { courseId: true, schoolId: true },
            })
          : Promise.resolve([]),
      ]);
    // school -> set of courseIds granted to it
    const coursesBySchool = new Map<string, Set<string>>();
    for (const ca of courseAccessRows) {
      if (!coursesBySchool.has(ca.schoolId))
        coursesBySchool.set(ca.schoolId, new Set());
      coursesBySchool.get(ca.schoolId)!.add(ca.courseId);
    }
    // Real per-school assignment relevance: a DAILY assignment counts for
    // the school it's scoped to (Assignment.schoolId); a COURSE assignment
    // counts for every school that course is actually granted to. Assignments
    // with neither a schoolId nor a granted course aren't relevant to any
    // specific school and are correctly excluded from every school's count.
    const assignmentsForSchool = (schoolId: string) =>
      assignments.filter((a) => {
        if (a.schoolId) return a.schoolId === schoolId;
        const cid = courseIdOf(a);
        return cid ? (coursesBySchool.get(schoolId)?.has(cid) ?? false) : false;
      }).length;
    const enrolledBySchool = new Map(
      enrollmentCounts.map((e) => [e.schoolId, e._count.studentId]),
    );
    // student → their (first active) school
    const schoolByStudent = new Map<number, string>();
    for (const r of studentSchoolRows) {
      if (!schoolByStudent.has(r.studentId)) {
        schoolByStudent.set(r.studentId, r.schoolId);
      }
    }

    // Pick best/latest attempt per (student, assignment) to avoid
    // double-counting retakes — honoring each assignment's own
    // retakeScoringRule ("highest" vs "latest"), same rule the canonical
    // StudentRankingService applies. The previous "higher score OR higher
    // attempt number" logic ignored the rule entirely, so a 'latest'-rule
    // assignment where a retake scored lower than an earlier attempt could
    // still have its higher-scoring earlier attempt win here — disagreeing
    // with what the canonical service (and every other dashboard) reports
    // for the identical submission.
    const retakeRuleByAssignment = new Map(
      assignments.map((a) => [
        a.id,
        String(a.retakeScoringRule ?? 'latest').toLowerCase(),
      ]),
    );
    const submissionsByKeyInOrder = [...submissions].sort(
      (a, b) => a.attemptNumber - b.attemptNumber,
    );
    const bestByKey = new Map<string, (typeof submissions)[0]>();
    for (const s of submissionsByKeyInOrder) {
      const key = `${s.studentId}:${s.assignmentId}`;
      const rule = retakeRuleByAssignment.get(s.assignmentId) ?? 'latest';
      const existing = bestByKey.get(key);
      if (!existing) {
        bestByKey.set(key, s);
      } else if (rule === 'highest') {
        if (Number(s.score ?? 0) > Number(existing.score ?? 0)) {
          bestByKey.set(key, s);
        }
      } else {
        // latest: ascending attempt order → last one seen wins.
        bestByKey.set(key, s);
      }
    }
    const bestSubmissions = [...bestByKey.values()];

    // Aggregate by the student's school
    const agg = new Map<
      string,
      {
        attempts: number;
        total: number;
        max: number;
        retakes: number;
        submitters: Set<number>;
      }
    >();
    const ensureAgg = (sid: string) => {
      let cur = agg.get(sid);
      if (!cur) {
        cur = {
          attempts: 0,
          total: 0,
          max: 0,
          retakes: 0,
          submitters: new Set(),
        };
        agg.set(sid, cur);
      }
      return cur;
    };
    for (const s of bestSubmissions) {
      const sid = schoolByStudent.get(s.studentId);
      if (!sid) continue;
      const cur = ensureAgg(sid);
      cur.attempts += 1;
      cur.total += Number(s.score ?? 0);
      cur.max += Number(s.maxScore ?? 0);
      cur.submitters.add(s.studentId);
    }
    // Count retakes from all submissions (not best-only)
    for (const s of submissions) {
      if (s.attemptNumber > 1) {
        const sid = schoolByStudent.get(s.studentId);
        if (sid) ensureAgg(sid).retakes += 1;
      }
    }

    // Build a row for every school so the leaderboard reflects the whole platform.
    const rows = schools
      .map((school) => {
        const a = agg.get(school.id);
        const enrolled = enrolledBySchool.get(school.id) ?? 0;
        const attempts = a?.attempts ?? 0;
        const retakes = a?.retakes ?? 0;
        const totalAttempts = attempts + retakes;
        const uniqueSubmitters = a?.submitters.size ?? 0;
        const max = a?.max ?? 0;
        const total = a?.total ?? 0;
        return {
          school_id: school.id,
          school_name: school.name,
          // Real count of assignments actually relevant to THIS school (its
          // own DAILY assignments + COURSE assignments its students have
          // access to) — previously this stamped the platform-wide total
          // assignment count on every single school's row.
          assignments_created: assignmentsForSchool(school.id),
          attempts_count: totalAttempts,
          average_score_percentage:
            max > 0 ? Number(((total / max) * 100).toFixed(2)) : 0,
          // completion_rate = unique students who submitted / enrolled (capped at 100%)
          completion_rate:
            enrolled > 0
              ? Math.min(
                  100,
                  Number(((uniqueSubmitters / enrolled) * 100).toFixed(2)),
                )
              : 0,
          retake_usage_percentage:
            totalAttempts > 0
              ? Number(((retakes / totalAttempts) * 100).toFixed(2))
              : 0,
        };
      })
      .sort(
        (a, b) =>
          b.average_score_percentage - a.average_score_percentage ||
          b.completion_rate - a.completion_rate,
      );

    const totalEnrolled = [...enrolledBySchool.values()].reduce(
      (a, b) => a + b,
      0,
    );
    const totalUniqueSubmitters = submittingStudentIds.length;
    const totalAssignments = assignments.length;
    const totalRetakeCount = rows.reduce(
      (sum, row) =>
        sum + (row.attempts_count * row.retake_usage_percentage) / 100,
      0,
    );
    const totalAllAttempts = rows.reduce(
      (sum, row) => sum + row.attempts_count,
      0,
    );
    // Average score across schools that actually have activity (avoid dilution by 0s)
    const schoolsWithActivity = rows.filter((r) => r.attempts_count > 0);

    // Top 50 students platform-wide — canonical system ranking from the shared
    // service (graded-only, retake-rule aware) so it matches what students see.
    const topStudents = (
      await this.studentRanking.getSystemLeaderboard(50)
    ).map((r) => ({
      student_id: r.studentId,
      student_name: r.studentName,
      school_name: r.schoolName,
      grade: r.grade,
      section: r.section,
      course_assignment_score: r.courseScore,
      daily_assignment_score: r.dailyScore,
      overall_score: r.overallScore,
      badge: r.badge,
      rank: r.system_rank,
      system_rank: r.system_rank,
    }));

    return {
      analytics: {
        school_rankings: rows.map((r, idx) => ({ ...r, rank: idx + 1 })),
        school_details: rows,
        // Platform completion = unique students who submitted / total enrolled (capped 100%)
        platform_completion_rate:
          totalEnrolled > 0
            ? Math.min(
                100,
                Number(
                  ((totalUniqueSubmitters / totalEnrolled) * 100).toFixed(2),
                ),
              )
            : 0,
        retake_usage:
          totalAllAttempts > 0
            ? Number(((totalRetakeCount / totalAllAttempts) * 100).toFixed(2))
            : 0,
        top_students_platform: topStudents,
        summary: {
          total_schools: schools.length,
          total_assignments: totalAssignments,
          total_attempts: totalAllAttempts,
          platform_avg_score:
            schoolsWithActivity.length > 0
              ? Number(
                  (
                    schoolsWithActivity.reduce(
                      (s, r) => s + r.average_score_percentage,
                      0,
                    ) / schoolsWithActivity.length
                  ).toFixed(2),
                )
              : 0,
        },
      },
    };
  }
}
