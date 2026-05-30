import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { validatePasswordStrength } from '../../common/utils/password.util';
import { AuditService } from '../../common/audit/audit.service';

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
    private readonly audit: AuditService,
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
      student_schools: (u.studentSchools ?? []).map((ss) => ({
        school_id: ss.schoolId,
        school_name: ss.school?.name ?? null,
        grade: ss.grade,
        section: ss.section,
        is_active: ss.isActive,
      })),
    };
  }

  async list(schoolId?: string, limit?: string) {
    const where = schoolId
      ? {
          role: Role.student,
          isActive: true,
          studentSchools: { some: { schoolId } },
        }
      : { role: Role.student, isActive: true };
    const take = limit ? parseInt(limit, 10) : 50;
    const users = await this.db.user.findMany({
      where,
      take: Math.min(take, 100),
      include: {
        profile: true,
        studentSchools: { include: { school: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const students = (users as UserWithRelations[]).map((u) =>
      this.toStudentDetail(u),
    );
    return { students };
  }

  async get(
    id: string,
    currentUser?: { id: number; role: Role; schoolId?: string },
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
      const schoolId = currentUser.schoolId;
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

    const created = await this.db.user.findFirst({
      where: { id: user.id },
      include: {
        profile: true,
        studentSchools: { include: { school: true } },
      },
    });
    this.audit.log({
      action: 'CREATE_STUDENT',
      entity: 'Student',
      entityId: String(user.id),
      details: `Created student ${email}`,
    });
    return this.toStudentDetail(created as UserWithRelations);
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
        await this.db.refreshToken.deleteMany({ where: { userId: studentId } });
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
    this.audit.log({
      action: 'UPDATE_STUDENT',
      entity: 'Student',
      entityId: id,
      details: `Updated student ${id}`,
    });
    return this.toStudentDetail(user as UserWithRelations);
  }

  async delete(id: string) {
    const studentId = parseInt(id, 10);
    try {
      await this.db.user.delete({ where: { id: studentId } });
    } catch (err: unknown) {
      // P2025 = record already deleted — treat as success
      if ((err as { code?: string })?.code !== 'P2025') throw err;
    }
    this.audit.log({
      action: 'DELETE_STUDENT',
      entity: 'Student',
      entityId: id,
      details: `Deleted student ${id}`,
    });
    return { success: true };
  }
}
