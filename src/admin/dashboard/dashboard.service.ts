import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { MonitoringService } from '../../common/monitoring/monitoring.service';
import { Role } from '@prisma/client';

@Injectable()
export class AdminDashboardService {
  constructor(
    private readonly db: DatabaseService,
    private readonly monitoring: MonitoringService,
  ) {}

  async getStats() {
    const [
      totalSchools,
      totalTeachers,
      totalStudents,
      activeCourses,
      pendingLeaves,
    ] = await Promise.all([
      // Keep school totals aligned with Admin Schools Management,
      // which is tenant-backed and excludes orphan School rows.
      this.db.tenant.count(),
      this.db.user.count({ where: { role: Role.teacher, isActive: true } }),
      this.db.user.count({ where: { role: Role.student, isActive: true } }),
      this.db.course.count({ where: { isPublished: true } }),
      this.db.teacherLeave.count({ where: { status: 'pending' } }),
    ]);

    return {
      stats: {
        totalSchools,
        totalTeachers,
        totalStudents,
        activeCourses,
        pendingLeaves,
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

  async getAnalytics() {
    try {
      const now = new Date();
      const last30Days = new Date(now);
      last30Days.setUTCDate(last30Days.getUTCDate() - 30);

      const [schoolCount, teacherCount, studentCount, activeCourses] =
        await Promise.all([
          // Keep analytics card totals aligned with school listing source of truth.
          this.db.tenant.count(),
          this.db.user.count({ where: { role: Role.teacher, isActive: true } }),
          this.db.user.count({ where: { role: Role.student, isActive: true } }),
          this.db.course.count({ where: { isPublished: true } }),
        ]);

      const attendance30 = await this.db.attendance.findMany({
        where: { date: { gte: last30Days } },
        select: { status: true },
      });
      const presentCount = attendance30.filter(
        (a) => String(a.status).toLowerCase() === 'present',
      ).length;
      const avgAttendance =
        attendance30.length > 0
          ? Math.round((presentCount / attendance30.length) * 100)
          : 0;

      const progressRows = await this.db.courseProgress.findMany({
        where: { updatedAt: { gte: last30Days } },
        select: { progress: true },
        take: 5000,
      });
      const avgProgress =
        progressRows.length > 0
          ? progressRows.reduce(
              (sum, r) => sum + (Number(r.progress) || 0),
              0,
            ) / progressRows.length
          : 0;
      // progress is stored as 0–100 in DB; no need to multiply again
      const completionRate = Math.round(avgProgress);

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
        WHERE role = 'teacher' AND "isActive" = true AND "createdAt" >= ${sixMonthsAgo}
        GROUP BY DATE_TRUNC('month', "createdAt")
        ORDER BY DATE_TRUNC('month', "createdAt")
      `,
          this.db.$queryRaw<Array<{ month: string; count: bigint }>>`
        SELECT TO_CHAR(DATE_TRUNC('month', "createdAt"), 'Mon YY') as month, COUNT(*) as count
        FROM "User"
        WHERE role = 'student' AND "isActive" = true AND "createdAt" >= ${sixMonthsAgo}
        GROUP BY DATE_TRUNC('month', "createdAt")
        ORDER BY DATE_TRUNC('month', "createdAt")
      `,
          this.db.$queryRaw<Array<{ month: string; count: bigint }>>`
        SELECT TO_CHAR(DATE_TRUNC('month', "createdAt"), 'Mon YY') as month, COUNT(*) as count
        FROM "Course"
        WHERE "isPublished" = true AND "createdAt" >= ${sixMonthsAgo}
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
      };
      try {
        const allTeachers = await this.db.user.findMany({
          where: { role: Role.teacher, isActive: true },
          select: { id: true },
        });

        if (allTeachers.length > 0) {
          const teacherIds = allTeachers.map((t) => t.id);

          // Count total attendance records per teacher
          const teacherAttendanceRaw = await this.db.attendance.findMany({
            where: { teacherId: { in: teacherIds }, date: { gte: last30Days } },
            select: { teacherId: true, status: true },
          });

          const totalMap = new Map<number, number>();
          const presentMap = new Map<number, number>();
          for (const rec of teacherAttendanceRaw) {
            totalMap.set(rec.teacherId, (totalMap.get(rec.teacherId) ?? 0) + 1);
            if (String(rec.status).toLowerCase() === 'present') {
              presentMap.set(
                rec.teacherId,
                (presentMap.get(rec.teacherId) ?? 0) + 1,
              );
            }
          }

          let excellent = 0,
            good = 0,
            average = 0,
            needsImprovement = 0;
          for (const t of allTeachers) {
            const total = totalMap.get(t.id) ?? 0;
            const present = presentMap.get(t.id) ?? 0;
            const rate = total > 0 ? (present / total) * 100 : 0;
            if (rate >= 90) excellent++;
            else if (rate >= 75) good++;
            else if (rate >= 50) average++;
            else needsImprovement++;
          }
          teacherPerformance = { excellent, good, average, needsImprovement };
        }
      } catch (e) {
        console.error('[Analytics] teacherPerformance error:', e);
      }

      // ── Course Engagement (last 6 months) ────────────────────────────────────
      // PERFORMANCE FIX (HIGH-03): Use aggregation queries instead of N+1
      const [enrollmentsByMonth, completionsByMonth] = await Promise.all([
        this.db.$queryRaw<Array<{ month: string; count: bigint }>>`
        SELECT TO_CHAR(DATE_TRUNC('month', "enrolledAt"), 'Mon YY') as month, COUNT(*) as count
        FROM "StudentCourse"
        WHERE "enrolledAt" >= ${sixMonthsAgo}
        GROUP BY DATE_TRUNC('month', "enrolledAt")
        ORDER BY DATE_TRUNC('month', "enrolledAt")
      `,
        this.db.$queryRaw<Array<{ month: string; count: bigint }>>`
        SELECT TO_CHAR(DATE_TRUNC('month', "updatedAt"), 'Mon YY') as month, COUNT(*) as count
        FROM "CourseProgress"
        WHERE progress >= 99 AND "updatedAt" >= ${sixMonthsAgo}
        GROUP BY DATE_TRUNC('month', "updatedAt")
        ORDER BY DATE_TRUNC('month', "updatedAt")
      `,
      ]);

      const enrollmentsMap = new Map(
        enrollmentsByMonth.map((r) => [r.month, Number(r.count)]),
      );
      const completionsMap = new Map(
        completionsByMonth.map((r) => [r.month, Number(r.count)]),
      );

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

      // Calculate real month-over-month % changes from monthlyGrowth
      const calcChange = (curr: number, prev: number) =>
        prev === 0
          ? curr > 0
            ? 100
            : 0
          : Math.round(((curr - prev) / prev) * 100);
      const cur = monthlyGrowth[monthlyGrowth.length - 1];
      const prv = monthlyGrowth[monthlyGrowth.length - 2];

      // Derive real system health from monitoring success rate (last N requests)
      const monitorSnapshot = this.monitoring.getSnapshot();
      const { totalRequests, successfulRequests } = monitorSnapshot.metrics;
      const systemHealth =
        totalRequests > 0
          ? Math.round((successfulRequests / totalRequests) * 100)
          : 100;

      return {
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
          schoolsChange: calcChange(cur?.schools ?? 0, prv?.schools ?? 0),
          teachersChange: calcChange(cur?.teachers ?? 0, prv?.teachers ?? 0),
          studentsChange: calcChange(cur?.students ?? 0, prv?.students ?? 0),
          coursesChange: calcChange(cur?.courses ?? 0, prv?.courses ?? 0),
        },
        monthlyGrowth,
        schoolDistribution,
        topSchools,
        popularCourses,
        teacherPerformance,
        courseEngagement,
      };
    } catch (err) {
      console.error('[AdminDashboardService] getAnalytics failed:', err);
      return {
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
        },
        courseEngagement: [],
      };
    }
  }

  async refreshViews() {
    return { success: true, refreshed_at: new Date().toISOString() };
  }

  async getMonitoring() {
    return this.monitoring.getSnapshot();
  }

  async getMaterializedViewStats() {
    // No DB-level matview introspection in Prisma here; return empty list as actual state.
    return { views: [], checked_at: new Date().toISOString() };
  }

  async getAssignmentAnalytics() {
    const assignments = await this.db.assignment.findMany({
      select: {
        id: true,
        title: true,
        schoolId: true,
        retakeEnabled: true,
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

    const schoolIds = [
      ...new Set(
        assignments.map((a) => a.schoolId).filter(Boolean) as string[],
      ),
    ];
    const [schools, enrollmentCounts] = await Promise.all([
      this.db.school.findMany({
        where: { id: { in: schoolIds } },
        select: { id: true, name: true },
      }),
      this.db.studentSchool.groupBy({
        by: ['schoolId'],
        where: { schoolId: { in: schoolIds }, isActive: true },
        _count: { studentId: true },
      }),
    ]);
    const schoolName = new Map(schools.map((s) => [s.id, s.name]));
    const enrolledBySchool = new Map(
      enrollmentCounts.map((e) => [e.schoolId, e._count.studentId]),
    );

    // Pick best/latest attempt per (student, assignment) to avoid double-counting retakes
    const bestByKey = new Map<string, (typeof submissions)[0]>();
    for (const s of submissions) {
      const key = `${s.studentId}:${s.assignmentId}`;
      const existing = bestByKey.get(key);
      if (
        !existing ||
        Number(s.score ?? 0) > Number(existing.score ?? 0) ||
        s.attemptNumber > existing.attemptNumber
      ) {
        bestByKey.set(key, s);
      }
    }
    const bestSubmissions = [...bestByKey.values()];

    // Count unique submitting students per school (for completion rate)
    const submittingBySchool = new Map<string, Set<number>>();
    for (const s of submissions) {
      const asgn = assignments.find((a) => a.id === s.assignmentId);
      const sId = asgn?.schoolId ?? 'unknown';
      const set = submittingBySchool.get(sId) ?? new Set<number>();
      set.add(s.studentId);
      submittingBySchool.set(sId, set);
    }

    const agg = new Map<
      string,
      {
        school_id: string;
        assignments: number;
        attempts: number;
        total: number;
        max: number;
        retakes: number;
      }
    >();
    for (const a of assignments) {
      const sId = a.schoolId ?? 'unknown';
      const current = agg.get(sId) ?? {
        school_id: sId,
        assignments: 0,
        attempts: 0,
        total: 0,
        max: 0,
        retakes: 0,
      };
      current.assignments += 1;
      agg.set(sId, current);
    }
    for (const s of bestSubmissions) {
      const asgn = assignments.find((a) => a.id === s.assignmentId);
      const sId = asgn?.schoolId ?? 'unknown';
      const current = agg.get(sId);
      if (!current) continue;
      current.attempts += 1;
      current.total += Number(s.score ?? 0);
      current.max += Number(s.maxScore ?? 0);
    }
    // Count retakes from all submissions (not best-only)
    for (const s of submissions) {
      if (s.attemptNumber > 1) {
        const asgn = assignments.find((a) => a.id === s.assignmentId);
        const sId = asgn?.schoolId ?? 'unknown';
        const current = agg.get(sId);
        if (current) current.retakes += 1;
      }
    }

    const rows = [...agg.values()]
      .map((r) => {
        const enrolled = enrolledBySchool.get(r.school_id) ?? 0;
        const uniqueSubmitters = submittingBySchool.get(r.school_id)?.size ?? 0;
        const totalAttempts = r.attempts + r.retakes;
        return {
          school_id: r.school_id,
          school_name: schoolName.get(r.school_id) ?? r.school_id,
          assignments_created: r.assignments,
          attempts_count: totalAttempts,
          average_score_percentage:
            r.max > 0 ? Number(((r.total / r.max) * 100).toFixed(2)) : 0,
          // completion_rate = unique students who submitted / enrolled students (capped at 100%)
          completion_rate:
            enrolled > 0
              ? Math.min(
                  100,
                  Number(((uniqueSubmitters / enrolled) * 100).toFixed(2)),
                )
              : 0,
          retake_usage_percentage:
            totalAttempts > 0
              ? Number(((r.retakes / totalAttempts) * 100).toFixed(2))
              : 0,
        };
      })
      .sort((a, b) => b.average_score_percentage - a.average_score_percentage);

    const totalEnrolled = [...enrolledBySchool.values()].reduce(
      (a, b) => a + b,
      0,
    );
    const totalUniqueSubmitters = new Set(submissions.map((s) => s.studentId))
      .size;
    const totalAssignments = rows.reduce(
      (sum, row) => sum + row.assignments_created,
      0,
    );
    const totalRetakeCount = rows.reduce(
      (sum, row) =>
        sum + (row.attempts_count * row.retake_usage_percentage) / 100,
      0,
    );
    const totalAllAttempts = rows.reduce(
      (sum, row) => sum + row.attempts_count,
      0,
    );

    // Top 50 students platform-wide (using best-attempt per assignment)
    const allStudents = await this.db.user.findMany({
      where: { role: Role.student, isActive: true },
      select: {
        id: true,
        email: true,
        profile: { select: { fullName: true } },
        studentSchools: { select: { schoolId: true, grade: true } },
      },
    });
    const studentScoreMap = new Map<
      number,
      {
        courseTotal: number;
        courseMax: number;
        dailyTotal: number;
        dailyMax: number;
      }
    >();
    for (const s of bestSubmissions) {
      const asgn = assignments.find((a) => a.id === s.assignmentId);
      const cur = studentScoreMap.get(s.studentId) ?? {
        courseTotal: 0,
        courseMax: 0,
        dailyTotal: 0,
        dailyMax: 0,
      };
      if ((asgn as any)?.assignmentType === 'COURSE') {
        cur.courseTotal += Number(s.score ?? 0);
        cur.courseMax += Number(s.maxScore ?? 0);
      } else {
        cur.dailyTotal += Number(s.score ?? 0);
        cur.dailyMax += Number(s.maxScore ?? 0);
      }
      studentScoreMap.set(s.studentId, cur);
    }
    const topStudents = allStudents
      .map((u) => {
        const b = studentScoreMap.get(u.id);
        if (!b) return null;
        const courseScore =
          b.courseMax > 0 ? (b.courseTotal / b.courseMax) * 100 : 0;
        const dailyScore =
          b.dailyMax > 0 ? (b.dailyTotal / b.dailyMax) * 100 : 0;
        const overall = courseScore * 0.6 + dailyScore * 0.4;
        const primarySchool = (u.studentSchools ?? [])[0];
        return {
          student_id: u.id,
          student_name: u.profile?.fullName ?? u.email ?? `Student ${u.id}`,
          school_name: schoolName.get(primarySchool?.schoolId ?? '') ?? '',
          grade: primarySchool?.grade ?? '',
          course_assignment_score: Number(courseScore.toFixed(2)),
          daily_assignment_score: Number(dailyScore.toFixed(2)),
          overall_score: Number(overall.toFixed(2)),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.overall_score - a.overall_score)
      .slice(0, 50)
      .map((r, idx) => ({ ...r, rank: idx + 1 }));

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
            rows.length > 0
              ? Number(
                  (
                    rows.reduce((s, r) => s + r.average_score_percentage, 0) /
                    rows.length
                  ).toFixed(2),
                )
              : 0,
        },
      },
    };
  }
}
