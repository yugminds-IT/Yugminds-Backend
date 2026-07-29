import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

export interface ListTeacherReportsOptions {
  schoolId?: string;
  teacherId?: string;
  grade?: string;
  date?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: string;
}

@Injectable()
export class AdminTeacherReportsService {
  constructor(private readonly db: DatabaseService) {}

  async list(opts: ListTeacherReportsOptions) {
    const { schoolId, teacherId: teacherIdParam, grade, date, from, to, search, limit } = opts;

    const where: {
      schoolId?: string;
      teacherId?: number;
      grade?: string;
      reportDate?: { gte?: Date; lte?: Date };
    } = {};

    if (schoolId) {
      where.schoolId = schoolId;
    }

    if (teacherIdParam) {
      const parsedTeacherId = parseInt(teacherIdParam, 10);
      if (!Number.isNaN(parsedTeacherId)) {
        where.teacherId = parsedTeacherId;
      }
    }

    if (grade) {
      where.grade = grade;
    }

    if (date) {
      const start = new Date(`${date}T00:00:00.000Z`);
      const end = new Date(`${date}T23:59:59.999Z`);
      where.reportDate = { gte: start, lte: end };
    } else if (from || to) {
      where.reportDate = {};
      if (from) where.reportDate.gte = new Date(`${from}T00:00:00.000Z`);
      if (to) where.reportDate.lte = new Date(`${to}T23:59:59.999Z`);
    }

    const take = limit
      ? Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500)
      : 100;

    const reports = await this.db.teacherReport.findMany({
      where,
      orderBy: { reportDate: 'desc' },
      take,
    });

    const teacherIds = Array.from(new Set(reports.map((r) => r.teacherId)));
    const schoolIds = Array.from(new Set(reports.map((r) => r.schoolId)));

    const [teachers, schools] = await Promise.all([
      teacherIds.length
        ? this.db.user.findMany({
            where: { id: { in: teacherIds } },
            include: { profile: true },
          })
        : Promise.resolve([] as any[]),
      schoolIds.length
        ? this.db.school.findMany({
            where: { id: { in: schoolIds } },
            select: { id: true, name: true, schoolCode: true },
          })
        : Promise.resolve([] as any[]),
    ]);

    const teacherMap = new Map<
      number,
      { id: number; full_name: string; email: string }
    >();
    for (const t of teachers) {
      teacherMap.set(t.id, {
        id: t.id,
        full_name: t.profile?.fullName ?? t.email ?? '',
        email: t.email ?? '',
      });
    }

    const schoolMap = new Map<
      string,
      { id: string; name: string; school_code: string | null }
    >();
    for (const s of schools) {
      schoolMap.set(s.id, {
        id: s.id,
        name: s.name,
        school_code: s.schoolCode ?? null,
      });
    }

    const searchLower = (search || '').trim().toLowerCase();

    const result = reports
      .map((r) => {
        const teacher = teacherMap.get(r.teacherId);
        const school = schoolMap.get(r.schoolId);
        const dateOnly = r.reportDate.toISOString().split('T')[0];
        return {
          id: r.id,
          teacher_id: String(r.teacherId),
          school_id: r.schoolId,
          date: dateOnly,
          grade: r.grade ?? '',
          topics_taught: r.topicsTaught ?? '',
          student_count: r.studentCount ?? 0,
          duration_hours: r.durationHours ?? 0,
          notes: r.notes ?? '',
          admin_notes: (r as any).adminNotes ?? '',
          status: r.status ?? 'submitted',
          created_at: r.createdAt.toISOString(),
          profiles: teacher
            ? {
                id: String(teacher.id),
                full_name: teacher.full_name,
                email: teacher.email,
              }
            : null,
          schools: school ?? null,
          teacher_name: teacher?.full_name ?? '',
          teacher_email: teacher?.email ?? '',
          school_name: school?.name ?? '',
          class_name: r.grade ?? '',
          // The teacher/school row no longer exists (hard-deleted) — "Unknown"
          // isn't a data-loading glitch, it's genuinely unresolvable. Surfaced
          // so the UI can label it clearly and offer cleanup instead of
          // silently showing an ambiguous "Unknown".
          teacher_deleted: !teacher,
          school_deleted: !school,
        };
      })
      .filter((report) => {
        if (!searchLower) return true;
        const haystack = [
          report.teacher_name,
          report.teacher_email,
          report.school_name,
          report.grade,
          report.topics_taught,
          report.notes,
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(searchLower);
      });

    return { reports: result };
  }

  /**
   * Purges TeacherReport rows whose teacherId/schoolId no longer resolve to
   * an existing User/School — a permanent hard delete (e.g. via Trash purge)
   * of a teacher or school before the cascade-on-purge fix existed. Opt-in
   * and explicit, so existing history is never silently discarded.
   */
  async cleanupOrphaned() {
    const reports = await this.db.teacherReport.findMany({
      select: { id: true, teacherId: true, schoolId: true },
    });
    if (reports.length === 0) return { success: true, deleted: 0 };

    const teacherIds = Array.from(new Set(reports.map((r) => r.teacherId)));
    const schoolIds = Array.from(new Set(reports.map((r) => r.schoolId)));
    const [existingTeachers, existingSchools] = await Promise.all([
      this.db.user.findMany({
        where: { id: { in: teacherIds } },
        select: { id: true },
      }),
      this.db.school.findMany({
        where: { id: { in: schoolIds } },
        select: { id: true },
      }),
    ]);
    const teacherSet = new Set(existingTeachers.map((t) => t.id));
    const schoolSet = new Set(existingSchools.map((s) => s.id));

    const orphanedIds = reports
      .filter((r) => !teacherSet.has(r.teacherId) || !schoolSet.has(r.schoolId))
      .map((r) => r.id);
    if (orphanedIds.length === 0) return { success: true, deleted: 0 };

    await this.db.teacherReport.deleteMany({
      where: { id: { in: orphanedIds } },
    });
    return { success: true, deleted: orphanedIds.length };
  }
}
