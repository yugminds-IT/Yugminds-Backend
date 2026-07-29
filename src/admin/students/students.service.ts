import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { validatePasswordStrength, deriveFriendlyPassword } from '../../common/utils/password.util';
import { EnrollmentService } from '../../common/enrollment/enrollment.service';
import { AuthCacheService } from '../../auth/auth-cache.service';
import { RefreshTokenStoreService } from '../../auth/refresh-token-store.service';

type StudentSchoolDto = {
  school_id: string;
  school_name: string | null;
  grade: string | null;
  section: string | null;
  is_active: boolean;
};

export type StudentDetailResponse = {
  id: number;
  email: string;
  full_name: string | null;
  parent_name: string | null;
  parent_phone: string | null;
  tenantId: string | null;
  createdAt: Date;
  student_schools: StudentSchoolDto[];
  /** Plaintext initial password — present only until the student changes it. */
  initial_password: string | null;
};

type UserWithRelations = Awaited<
  ReturnType<DatabaseService['user']['findFirst']>
> & {
  profile: {
    fullName: string | null;
    parentName: string | null;
    parentPhone: string | null;
    schoolId: string | null;
  } | null;
  studentSchools: Array<{
    schoolId: string;
    grade: string | null;
    section: string | null;
    isActive: boolean;
    school?: { name: string };
  }>;
};

@Injectable()
export class AdminStudentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly enrollmentService: EnrollmentService,
    private readonly authCache: AuthCacheService,
    private readonly refreshTokenStore: RefreshTokenStoreService,
  ) {}

  private toStudentDetail(u: UserWithRelations): StudentDetailResponse {
    const profile = u.profile;
    return {
      id: u.id,
      email: u.email,
      full_name: profile?.fullName ?? null,
      parent_name: profile?.parentName ?? null,
      parent_phone: profile?.parentPhone ?? null,
      tenantId: u.tenantId ?? null,
      createdAt: u.createdAt,
      initial_password: (u as { initialPassword?: string | null }).initialPassword ?? null,
      student_schools: (u.studentSchools ?? []).map((ss) => ({
        school_id: ss.schoolId,
        school_name: ss.school?.name ?? null,
        grade: ss.grade,
        section: ss.section,
        is_active: ss.isActive,
      })),
    };
  }

  async list(
    schoolId?: string,
    limit?: string,
    options?: {
      page?: string;
      search?: string;
      grade?: string;
      section?: string;
      sort?: string;
      order?: string;
    },
  ) {
    const where: Record<string, unknown> = {
      role: Role.student,
      isActive: true,
      deletedAt: null, // exclude trashed students
    };
    // grade/section filters live on the StudentSchool enrollment row
    const enrollmentFilter: Record<string, unknown> = {};
    if (schoolId) enrollmentFilter.schoolId = schoolId;
    if (options?.grade) enrollmentFilter.grade = options.grade;
    if (options?.section) enrollmentFilter.section = options.section;
    if (Object.keys(enrollmentFilter).length > 0) {
      where.studentSchools = { some: enrollmentFilter };
    }
    if (options?.search) {
      const q = options.search.trim();
      where.OR = [
        { email: { contains: q, mode: 'insensitive' } },
        { profile: { is: { fullName: { contains: q, mode: 'insensitive' } } } },
        {
          profile: { is: { parentName: { contains: q, mode: 'insensitive' } } },
        },
      ];
    }

    const orderDir = options?.order === 'asc' ? 'asc' : 'desc';
    const orderBy =
      options?.sort === 'name'
        ? { profile: { fullName: orderDir } as never }
        : options?.sort === 'email'
          ? { email: orderDir as never }
          : { createdAt: orderDir as never };

    // Paged mode when `page` is provided; legacy limit-only mode otherwise.
    const page = options?.page
      ? Math.max(1, parseInt(options.page, 10) || 1)
      : null;
    const take = Math.min(
      limit ? parseInt(limit, 10) || 50 : page ? 50 : 50,
      5000,
    );

    const [users, total] = await Promise.all([
      this.db.user.findMany({
        where,
        take,
        ...(page ? { skip: (page - 1) * take } : {}),
        include: {
          profile: true,
          studentSchools: { include: { school: true } },
        },
        orderBy,
      }),
      this.db.user.count({ where }),
    ]);
    const students = (users as UserWithRelations[]).map((u) =>
      this.toStudentDetail(u),
    );
    return {
      students,
      total,
      ...(page
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
  ): Promise<StudentDetailResponse> {
    const user = await this.db.user.findFirst({
      where: { id: parseInt(id, 10) || 0, role: Role.student },
      include: {
        profile: true,
        studentSchools: { include: { school: true } },
      },
    });
    if (!user) throw new NotFoundException('Student not found');

    // SECURITY FIX (HIGH-02): Add authorization check for school admins
    if (currentUser && currentUser.role === Role.school_admin) {
      const schoolId = currentUser.tenantId;
      if (!schoolId) {
        throw new BadRequestException(
          'School admin must have a school assigned',
        );
      }

      // Check if student is enrolled in this school
      const hasAccess = (user as any).studentSchools?.some(
        (ss: any) => ss.schoolId === schoolId,
      );
      if (!hasAccess) {
        throw new NotFoundException('Student not found in your school');
      }
    }

    return this.toStudentDetail(user as UserWithRelations);
  }

  async create(body: Record<string, unknown>): Promise<StudentDetailResponse> {
    const email = String(body.email ?? '').trim();
    const password = body.password as string | undefined;
    const fullName = body.full_name as string | undefined;
    const parentName = body.parent_name as string | undefined;
    const parentPhone = body.parent_phone as string | undefined;
    const schoolId = (body.school_id ?? body.tenantId) as string | undefined;
    const grade = (body.grade as string | undefined) ?? null;
    const section = (body.section as string | undefined) ?? null;

    if (!email || !password) {
      throw new BadRequestException('Email and password required');
    }

    if (!schoolId) {
      throw new BadRequestException('school_id is required');
    }

    validatePasswordStrength(password);

    const existing = await this.db.user.findUnique({
      where: { email },
    });
    if (existing) {
      throw new BadRequestException('Email already exists');
    }

    const hash = await bcrypt.hash(password, 10);

    const user = await this.db.user.create({
      data: {
        email,
        password: hash,
        initialPassword: password,
        mustChangePassword: true,
        role: Role.student,
        tenantId: schoolId,
      },
    });

    await this.db.profile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        fullName: fullName ?? null,
        parentName: parentName ?? null,
        parentPhone: parentPhone ?? null,
        schoolId,
      },
      update: {
        ...(fullName !== undefined && { fullName }),
        ...(parentName !== undefined && { parentName }),
        ...(parentPhone !== undefined && { parentPhone }),
        ...(schoolId !== undefined && { schoolId }),
      },
    });

    await this.db.studentSchool.upsert({
      where: {
        studentId_schoolId: {
          studentId: user.id,
          schoolId,
        },
      },
      create: {
        studentId: user.id,
        schoolId,
        grade,
        section,
        isActive: true,
      },
      update: {
        grade,
        section,
        isActive: true,
      },
    });

    await this.enrollmentService.enrollStudentInRelevantCourses(
      user.id,
      schoolId,
      grade,
      section,
    );

    const created = await this.db.user.findFirst({
      where: { id: user.id },
      include: {
        profile: true,
        studentSchools: { include: { school: true } },
      },
    });
    return this.toStudentDetail(created as UserWithRelations);
  }

  private genPassword(fullName: string | undefined | null): string {
    return deriveFriendlyPassword(fullName);
  }

  /**
   * Bulk-creates students from a parsed CSV/Excel row array for a single
   * school. Mirrors the school-admin equivalent (bulkImportStudents in
   * school-admin-extra.controller.ts) but takes an explicit schoolId since
   * admin isn't tenant-scoped. `dryRun` validates every row (including
   * password strength for any row-supplied password) without writing
   * anything, so a large import can be checked end-to-end before committing.
   */
  async bulkImport(
    schoolId: string | undefined,
    rows: Array<Record<string, unknown>>,
    dryRun: boolean,
  ) {
    if (!schoolId) throw new BadRequestException('school_id is required');
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('No students provided');
    }
    if (rows.length > 500) {
      throw new BadRequestException(
        'Bulk import limit is 500 students per request',
      );
    }


    const results: Array<{
      index: number;
      email: string | null;
      success: boolean;
      error?: string;
      student_id?: number;
      generated_password?: string;
    }> = [];

    // Rows sharing an email within the same request never touch the DB (a
    // duplicate email doesn't exist there yet), so this catches what the
    // per-row findUnique below can't — independent of any frontend check.
    const seenEmails = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] ?? {};
      const email = String(r.email ?? '').trim().toLowerCase();
      const suppliedPassword = String(r.password ?? '').trim();

      if (!email) {
        results.push({ index: i, email: null, success: false, error: 'Email is required' });
        continue;
      }

      if (seenEmails.has(email)) {
        results.push({ index: i, email, success: false, error: 'Duplicate email within this import' });
        continue;
      }
      seenEmails.add(email);

      const exists = await this.db.user.findUnique({ where: { email } });
      if (exists) {
        results.push({ index: i, email, success: false, error: 'Email already exists' });
        continue;
      }

      let effectivePassword: string;
      try {
        if (suppliedPassword) {
          validatePasswordStrength(suppliedPassword);
          effectivePassword = suppliedPassword;
        } else {
          effectivePassword = this.genPassword(r.full_name as string | undefined);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Invalid password';
        results.push({ index: i, email, success: false, error: msg });
        continue;
      }

      if (dryRun) {
        results.push({
          index: i,
          email,
          success: true,
          generated_password: suppliedPassword ? undefined : effectivePassword,
        });
        continue;
      }

      try {
        const hash = await bcrypt.hash(effectivePassword, 10);
        const grade = (r.grade as string | undefined) ?? null;
        const rowSection = (r.section as string | undefined) ?? null;
        const created = await this.db.$transaction(async (tx) => {
          const newUser = await tx.user.create({
            data: {
              email,
              password: hash,
              initialPassword: effectivePassword,
              mustChangePassword: true,
              role: Role.student,
              tenantId: schoolId,
            },
          });

          await tx.profile.upsert({
            where: { userId: newUser.id },
            create: {
              userId: newUser.id,
              fullName: (r.full_name as string | undefined) ?? null,
              parentName: (r.parent_name as string | undefined) ?? null,
              parentPhone: (r.parent_phone as string | undefined) ?? null,
              schoolId,
            },
            update: {
              fullName: (r.full_name as string | undefined) ?? null,
              parentName: (r.parent_name as string | undefined) ?? null,
              parentPhone: (r.parent_phone as string | undefined) ?? null,
            },
          });

          await tx.studentSchool.create({
            data: {
              studentId: newUser.id,
              schoolId,
              grade,
              section: rowSection,
              isActive: true,
            },
          });

          return { userId: newUser.id };
        });

        await this.enrollmentService.enrollStudentInRelevantCourses(
          created.userId,
          schoolId,
          grade,
          rowSection,
        );

        results.push({
          index: i,
          email,
          success: true,
          student_id: created.userId,
          generated_password: suppliedPassword ? undefined : effectivePassword,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Failed to create student';
        results.push({ index: i, email, success: false, error: msg });
      }
    }

    const summary = {
      total: results.length,
      success: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      generated_passwords: results.filter((r) => r.success && r.generated_password).length,
      dry_run: dryRun,
    };

    return { success: true, summary, results };
  }

  async update(
    id: string,
    body: Record<string, unknown>,
  ): Promise<StudentDetailResponse> {
    const studentId = parseInt(id, 10);
    const data: Record<string, unknown> = {};
    if (body.email) data.email = body.email;
    if (body.tenantId !== undefined) data.tenantId = body.tenantId;
    if (body.isActive !== undefined) data.isActive = body.isActive;

    if (body.password && body.change_password) {
      const rawPw = String(body.password).trim();
      validatePasswordStrength(rawPw);
      data.password = await bcrypt.hash(rawPw, 10);
      data.initialPassword = rawPw;
      data.mustChangePassword = true;
    }

    const schoolId = (body.school_id ?? body.tenantId) as string | undefined;
    const grade = (body.grade as string | undefined) ?? null;
    const section = (body.section as string | undefined) ?? null;

    if (Object.keys(data).length > 0) {
      await this.db.user.update({
        where: { id: studentId },
        data: data as never,
      });
      if (data.password) {
        await this.refreshTokenStore.revokeAll(studentId);
      }
    }

    const profilePayload = {
      full_name: body.full_name as string | undefined,
      parent_name: body.parent_name as string | undefined,
      parent_phone: body.parent_phone as string | undefined,
    };

    if (
      profilePayload.full_name !== undefined ||
      profilePayload.parent_name !== undefined ||
      profilePayload.parent_phone !== undefined ||
      schoolId !== undefined
    ) {
      await this.db.profile.upsert({
        where: { userId: studentId },
        create: {
          userId: studentId,
          fullName: profilePayload.full_name ?? null,
          parentName: profilePayload.parent_name ?? null,
          parentPhone: profilePayload.parent_phone ?? null,
          schoolId: schoolId ?? null,
        },
        update: {
          ...(profilePayload.full_name !== undefined && {
            fullName: profilePayload.full_name,
          }),
          ...(profilePayload.parent_name !== undefined && {
            parentName: profilePayload.parent_name,
          }),
          ...(profilePayload.parent_phone !== undefined && {
            parentPhone: profilePayload.parent_phone,
          }),
          ...(schoolId !== undefined && { schoolId }),
        },
      });
    }

    if (schoolId) {
      await this.db.studentSchool.upsert({
        where: {
          studentId_schoolId: {
            studentId,
            schoolId,
          },
        },
        create: {
          studentId,
          schoolId,
          grade,
          section,
          isActive: true,
        },
        update: {
          grade,
          section,
          isActive: true,
        },
      });

      // keep tenantId in sync if not explicitly overridden
      if (body.tenantId === undefined) {
        await this.db.user.update({
          where: { id: studentId },
          data: { tenantId: schoolId },
        });
      }
    }

    const user = await this.db.user.findFirst({
      where: { id: studentId },
      include: {
        profile: true,
        studentSchools: { include: { school: true } },
      },
    });
    if (!user) throw new NotFoundException('Student not found');
    return this.toStudentDetail(user as UserWithRelations);
  }

  async enrollStudent(id: string) {
    const studentId = parseInt(id, 10);
    const studentSchools = await this.db.studentSchool.findMany({
      where: { studentId, isActive: true },
    });
    if (studentSchools.length === 0) {
      throw new NotFoundException('Student has no active school assignment');
    }
    // Count once before all schools, once after — N schools → 2 queries total.
    const before = await this.db.studentCourse.count({ where: { studentId } });
    for (const ss of studentSchools) {
      await this.enrollmentService.enrollStudentInRelevantCourses(
        studentId,
        ss.schoolId,
        ss.grade,
        ss.section,
      );
    }
    const after = await this.db.studentCourse.count({ where: { studentId } });
    const enrolled = after - before;
    return { success: true, new_enrollments: enrolled };
  }

  async syncEnrollments(schoolId?: string) {
    const studentWhere = schoolId
      ? {
          role: Role.student,
          isActive: true,
          studentSchools: { some: { schoolId } },
        }
      : { role: Role.student, isActive: true };

    const [studentsProcessed, publishedCourses] = await Promise.all([
      this.db.user.count({ where: studentWhere }),
      this.db.course.findMany({
        where: { isPublished: true },
        select: { id: true },
      }),
    ]);

    let newEnrollments = 0;
    newEnrollments =
      await this.enrollmentService.bulkSyncPublishedEnrollments(schoolId);

    return {
      success: true,
      students_processed: studentsProcessed,
      students_updated:
        newEnrollments > 0 ? Math.min(studentsProcessed, newEnrollments) : 0,
      new_enrollments: newEnrollments,
      courses_processed: publishedCourses.length,
    };
  }

  /**
   * Bulk operations over a set of students.
   *  - move:   set grade/section on the students' enrollment row for a school
   *  - enroll: sync course enrollments for each student
   *  - delete: soft-delete (Trash) each student
   */
  async bulk(body: {
    action?: string;
    student_ids?: Array<number | string>;
    school_id?: string;
    grade?: string;
    section?: string;
  }) {
    const ids = (body.student_ids ?? [])
      .map((v) => parseInt(String(v), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length === 0) {
      throw new BadRequestException('student_ids is required');
    }
    if (ids.length > 1000) {
      throw new BadRequestException('At most 1000 students per bulk operation');
    }

    switch (body.action) {
      case 'move': {
        if (!body.school_id || !body.grade) {
          throw new BadRequestException(
            'school_id and grade are required for move',
          );
        }
        const result = await this.db.studentSchool.updateMany({
          where: { studentId: { in: ids }, schoolId: body.school_id },
          data: {
            grade: body.grade,
            ...(body.section !== undefined ? { section: body.section } : {}),
          },
        });
        return { success: true, updated: result.count };
      }
      case 'enroll': {
        let succeeded = 0;
        const errors: string[] = [];
        for (const id of ids) {
          try {
            await this.enrollStudent(String(id));
            succeeded++;
          } catch (err) {
            errors.push(
              `Student ${id}: ${(err as Error)?.message ?? 'failed'}`,
            );
          }
        }
        return { success: errors.length === 0, enrolled: succeeded, errors };
      }
      case 'delete': {
        // Permanent delete, matching the single-student delete() behavior —
        // frees emails for reuse immediately rather than leaving them
        // reserved by a soft-deleted row.
        await this.authCache.invalidate(ids);
        const result = await this.db.user.deleteMany({
          where: { id: { in: ids }, role: Role.student },
        });
        return { success: true, deleted: result.count };
      }
      case 'reset_password': {
        // Issues each student a brand-new password, immediately invalidating
        // their old one (tokenVersion bump + auth cache clear) — this is a
        // real mutation, only ever triggered by an explicit admin opt-in.
        // Also stored as initialPassword/mustChangePassword, same as at
        // creation, so it's retrievable again until the student changes it.
        const namesById = new Map(
          (
            await this.db.profile.findMany({
              where: { userId: { in: ids } },
              select: { userId: true, fullName: true },
            })
          ).map((p) => [p.userId, p.fullName]),
        );

        const results: Array<{ id: number; new_password: string }> = [];
        for (const id of ids) {
          const newPassword = this.genPassword(namesById.get(id));
          const hash = await bcrypt.hash(newPassword, 10);
          await this.db.user.update({
            where: { id },
            data: {
              password: hash,
              initialPassword: newPassword,
              mustChangePassword: true,
              tokenVersion: { increment: 1 },
            },
          });
          await this.authCache.invalidate(id);
          results.push({ id, new_password: newPassword });
        }
        return { success: true, results };
      }
      default:
        throw new BadRequestException(
          'action must be one of: move, enroll, delete, reset_password',
        );
    }
  }

  /**
   * Permanently removes the student: the row is deleted outright (not
   * soft-deleted), immediately freeing their email for reuse — e.g. by a
   * later bulk import. Mirrors the same permanent-delete choice already
   * made for schools (AdminSchoolsService.delete).
   */
  async delete(id: string) {
    const studentId = parseInt(id, 10);
    try {
      await this.authCache.invalidate(studentId);
      await this.db.user.delete({ where: { id: studentId } });
    } catch (err: unknown) {
      // P2025 = record already deleted — treat as success
      if ((err as { code?: string })?.code !== 'P2025') throw err;
    }
    return { success: true };
  }
}
