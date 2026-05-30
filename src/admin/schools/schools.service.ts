import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AuthService, CreateUserOptions } from '../../auth/auth.service';
import { ok } from '../../common/api-response';
import { AuditService } from '../../common/audit/audit.service';

@Injectable()
export class AdminSchoolsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authService: AuthService,
    private readonly audit: AuditService,
  ) {}

  async list(_schoolId?: string, limit = 50, offset = 0) {
    const [total, tenants] = await Promise.all([
      this.db.tenant.count(),
      this.db.tenant.findMany({
        include: { users: true },
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const schoolIds = tenants.map((t) => t.id);
    const schoolRows = await this.db.school.findMany({
      where: { id: { in: schoolIds } },
      include: {
        teacherSchools: { select: { id: true } },
        studentSchools: { select: { id: true } },
        schoolAdmins: { include: { user: { include: { profile: true } } } },
        joinCodes: true,
        grades: { include: { sections: { include: { joinCodes: true } } } },
      },
    });
    const schoolById = new Map(schoolRows.map((s) => [s.id, s]));

    const schools = tenants.map((t) => {
      const s = schoolById.get(t.id);
      const primaryAdmin = s?.schoolAdmins?.[0];
      const school_admin_name =
        primaryAdmin?.user?.profile?.fullName?.trim() || null;
      const school_admin_email = primaryAdmin?.user?.email ?? null;
      const school_admin_user_id = primaryAdmin?.user?.id ?? null;
      const grades = (s?.grades ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        sections: (g.sections ?? []).map((sec) => ({
          id: sec.id,
          name: sec.name,
          joinCodes: (sec.joinCodes ?? []).map((jc) => ({
            id: jc.id,
            code: jc.code,
            grade: jc.grade,
            isActive: jc.isActive,
          })),
        })),
      }));
      const joinCodes = (s?.joinCodes ?? []).map((jc) => ({
        id: jc.id,
        code: jc.code,
        grade: jc.grade,
        isActive: jc.isActive,
      }));
      return {
        id: t.id,
        name: t.name,
        domain: t.domain,
        isActive: s?.isActive ?? false,
        createdAt: t.createdAt,
        userCount: t.users.length,
        teacherCount: s?.teacherSchools?.length ?? 0,
        studentCount: s?.studentSchools?.length ?? 0,
        school_admin_name,
        school_admin_email,
        school_admin_user_id,
        schoolCode: s?.schoolCode ?? null,
        email: s?.email ?? null,
        phone: s?.phone ?? null,
        address: s?.address ?? null,
        city: s?.city ?? null,
        state: s?.state ?? null,
        country: s?.country ?? null,
        pincode: s?.pincode ?? null,
        principalName: s?.principalName ?? null,
        affiliationType: s?.affiliationType ?? null,
        schoolType: s?.schoolType ?? null,
        establishedYear: s?.establishedYear ?? null,
        totalStudentsEstimate: s?.totalStudentsEstimate ?? null,
        totalTeachersEstimate: s?.totalTeachersEstimate ?? null,
        grades,
        joinCodes,
        gradesOffered: grades.map((g) => g.name),
      };
    });

    return ok({ schools, total, limit, offset });
  }

  async get(id: string) {
    const tenant = await this.db.tenant.findUnique({
      where: { id },
      include: { users: true },
    });
    if (!tenant) throw new NotFoundException('School not found');
    const school = await this.db.school.findUnique({
      where: { id },
      include: {
        grades: { include: { sections: { include: { joinCodes: true } } } },
        joinCodes: true,
        schoolAdmins: { include: { user: { include: { profile: true } } } },
      },
    });
    if (!school) {
      return {
        ...tenant,
        schoolCode: null,
        email: null,
        phone: null,
        address: null,
        city: null,
        state: null,
        country: null,
        pincode: null,
        principalName: null,
        affiliationType: null,
        schoolType: null,
        establishedYear: null,
        totalStudentsEstimate: null,
        totalTeachersEstimate: null,
        isActive: false,
        grades: [],
        joinCodes: [],
        gradesOffered: [],
        school_admin_name: null,
        school_admin_email: null,
        school_admin_user_id: null,
      };
    }
    const primaryGetAdmin = school.schoolAdmins?.[0];
    const grades = (school.grades ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      sections: (g.sections ?? []).map((sec) => ({
        id: sec.id,
        name: sec.name,
        joinCodes: (sec.joinCodes ?? []).map((jc) => ({
          id: jc.id,
          code: jc.code,
          grade: jc.grade,
          isActive: jc.isActive,
        })),
      })),
    }));
    return {
      ...tenant,
      schoolCode: school.schoolCode,
      email: school.email,
      phone: school.phone,
      address: school.address,
      city: school.city,
      state: school.state,
      country: school.country,
      pincode: school.pincode,
      principalName: school.principalName,
      affiliationType: school.affiliationType,
      schoolType: school.schoolType,
      establishedYear: school.establishedYear,
      totalStudentsEstimate: school.totalStudentsEstimate,
      totalTeachersEstimate: school.totalTeachersEstimate,
      isActive: school.isActive,
      grades,
      joinCodes: (school.joinCodes ?? []).map((jc) => ({
        id: jc.id,
        code: jc.code,
        grade: jc.grade,
        isActive: jc.isActive,
      })),
      gradesOffered: grades.map((g) => g.name),
      school_admin_name:
        primaryGetAdmin?.user?.profile?.fullName?.trim() || null,
      school_admin_email: primaryGetAdmin?.user?.email ?? null,
      school_admin_user_id: primaryGetAdmin?.user?.id ?? null,
    };
  }

  async create(body: Record<string, unknown>) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new BadRequestException('School name is required');

    const domain =
      body.domain && String(body.domain).trim().length > 0
        ? String(body.domain).trim()
        : this.generateDomainFromName(name);

    const tenant = await this.db.tenant.create({
      data: { name, domain },
    });

    const schoolData = this.pickSchoolDataFromBody(body);
    await this.db.school.upsert({
      where: { id: tenant.id },
      create: {
        id: tenant.id,
        name: tenant.name,
        ...schoolData,
      },
      update: {
        name: tenant.name,
        ...schoolData,
      },
    });

    await this.createAcademicStructureFromBody(tenant.id, body);

    // Create school admin user and link to school when admin credentials provided
    const adminEmail = String(
      body.school_admin_email ?? body.admin_email ?? '',
    ).trim();
    const adminPassword = String(
      body.school_admin_temp_password ??
        body.school_admin_password ??
        body.temp_password ??
        '',
    ).trim();
    if (adminEmail && adminPassword) {
      const result = await this.authService.signup({
        email: adminEmail,
        password: adminPassword,
        role: 'school_admin' as CreateUserOptions['role'],
        tenantId: tenant.id,
        isSuperAdmin: false,
      });
      const userId = result.user.id;
      await this.db.schoolAdmin.create({
        data: { userId, schoolId: tenant.id },
      });
      const fullName =
        body.school_admin_name != null
          ? String(body.school_admin_name).trim()
          : '';
      const phone =
        body.school_admin_phone != null
          ? String(body.school_admin_phone).trim()
          : null;
      await this.db.profile.upsert({
        where: { userId },
        create: {
          userId,
          fullName: fullName || null,
          phone: phone ?? null,
          schoolId: tenant.id,
        },
        update: {
          fullName: fullName || undefined,
          phone: phone ?? undefined,
          schoolId: tenant.id,
        },
      });
    }

    const codesRows = await this.db.joinCode.findMany({
      where: { schoolId: tenant.id },
      include: { section: true },
      orderBy: [{ grade: 'asc' }, { createdAt: 'asc' }],
    });
    const joining_codes: Record<string, string> = {};
    for (let i = 0; i < codesRows.length; i++) {
      const jc = codesRows[i];
      const base =
        jc.section != null
          ? `${jc.grade} (${jc.section.name})`
          : String(jc.grade);
      let key = base;
      let n = 0;
      while (Object.prototype.hasOwnProperty.call(joining_codes, key)) {
        n += 1;
        key = `${base} (${n})`;
      }
      joining_codes[key] = jc.code;
    }

    return ok({
      school: {
        id: tenant.id,
        name: tenant.name,
        domain: tenant.domain,
        createdAt: tenant.createdAt,
      },
      joinCodes: codesRows.map((jc) => ({
        id: jc.id,
        code: jc.code,
        grade: jc.grade,
        isActive: jc.isActive,
      })),
      joining_codes,
    });
  }

  async update(body: Record<string, unknown>) {
    const id = body.id != null ? String(body.id) : null;
    if (!id) throw new BadRequestException('School id is required');

    const name = body.name != null ? String(body.name).trim() : undefined;
    const domain = body.domain != null ? String(body.domain).trim() : undefined;
    const is_active =
      body.is_active !== undefined ? Boolean(body.is_active) : undefined;

    const tenantData: Record<string, unknown> = {};
    if (name !== undefined) tenantData.name = name;
    if (domain !== undefined) tenantData.domain = domain;

    if (Object.keys(tenantData).length > 0) {
      await this.db.tenant.update({
        where: { id },
        data: tenantData,
      });
    }

    const school = await this.ensureSchoolForTenant(id);
    const schoolData = this.pickSchoolDataFromBody(body);
    if (is_active !== undefined) {
      schoolData.isActive = is_active;
    }

    if (Object.keys(schoolData).length > 0) {
      await this.db.school.update({
        where: { id: school.id },
        data: schoolData,
      });
    }

    await this.applySchoolAdminUpdates(id, body);

    return { success: true };
  }

  /** Update primary school admin user/profile when admin fields are present on the body. */
  private async applySchoolAdminUpdates(
    schoolId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const adminEmailRaw = body.school_admin_email ?? body.admin_email;
    const adminNameRaw = body.school_admin_name;
    const adminPhoneRaw = body.school_admin_phone;
    const newPasswordRaw =
      body.school_admin_new_password ??
      body.school_admin_temp_password ??
      body.temp_password;

    const hasAny =
      adminEmailRaw != null ||
      adminNameRaw != null ||
      adminPhoneRaw != null ||
      (newPasswordRaw != null && String(newPasswordRaw).trim().length > 0);
    if (!hasAny) return;

    const schoolAdmin = await this.db.schoolAdmin.findFirst({
      where: { schoolId },
      include: { user: { include: { profile: true } } },
    });
    if (!schoolAdmin) {
      const email = String(adminEmailRaw ?? '').trim();
      const password = String(
        newPasswordRaw != null ? String(newPasswordRaw) : '',
      ).trim();
      if (email && password) {
        const result = await this.authService.signup({
          email,
          password,
          role: 'school_admin',
          tenantId: schoolId,
          isSuperAdmin: false,
        });
        await this.db.schoolAdmin.create({
          data: { userId: result.user.id, schoolId },
        });
        const fullName =
          adminNameRaw != null ? String(adminNameRaw).trim() : '';
        const phone =
          adminPhoneRaw != null ? String(adminPhoneRaw).trim() : null;
        await this.db.profile.upsert({
          where: { userId: result.user.id },
          create: {
            userId: result.user.id,
            fullName: fullName || null,
            phone: phone || null,
            schoolId,
          },
          update: {
            fullName: fullName || undefined,
            phone: phone ?? undefined,
            schoolId,
          },
        });
      }
      return;
    }

    const userId = schoolAdmin.userId;
    const nextEmail =
      adminEmailRaw != null ? String(adminEmailRaw).trim() : undefined;
    if (nextEmail !== undefined && nextEmail.length > 0) {
      const existing = await this.db.user.findUnique({
        where: { email: nextEmail },
      });
      if (existing && existing.id !== userId) {
        throw new BadRequestException('That admin email is already in use');
      }
      await this.db.user.update({
        where: { id: userId },
        data: { email: nextEmail },
      });
    }

    const fullName =
      adminNameRaw != null ? String(adminNameRaw).trim() : undefined;
    const phone =
      adminPhoneRaw != null ? String(adminPhoneRaw).trim() : undefined;
    if (fullName !== undefined || phone !== undefined) {
      await this.db.profile.upsert({
        where: { userId },
        create: {
          userId,
          fullName: fullName?.length ? fullName : null,
          phone: phone?.length ? phone : null,
          schoolId,
        },
        update: {
          ...(fullName !== undefined
            ? { fullName: fullName.length ? fullName : null }
            : {}),
          ...(phone !== undefined
            ? { phone: phone.length ? phone : null }
            : {}),
          schoolId,
        },
      });
    }

    const newPassword =
      newPasswordRaw != null ? String(newPasswordRaw).trim() : '';
    if (newPassword.length > 0) {
      await this.authService.resetPassword(userId, newPassword);
    }
  }

  /** Map request body (snake_case from frontend) to School model fields for create/update */
  private pickSchoolDataFromBody(
    body: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const str = (v: unknown) =>
      v != null && v !== '' ? String(v).trim() : null;
    const num = (v: unknown) => (v != null && v !== '' ? Number(v) : null);
    if (body.schoolCode != null) out.schoolCode = str(body.schoolCode);
    if (body.school_code != null) out.schoolCode = str(body.school_code);
    if (body.email != null) out.email = str(body.email);
    if (body.contact_email != null) out.email = str(body.contact_email);
    if (body.phone != null) out.phone = str(body.phone);
    if (body.contact_phone != null) out.phone = str(body.contact_phone);
    if (body.address != null) out.address = str(body.address);
    if (body.city != null) out.city = str(body.city);
    if (body.state != null) out.state = str(body.state);
    if (body.country != null) out.country = str(body.country);
    if (body.pincode != null) out.pincode = str(body.pincode);
    if (body.principalName != null) out.principalName = str(body.principalName);
    if (body.principal_name != null)
      out.principalName = str(body.principal_name);
    if (body.affiliationType != null)
      out.affiliationType = str(body.affiliationType);
    if (body.affiliation_type != null)
      out.affiliationType = str(body.affiliation_type);
    if (body.schoolType != null) out.schoolType = str(body.schoolType);
    if (body.school_type != null) out.schoolType = str(body.school_type);
    if (body.establishedYear != null)
      out.establishedYear = num(body.establishedYear);
    if (body.established_year != null)
      out.establishedYear = num(body.established_year);
    if (body.totalStudentsEstimate != null)
      out.totalStudentsEstimate = num(body.totalStudentsEstimate);
    if (body.total_students_estimate != null)
      out.totalStudentsEstimate = num(body.total_students_estimate);
    if (body.totalTeachersEstimate != null)
      out.totalTeachersEstimate = num(body.totalTeachersEstimate);
    if (body.total_teachers_estimate != null)
      out.totalTeachersEstimate = num(body.total_teachers_estimate);
    if (body.principalName != null) out.principalName = str(body.principalName);
    if (body.principal_name != null)
      out.principalName = str(body.principal_name);
    return out;
  }

  /** Get which teacher(s) are assigned to each section for a school (for UI "Assigned: Name" and conflict handling). */
  async getTeacherAssignments(schoolId: string): Promise<{
    assignments: Array<{
      sectionId: string;
      gradeId: string;
      gradeName: string;
      sectionName: string;
      teacherId: number;
      teacherName: string;
    }>;
  }> {
    const assignments = await this.db.teacherSectionAssignment.findMany({
      where: { schoolId },
      include: {
        section: { include: { grade: true } },
        teacher: { include: { profile: true } },
      },
    });
    return {
      assignments: assignments.map((a) => ({
        sectionId: a.sectionId,
        gradeId: a.section.gradeId,
        gradeName: a.section.grade.name,
        sectionName: a.section.name,
        teacherId: a.teacherId,
        teacherName: a.teacher.profile?.fullName ?? a.teacher.email,
      })),
    };
  }

  /** Initialize default grades/sections/join codes for an existing school (e.g. created before this feature). */
  async initAcademicStructure(
    schoolId: string,
  ): Promise<{ success: boolean; message: string }> {
    const school = await this.db.school.findUnique({
      where: { id: schoolId },
      include: { grades: { include: { sections: true } } },
    });
    if (!school) {
      throw new NotFoundException('School not found');
    }
    const existingCount = school.grades?.length ?? 0;
    if (existingCount > 0) {
      return {
        success: true,
        message: 'School already has grades configured.',
      };
    }
    await this.createDefaultAcademicStructure(schoolId);
    return {
      success: true,
      message: 'Default grades, sections, and join codes created.',
    };
  }

  async delete(id: string) {
    // Delete users belonging to this tenant first so the email can be reused (e.g. for a new school)
    const users = await this.db.user.findMany({
      where: { tenantId: id },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);
    if (userIds.length > 0) {
      await this.db.user.deleteMany({ where: { id: { in: userIds } } });
    }
    // Delete school row (same id as tenant) and its cascaded data (grades, sections, etc.)
    await this.db.school.deleteMany({ where: { id } });
    const result = await this.db.tenant.delete({ where: { id } });
    this.audit.log({
      action: 'DELETE_SCHOOL',
      entity: 'School',
      entityId: id,
      details: `Deleted school ${id}`,
    });
    return result;
  }

  private async ensureSchoolForTenant(id: string) {
    const existing = await this.db.school.findUnique({ where: { id } });
    if (existing) return existing;

    const tenant = await this.db.tenant.findUnique({ where: { id } });
    if (!tenant) {
      throw new NotFoundException('School not found');
    }

    return this.db.school.create({
      data: {
        id: tenant.id,
        name: tenant.name,
      },
    });
  }

  private generateDomainFromName(name: string): string {
    const base = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    // Fallback if name is empty or only non-alphanumeric
    const slug = base || 'school';
    return `${slug}.example-school`;
  }

  /** Default grade names created for every new school */
  private static readonly DEFAULT_GRADE_NAMES = [
    'Grade 1',
    'Grade 2',
    'Grade 3',
    'Grade 4',
    'Grade 5',
  ];

  /** Default section names created for each grade */
  private static readonly DEFAULT_SECTION_NAMES = ['Section A', 'Section B'];

  /**
   * Builds grades, sections, and join codes from the admin create form.
   * Falls back to default grade list only when no grades are supplied.
   */
  private async createAcademicStructureFromBody(
    schoolId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const rawGrades = body.grades_offered ?? body.gradesOffered;
    const fromForm = Array.isArray(rawGrades)
      ? (rawGrades as unknown[])
          .map((g) => String(g).trim())
          .filter((g) => g.length > 0)
      : [];
    const gradeNames =
      fromForm.length > 0
        ? fromForm
        : [...AdminSchoolsService.DEFAULT_GRADE_NAMES];

    const numSectionsRaw = body.number_of_sections ?? body.numberOfSections;
    const parsed =
      numSectionsRaw != null && String(numSectionsRaw).trim() !== ''
        ? Number(numSectionsRaw)
        : 0;
    const numSections =
      Number.isFinite(parsed) && parsed > 0
        ? Math.min(26, Math.max(1, parsed))
        : 0;

    const sectionNames =
      numSections > 0
        ? Array.from(
            { length: numSections },
            (_, i) => `Section ${String.fromCharCode(65 + i)}`,
          )
        : ['Section A'];

    const usageTypeStr = String(
      body.usage_type ?? body.usageType ?? 'single',
    ).toLowerCase();
    const usageType = usageTypeStr === 'multiple' ? 'multiple' : 'single';

    for (const gradeName of gradeNames) {
      const grade = await this.db.grade.upsert({
        where: {
          schoolId_name: { schoolId, name: gradeName },
        },
        create: { schoolId, name: gradeName },
        update: {},
      });

      for (const sectionName of sectionNames) {
        const section = await this.db.section.upsert({
          where: {
            gradeId_name: { gradeId: grade.id, name: sectionName },
          },
          create: { gradeId: grade.id, name: sectionName },
          update: {},
        });

        const code = await this.generateUniqueJoinCode();
        await this.db.joinCode.create({
          data: {
            schoolId,
            gradeId: grade.id,
            sectionId: section.id,
            grade: gradeName,
            code,
            usageType,
            isActive: true,
          },
        });
      }
    }
  }

  /**
   * Creates default academic structure: grades → sections → one join code per section.
   * Used by init-academic-structure for legacy schools without grades.
   */
  private async createDefaultAcademicStructure(
    schoolId: string,
  ): Promise<void> {
    for (const gradeName of AdminSchoolsService.DEFAULT_GRADE_NAMES) {
      const grade = await this.db.grade.upsert({
        where: {
          schoolId_name: { schoolId, name: gradeName },
        },
        create: { schoolId, name: gradeName },
        update: {},
      });

      for (const sectionName of AdminSchoolsService.DEFAULT_SECTION_NAMES) {
        const section = await this.db.section.upsert({
          where: {
            gradeId_name: { gradeId: grade.id, name: sectionName },
          },
          create: { gradeId: grade.id, name: sectionName },
          update: {},
        });

        const code = await this.generateUniqueJoinCode();
        await this.db.joinCode.create({
          data: {
            schoolId,
            gradeId: grade.id,
            sectionId: section.id,
            grade: gradeName,
            code,
            usageType: 'single',
            isActive: true,
          },
        });
      }
    }
  }

  private async generateUniqueJoinCode(): Promise<string> {
    for (;;) {
      const raw = Math.random().toString(36).slice(2, 10).toUpperCase();
      const code = `YUG-${raw}`;
      const existing = await this.db.joinCode.findUnique({ where: { code } });
      if (!existing) return code;
    }
  }
}
