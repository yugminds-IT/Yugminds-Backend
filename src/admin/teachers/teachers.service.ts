import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Role, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { validatePasswordStrength } from '../../common/utils/password.util';
import { AuthCacheService } from '../../auth/auth-cache.service';
import { RefreshTokenStoreService } from '../../auth/refresh-token-store.service';
import { getTodayIstDateStr } from '../../common/utils/date.util';

type SchoolAssignment = {
  school_id: string;
  school_name?: string;
  grades_assigned?: string[];
  grade_sections_assigned?: Array<{ grade: string; sections: string[] }>;
  subjects?: string[];
  working_days_per_week?: number;
  /** Which weekdays the teacher works at this school — 0=Sun..6=Sat. */
  working_days?: number[];
  /** When this working-days pattern takes effect (YYYY-MM-DD); defaults to today. */
  effective_from?: string;
  max_students_per_session?: number;
  is_primary?: boolean;
};

/** Dedupe/sort/clamp to 0-6; falls back to Mon-Fri when absent or empty. */
function normalizeWorkingDays(input?: number[]): number[] {
  if (!Array.isArray(input)) return [1, 2, 3, 4, 5];
  const days = [...new Set(input.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(
    (a, b) => a - b,
  );
  return days.length > 0 ? days : [1, 2, 3, 4, 5];
}

/** Clamp/validate an effective-from date string; falls back to today (IST). */
function normalizeEffectiveFrom(input?: string): Date {
  if (input && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return new Date(`${input}T00:00:00.000Z`);
  }
  return new Date(`${getTodayIstDateStr()}T00:00:00.000Z`);
}

/** Per-school grade with sections for API response */
export type GradeAssignedDto = {
  gradeName: string;
  sectionsAssigned: string[];
};

/** Section assigned to another teacher (for UI hint) */
export type SectionAssignedToOtherDto = {
  section: string;
  teacherName: string;
  /** @deprecated use section */
  sectionName?: string;
  /** @deprecated use teacherName */
  assignedToTeacherName?: string;
};

/** Enriched teacher detail for API response */
export type TeacherDetailResponse = {
  id: number;
  email: string;
  name: string;
  phone: string;
  qualification: string;
  experience: string;
  specialization: string;
  status: string;
  role: Role;
  tenantId: string | null;
  createdAt: Date;
  assignedSchools: Array<{
    schoolId: string;
    schoolName: string;
    gradesAssigned: GradeAssignedDto[];
    subjects: string[];
    workingDays: number[];
    sectionsAssignedToOtherTeachers?: SectionAssignedToOtherDto[];
  }>;
};

type UserWithRelations = Awaited<
  ReturnType<DatabaseService['user']['findFirst']>
> & {
  profile: {
    fullName: string | null;
    phone: string | null;
    qualification: string | null;
    experience: string | null;
    specialization: string | null;
  } | null;
  teacherSchools: Array<{
    schoolId: string;
    school: { name: string };
    subjects: string[];
    workingDays: number[];
  }>;
  teacherSectionAssignments: Array<{
    sectionId: string;
    section: { name: string; grade: { name: string } };
    schoolId: string;
  }>;
};

@Injectable()
export class AdminTeachersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authCache: AuthCacheService,
    private readonly refreshTokenStore: RefreshTokenStoreService,
  ) {}

  private buildGradesAssignedFromSectionAssignments(
    teacherSectionAssignments: UserWithRelations['teacherSectionAssignments'],
    schoolId: string,
  ): GradeAssignedDto[] {
    const byGrade = new Map<string, string[]>();
    for (const a of teacherSectionAssignments ?? []) {
      if (a.schoolId !== schoolId) continue;
      const gradeName = a.section?.grade?.name ?? '';
      const sectionName = a.section?.name ?? '';
      if (!gradeName) continue;
      if (!byGrade.has(gradeName)) byGrade.set(gradeName, []);
      const list = byGrade.get(gradeName)!;
      if (!list.includes(sectionName)) list.push(sectionName);
    }
    return Array.from(byGrade.entries()).map(
      ([gradeName, sectionsAssigned]) => ({
        gradeName,
        sectionsAssigned,
      }),
    );
  }

  private toTeacherDetail(
    u: UserWithRelations,
    otherAssignmentsBySchool?: Record<string, SectionAssignedToOtherDto[]>,
  ): TeacherDetailResponse {
    const profile = u.profile;
    const assignments = u.teacherSectionAssignments ?? [];
    const _schoolIds = [
      ...new Set((u.teacherSchools ?? []).map((ts) => ts.schoolId)),
    ];
    const assignedSchools = (u.teacherSchools ?? []).map((ts) => ({
      schoolId: ts.schoolId,
      schoolName: ts.school?.name ?? '',
      gradesAssigned: this.buildGradesAssignedFromSectionAssignments(
        assignments,
        ts.schoolId,
      ),
      subjects: Array.isArray(ts.subjects) ? ts.subjects : [],
      workingDays: normalizeWorkingDays(ts.workingDays),
      sectionsAssignedToOtherTeachers:
        otherAssignmentsBySchool?.[ts.schoolId] ?? [],
    }));
    return {
      id: u.id,
      email: u.email,
      name: profile?.fullName ?? '',
      phone: profile?.phone ?? '',
      qualification: profile?.qualification ?? '',
      experience: profile?.experience ?? '',
      specialization: profile?.specialization ?? '',
      status:
        (u as { isActive?: boolean }).isActive === false
          ? 'inactive'
          : 'active',
      role: u.role,
      tenantId: u.tenantId,
      createdAt: u.createdAt,
      assignedSchools,
    };
  }

  async list(
    schoolId?: string,
    limit?: number,
    options?: { page?: string; search?: string; sort?: string; order?: string },
  ): Promise<{
    teachers: TeacherDetailResponse[];
    total?: number;
    page?: number;
    limit?: number;
    totalPages?: number;
  }> {
    const where = {
      role: Role.teacher,
      deletedAt: null, // exclude trashed teachers
      ...(schoolId ? { teacherSchools: { some: { schoolId } } } : {}),
      ...(options?.search
        ? {
            OR: [
              {
                email: {
                  contains: options.search.trim(),
                  mode: 'insensitive' as const,
                },
              },
              {
                profile: {
                  is: {
                    fullName: {
                      contains: options.search.trim(),
                      mode: 'insensitive' as const,
                    },
                  },
                },
              },
            ],
          }
        : {}),
    };

    const orderDir =
      options?.order === 'asc' ? ('asc' as const) : ('desc' as const);
    const orderBy =
      options?.sort === 'name'
        ? { profile: { fullName: orderDir } }
        : options?.sort === 'email'
          ? { email: orderDir }
          : { createdAt: orderDir };

    // Paged mode when `page` is provided; legacy limit-only mode otherwise.
    const page = options?.page
      ? Math.max(1, parseInt(options.page, 10) || 1)
      : null;
    const take = page ? Math.min(limit && limit > 0 ? limit : 50, 500) : limit;

    const [users, total] = await Promise.all([
      this.db.user.findMany({
        where,
        orderBy,
        ...(take ? { take } : {}),
        ...(page && take ? { skip: (page - 1) * take } : {}),
        include: {
          profile: true,
          teacherSchools: { include: { school: true } },
          teacherSectionAssignments: {
            include: { section: { include: { grade: true } } },
          },
        },
      }),
      this.db.user.count({ where }),
    ]);
    const allSchoolIds = [
      ...new Set(
        users.flatMap((u) => (u.teacherSchools ?? []).map((ts) => ts.schoolId)),
      ),
    ];
    const otherAssignments =
      allSchoolIds.length > 0
        ? await this.db.teacherSectionAssignment.findMany({
            where: { schoolId: { in: allSchoolIds } },
            include: { section: true, teacher: { include: { profile: true } } },
          })
        : [];
    return {
      teachers: users.map((u) => {
        const excludeTeacherId = u.id;
        const otherBySchool: Record<string, SectionAssignedToOtherDto[]> = {};
        for (const ts of u.teacherSchools ?? []) {
          const assignedByOthers = otherAssignments.filter(
            (a) =>
              a.schoolId === ts.schoolId && a.teacherId !== excludeTeacherId,
          );
          otherBySchool[ts.schoolId] = assignedByOthers.map((a) => ({
            section: a.section?.name ?? '',
            teacherName: a.teacher?.profile?.fullName ?? a.teacher?.email ?? '',
          }));
        }
        return this.toTeacherDetail(u as UserWithRelations, otherBySchool);
      }),
      total,
      ...(page && take
        ? {
            page,
            limit: take,
            totalPages: Math.max(1, Math.ceil(total / take)),
          }
        : {}),
    };
  }

  async get(
    id: string,
    currentUser?: { id: number; role: Role; tenantId?: string },
  ): Promise<TeacherDetailResponse> {
    const user = await this.db.user.findFirst({
      where: { id: parseInt(id, 10) || 0, role: Role.teacher },
      include: {
        profile: true,
        teacherSchools: { include: { school: true } },
        teacherSectionAssignments: {
          include: { section: { include: { grade: true } } },
        },
      },
    });
    if (!user) throw new NotFoundException('Teacher not found');

    // SECURITY FIX (HIGH-02): Add authorization check for school admins
    if (currentUser && currentUser.role === Role.school_admin) {
      const schoolId = currentUser.tenantId;
      if (!schoolId) {
        throw new BadRequestException(
          'School admin must have a school assigned',
        );
      }

      // Check if teacher is assigned to at least one of this school admin's schools
      const hasAccess = user.teacherSchools?.some(
        (ts) => ts.schoolId === schoolId,
      );
      if (!hasAccess) {
        throw new NotFoundException('Teacher not found in your school');
      }
    }

    const u = user as UserWithRelations;
    const schoolIds = (u.teacherSchools ?? []).map((ts) => ts.schoolId);
    const otherAssignmentsBySchool: Record<
      string,
      SectionAssignedToOtherDto[]
    > = {};
    if (schoolIds.length > 0) {
      const other = await this.db.teacherSectionAssignment.findMany({
        where: { schoolId: { in: schoolIds }, teacherId: { not: u.id } },
        include: { section: true, teacher: { include: { profile: true } } },
      });
      for (const a of other) {
        if (!otherAssignmentsBySchool[a.schoolId])
          otherAssignmentsBySchool[a.schoolId] = [];
        otherAssignmentsBySchool[a.schoolId].push({
          section: a.section?.name ?? '',
          teacherName: a.teacher?.profile?.fullName ?? a.teacher?.email ?? '',
        });
      }
    }
    return this.toTeacherDetail(u, otherAssignmentsBySchool);
  }

  /** Resolve section name (e.g. "A" or "Section A") to Section id for a given grade in a school. */
  private async resolveSectionId(
    schoolId: string,
    gradeName: string,
    sectionNameOrLetter: string,
  ): Promise<string | null> {
    const grade = await this.db.grade.findUnique({
      where: { schoolId_name: { schoolId, name: gradeName } },
      include: { sections: true },
    });
    if (!grade) return null;
    const normalized = sectionNameOrLetter.trim();
    const withPrefix = normalized.toLowerCase().startsWith('section')
      ? normalized
      : `Section ${normalized}`;
    const section = grade.sections.find(
      (s) => s.name === normalized || s.name === withPrefix,
    );
    return section?.id ?? null;
  }

  /**
   * Throws BadRequestException if any of the given sections are already assigned to another teacher in the school.
   */
  private async checkDuplicateSectionAssignments(
    schoolId: string,
    sectionIds: string[],
    excludeTeacherId: number,
  ): Promise<void> {
    if (sectionIds.length === 0) return;
    const existing = await this.db.teacherSectionAssignment.findMany({
      where: {
        schoolId,
        sectionId: { in: sectionIds },
        teacherId: { not: excludeTeacherId },
      },
      include: { section: true, teacher: { include: { profile: true } } },
    });
    if (existing.length === 0) return;
    const details = existing
      .map(
        (e) =>
          `${e.section?.name ?? 'Section'} (assigned to ${e.teacher?.profile?.fullName ?? e.teacher?.email ?? 'another teacher'})`,
      )
      .join('; ');
    throw new BadRequestException(
      `One or more sections are already assigned to another teacher: ${details}. Please choose different sections.`,
    );
  }

  /**
   * A teacher-school pair's earliest recorded `effectiveFrom` IS that
   * assignment's real start date — nothing before it should ever count as a
   * working day for attendance, leave routing, or the teacher calendar (see
   * `resolveWorkingDaysForDate`). Rejects any write that would push a new
   * entry earlier than that floor, since doing so would silently move the
   * assignment's apparent start date backward for every already-computed
   * date in between. Re-saving the SAME `effectiveFrom` as the existing
   * earliest entry is still allowed — that corrects it in place via the
   * upsert below, it doesn't add an earlier one.
   */
  private async assertEffectiveFromNotBeforeStart(
    db: DatabaseService | Prisma.TransactionClient,
    teacherId: number,
    schoolId: string,
    effectiveFrom: Date,
  ): Promise<void> {
    const earliest = await db.teacherWorkingDaysHistory.aggregate({
      where: { teacherId, schoolId },
      _min: { effectiveFrom: true },
    });
    const floor = earliest._min.effectiveFrom;
    if (floor && effectiveFrom < floor) {
      throw new BadRequestException(
        `Effective date cannot be before ${floor.toISOString().split('T')[0]} — this teacher's assignment at this school starts then. To change the start date itself, edit that entry instead of adding an earlier one.`,
      );
    }
  }

  /**
   * Records a dated working-days change — upserted on
   * [teacherId, schoolId, effectiveFrom] so re-saving the same effective
   * date corrects that entry instead of duplicating it. Accepts either the
   * plain DatabaseService or a $transaction client so create() (transactional)
   * and update() (not) can share this.
   */
  private async recordWorkingDaysChange(
    db: DatabaseService | Prisma.TransactionClient,
    teacherId: number,
    schoolId: string,
    workingDays: number[],
    effectiveFrom: Date,
    actorId?: number,
  ): Promise<void> {
    await this.assertEffectiveFromNotBeforeStart(db, teacherId, schoolId, effectiveFrom);
    await db.teacherWorkingDaysHistory.upsert({
      where: {
        teacherId_schoolId_effectiveFrom: { teacherId, schoolId, effectiveFrom },
      },
      create: { teacherId, schoolId, workingDays, effectiveFrom, createdByUserId: actorId },
      update: { workingDays },
    });
  }

  async create(
    body: Record<string, unknown>,
    actorId?: number,
  ): Promise<TeacherDetailResponse> {
    const email = String(body.email ?? '').trim();
    const password = (body.password ?? body.temp_password) as string;
    const fullName = body.full_name as string | undefined;
    const phone = body.phone as string | undefined;
    const qualification = body.qualification as string | undefined;
    const specialization = body.specialization as string | undefined;
    const experienceRaw = body.experience as string | undefined;
    const experienceYears = body.experience_years as number | undefined;
    const experience =
      experienceRaw !== undefined && String(experienceRaw).trim() !== ''
        ? String(experienceRaw).trim()
        : experienceYears != null && Number.isFinite(Number(experienceYears))
          ? `${Number(experienceYears)} years`
          : null;
    const tenantId = (body.tenantId ?? body.school_id) as string | undefined;
    const schoolAssignments =
      (body.school_assignments as SchoolAssignment[] | undefined) ?? [];
    // Compute the first school assignment now so we can use it as a tenantId
    // fallback during user creation (avoiding a null-then-patch pattern).
    const firstSchoolIdEarly =
      schoolAssignments.length > 0 ? schoolAssignments[0].school_id : null;

    if (!email || !password) {
      throw new BadRequestException('Email and password required');
    }

    const existing = await this.db.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing)
      throw new BadRequestException('A user with this email already exists');

    validatePasswordStrength(password);

    const hash = await bcrypt.hash(password, 10);

    const firstSchoolId =
      schoolAssignments.length > 0 ? schoolAssignments[0].school_id : null;

    // Pre-validate all section assignments before writing any DB rows
    const resolvedAssignments: Array<{
      schoolId: string;
      gradesAssigned: string[];
      subjects: string[];
      workingDays: number[];
      workingDaysPerWeek: number;
      effectiveFrom: Date;
      sectionIdsToAssign: string[];
    }> = [];
    for (const assignment of schoolAssignments) {
      const schoolId = assignment.school_id;
      const gradesAssigned = assignment.grades_assigned ?? [];
      const gradeSectionsAssigned = assignment.grade_sections_assigned ?? [];
      const subjects = assignment.subjects ?? [];
      const workingDays = normalizeWorkingDays(assignment.working_days);
      const workingDaysPerWeek = workingDays.length;
      const effectiveFrom = normalizeEffectiveFrom(assignment.effective_from);

      const sectionIdsToAssign: string[] = [];
      for (const gs of gradeSectionsAssigned) {
        for (const sectionName of gs.sections ?? []) {
          const sectionId = await this.resolveSectionId(
            schoolId,
            gs.grade,
            sectionName,
          );
          if (sectionId) sectionIdsToAssign.push(sectionId);
        }
      }

      resolvedAssignments.push({
        schoolId,
        gradesAssigned,
        subjects,
        workingDays,
        workingDaysPerWeek,
        effectiveFrom,
        sectionIdsToAssign,
      });
    }

    const created = await this.db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          password: hash,
          role: Role.teacher,
          tenantId: tenantId || firstSchoolIdEarly || null,
        },
      });

      await tx.profile.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          fullName: fullName ?? null,
          phone: phone ?? null,
          qualification: qualification ?? null,
          experience: experience,
          specialization: specialization ?? null,
        },
        update: {
          ...(fullName !== undefined && { fullName }),
          ...(phone !== undefined && { phone }),
          ...(qualification !== undefined && { qualification }),
          ...(experience != null && { experience }),
          ...(specialization !== undefined && {
            specialization: specialization ?? null,
          }),
        },
      });

      for (const {
        schoolId,
        gradesAssigned,
        subjects,
        workingDays,
        workingDaysPerWeek,
        effectiveFrom,
        sectionIdsToAssign,
      } of resolvedAssignments) {
        await this.checkDuplicateSectionAssignments(
          schoolId,
          sectionIdsToAssign,
          user.id,
        );

        await tx.teacherSchool.upsert({
          where: { teacherId_schoolId: { teacherId: user.id, schoolId } },
          create: {
            teacherId: user.id,
            schoolId,
            subjects,
            workingDays,
            workingDaysPerWeek,
          },
          update: {
            subjects,
            workingDays,
            workingDaysPerWeek,
          },
        });
        // Brand-new assignment — always record an initial history entry.
        await this.recordWorkingDaysChange(
          tx,
          user.id,
          schoolId,
          workingDays,
          effectiveFrom,
          actorId,
        );

        await tx.teacherSectionAssignment.deleteMany({
          where: { teacherId: user.id, schoolId },
        });
        for (const sectionId of sectionIdsToAssign) {
          await tx.teacherSectionAssignment.create({
            data: { teacherId: user.id, sectionId, schoolId },
          });
        }
      }

      if (firstSchoolId && !tenantId && firstSchoolId !== firstSchoolIdEarly) {
        await tx.user.update({
          where: { id: user.id },
          data: { tenantId: firstSchoolId },
        });
      }

      return tx.user.findFirst({
        where: { id: user.id },
        include: {
          profile: true,
          teacherSchools: { include: { school: true } },
          teacherSectionAssignments: {
            include: { section: { include: { grade: true } } },
          },
        },
      });
    });
    if (!created) {
      throw new BadRequestException('Failed to create teacher');
    }
    return this.toTeacherDetail(created as UserWithRelations);
  }

  async update(
    id: string,
    body: Record<string, unknown>,
    actorId?: number,
  ): Promise<TeacherDetailResponse> {
    const teacherId = parseInt(id, 10);
    const data: Record<string, unknown> = {};
    if (body.email) data.email = body.email;
    if (body.tenantId !== undefined) data.tenantId = body.tenantId;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    // Accept both `password` (internal) and `temp_password` + `change_password` (admin dashboard flow)
    const rawPassword =
      body.change_password === true
        ? String(body.temp_password ?? '').trim()
        : body.password
          ? String(body.password).trim()
          : '';
    if (rawPassword) {
      validatePasswordStrength(rawPassword);
      data.password = await bcrypt.hash(rawPassword, 10);
    }
    await this.db.user.update({
      where: { id: teacherId },
      data: data as never,
    });
    // Invalidate stale sessions when password is changed
    if (rawPassword) {
      await this.refreshTokenStore.revokeAll(teacherId);
    }
    const experienceRaw = body.experience as string | undefined;
    const experienceYears = body.experience_years as number | undefined;
    const experience =
      experienceRaw !== undefined && experienceRaw !== ''
        ? experienceRaw
        : experienceYears != null && Number.isFinite(Number(experienceYears))
          ? `${experienceYears} years`
          : undefined;
    const profilePayload = {
      full_name: body.full_name as string | undefined,
      phone: body.phone as string | undefined,
      qualification: body.qualification as string | undefined,
      experience,
      specialization: body.specialization as string | undefined,
    };
    if (Object.values(profilePayload).some((v) => v !== undefined)) {
      await this.db.profile.upsert({
        where: { userId: teacherId },
        create: {
          userId: teacherId,
          fullName: profilePayload.full_name ?? null,
          phone: profilePayload.phone ?? null,
          qualification: profilePayload.qualification ?? null,
          experience: profilePayload.experience ?? null,
          specialization: profilePayload.specialization ?? null,
        },
        update: {
          ...(profilePayload.full_name !== undefined && {
            fullName: profilePayload.full_name,
          }),
          ...(profilePayload.phone !== undefined && {
            phone: profilePayload.phone,
          }),
          ...(profilePayload.qualification !== undefined && {
            qualification: profilePayload.qualification,
          }),
          ...(profilePayload.experience !== undefined && {
            experience: profilePayload.experience,
          }),
          ...(profilePayload.specialization !== undefined && {
            specialization: profilePayload.specialization ?? null,
          }),
        },
      });
    }

    const schoolAssignments = body.school_assignments as
      | SchoolAssignment[]
      | undefined;
    if (Array.isArray(schoolAssignments)) {
      const keepSchoolIds = new Set(
        schoolAssignments.map((a) => a.school_id).filter(Boolean),
      );
      const existingSchoolLinks = await this.db.teacherSchool.findMany({
        where: { teacherId },
      });
      // "Before" snapshot per school so the assignment loop below can tell
      // whether working_days actually changed and only then record new
      // history — a plain re-save without edits shouldn't add a duplicate
      // history entry.
      const beforeWorkingDaysBySchool = new Map(
        existingSchoolLinks.map((l) => [l.schoolId, l.workingDays] as const),
      );
      for (const link of existingSchoolLinks) {
        if (!keepSchoolIds.has(link.schoolId)) {
          await this.db.teacherSectionAssignment.deleteMany({
            where: { teacherId, schoolId: link.schoolId },
          });
          await this.db.teacherSchool.delete({
            where: {
              teacherId_schoolId: { teacherId, schoolId: link.schoolId },
            },
          });
        }
      }

      const firstSchoolId =
        schoolAssignments.length > 0 ? schoolAssignments[0].school_id : null;
      for (const assignment of schoolAssignments) {
        const schoolId = assignment.school_id;
        const gradesAssigned = assignment.grades_assigned ?? [];
        const gradeSectionsAssigned = assignment.grade_sections_assigned ?? [];
        const subjects = assignment.subjects ?? [];
        const workingDays = normalizeWorkingDays(assignment.working_days);
        const workingDaysPerWeek = workingDays.length;

        // Only record a new dated history entry when the pattern actually
        // changed (or this is a brand-new school for this teacher) — this is
        // what makes a mid-month change (e.g. Mon-Thu -> Mon-Fri) apply only
        // from its effective date forward instead of rewriting the whole
        // month's attendance retroactively.
        const before = beforeWorkingDaysBySchool.get(schoolId);
        const changed =
          !before ||
          before.length !== workingDays.length ||
          before.some((d, i) => d !== workingDays[i]);
        const effectiveFrom = normalizeEffectiveFrom(assignment.effective_from);

        if (changed) {
          await this.assertEffectiveFromNotBeforeStart(
            this.db,
            teacherId,
            schoolId,
            effectiveFrom,
          );
        }

        // TeacherSchool (the "current" cache) and the history entry must
        // land together — if the upsert succeeded but the history write
        // failed, every attendance calculation (which reads history, not
        // TeacherSchool.workingDays) would silently keep using the old
        // pattern while the UI shows the new one as saved.
        await this.db.$transaction([
          this.db.teacherSchool.upsert({
            where: { teacherId_schoolId: { teacherId, schoolId } },
            create: {
              teacherId,
              schoolId,
              subjects,
              workingDays,
              workingDaysPerWeek,
            },
            update: {
              subjects,
              workingDays,
              workingDaysPerWeek,
            },
          }),
          ...(changed
            ? [
                this.db.teacherWorkingDaysHistory.upsert({
                  where: {
                    teacherId_schoolId_effectiveFrom: { teacherId, schoolId, effectiveFrom },
                  },
                  create: { teacherId, schoolId, workingDays, effectiveFrom, createdByUserId: actorId },
                  update: { workingDays },
                }),
              ]
            : []),
        ]);

        const sectionIdsToAssign: string[] = [];
        for (const gs of gradeSectionsAssigned) {
          for (const sectionName of gs.sections ?? []) {
            const sectionId = await this.resolveSectionId(
              schoolId,
              gs.grade,
              sectionName,
            );
            if (sectionId) sectionIdsToAssign.push(sectionId);
          }
        }

        await this.checkDuplicateSectionAssignments(
          schoolId,
          sectionIdsToAssign,
          teacherId,
        );

        await this.db.teacherSectionAssignment.deleteMany({
          where: { teacherId, schoolId },
        });
        for (const sectionId of sectionIdsToAssign) {
          await this.db.teacherSectionAssignment.create({
            data: { teacherId, sectionId, schoolId },
          });
        }
      }
      // Keep teacher's tenantId in sync with first assigned school for JWT/legacy use
      if (firstSchoolId) {
        await this.db.user.update({
          where: { id: teacherId },
          data: { tenantId: firstSchoolId },
        });
      }
    }

    const user = await this.db.user.findFirst({
      where: { id: teacherId },
      include: {
        profile: true,
        teacherSchools: { include: { school: true } },
        teacherSectionAssignments: {
          include: { section: { include: { grade: true } } },
        },
      },
    });
    return this.toTeacherDetail(user as UserWithRelations);
  }

  /**
   * Bulk operations over a set of teachers.
   *  - deactivate / activate: toggle account access without trashing
   *  - delete: soft-delete (Trash) each teacher
   */
  async bulk(body: { action?: string; teacher_ids?: Array<number | string> }) {
    const ids = (body.teacher_ids ?? [])
      .map((v) => parseInt(String(v), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length === 0) {
      throw new BadRequestException('teacher_ids is required');
    }
    if (ids.length > 500) {
      throw new BadRequestException('At most 500 teachers per bulk operation');
    }
    const where = { id: { in: ids }, role: Role.teacher };

    switch (body.action) {
      case 'deactivate': {
        const result = await this.db.user.updateMany({
          where,
          data: { isActive: false, tokenVersion: { increment: 1 } },
        });
        await this.authCache.invalidate(ids);
        return { success: true, updated: result.count };
      }
      case 'activate': {
        const result = await this.db.user.updateMany({
          where: { ...where, deletedAt: null },
          data: { isActive: true },
        });
        return { success: true, updated: result.count };
      }
      case 'delete': {
        const result = await this.db.user.updateMany({
          where,
          data: {
            deletedAt: new Date(),
            isActive: false,
            tokenVersion: { increment: 1 },
          },
        });
        await this.authCache.invalidate(ids);
        return { success: true, deleted: result.count };
      }
      default:
        throw new BadRequestException(
          'action must be one of: activate, deactivate, delete',
        );
    }
  }

  async delete(id: string) {
    try {
      // Soft delete: record lands in the admin Trash and can be restored.
      // tokenVersion bump invalidates any live sessions immediately.
      const result = await this.db.user.update({
        where: { id: parseInt(id, 10) },
        data: {
          deletedAt: new Date(),
          isActive: false,
          tokenVersion: { increment: 1 },
        },
      });
      await this.authCache.invalidate(parseInt(id, 10));
      return result;
    } catch (err: unknown) {
      // P2025 = record already deleted — treat as success
      if ((err as { code?: string })?.code === 'P2025') {
        return { id: parseInt(id, 10) };
      }
      throw err;
    }
  }

  /** Dated working-days entries for one teacher+school, oldest first. */
  async getWorkingDaysHistory(id: string, schoolId: string) {
    const teacherId = parseInt(id, 10);
    if (!schoolId) {
      throw new BadRequestException('school_id is required');
    }
    const entries = await this.db.teacherWorkingDaysHistory.findMany({
      where: { teacherId, schoolId },
      orderBy: { effectiveFrom: 'asc' },
    });
    return {
      history: entries.map((e) => ({
        effective_from: e.effectiveFrom.toISOString().split('T')[0],
        working_days: e.workingDays,
      })),
    };
  }
}
