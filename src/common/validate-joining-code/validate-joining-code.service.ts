import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AuthService, CreateUserOptions } from '../../auth/auth.service';
import { EnrollmentService } from '../enrollment/enrollment.service';
import { tenantContext } from '../../tenants/tenant-context';

export interface ValidateCodeResult {
  is_valid: boolean;
  school_id?: string;
  school_name?: string;
  grade?: string;
  section?: string;
  expires_at?: string | null;
  message?: string;
}

export interface RegisterWithCodeResult {
  success: boolean;
  school_name?: string;
  grade?: string;
  section?: string;
  student_id?: string;
  error?: string;
  message?: string;
}

@Injectable()
export class ValidateJoiningCodeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authService: AuthService,
    private readonly enrollmentService: EnrollmentService,
  ) {}

  async validate(code: string): Promise<ValidateCodeResult> {
    const trimmed = code?.trim()?.toUpperCase();
    if (!trimmed) {
      return { is_valid: false, message: 'Joining code is required' };
    }

    const joinCode = await this.db.joinCode.findUnique({
      where: { code: trimmed },
      include: {
        school: true,
        section: true,
      },
    });

    if (!joinCode) {
      return { is_valid: false, message: 'Invalid or expired joining code' };
    }
    if (!joinCode.isActive) {
      return {
        is_valid: false,
        message: 'This joining code is no longer active',
      };
    }
    if (joinCode.expiresAt && joinCode.expiresAt < new Date()) {
      return { is_valid: false, message: 'This joining code has expired' };
    }
    if (joinCode.maxUses != null && joinCode.usedCount >= joinCode.maxUses) {
      return {
        is_valid: false,
        message: 'This joining code has reached its maximum uses',
      };
    }

    const sectionName = joinCode.section?.name ?? null;
    return {
      is_valid: true,
      school_id: joinCode.schoolId,
      school_name: joinCode.school?.name ?? undefined,
      grade: joinCode.grade,
      section: sectionName ?? undefined,
      expires_at: joinCode.expiresAt ? joinCode.expiresAt.toISOString() : null,
    };
  }

  async validateAndRegister(
    code: string,
    studentData: {
      full_name: string;
      email: string;
      password: string;
      parent_name?: string;
      parent_phone?: string;
    },
  ): Promise<RegisterWithCodeResult> {
    const validation = await this.validate(code);
    if (!validation.is_valid) {
      return {
        success: false,
        error: validation.message ?? 'Invalid joining code',
        message: validation.message,
      };
    }

    const trimmed = code?.trim()?.toUpperCase();
    const joinCode = await this.db.joinCode.findUnique({
      where: { code: trimmed },
      include: { school: true, section: true },
    });
    if (!joinCode || !joinCode.isActive) {
      return { success: false, error: 'Invalid or inactive joining code' };
    }

    const { full_name, email, password, parent_name, parent_phone } =
      studentData;
    if (!email?.trim() || !password) {
      return { success: false, error: 'Email and password are required' };
    }

    try {
      // Run all DB operations inside the school's tenant context.
      // This endpoint is @Public() so TenantContextInterceptor never runs,
      // meaning tenantContext is empty — we must set it manually here.
      return await tenantContext.run(joinCode.schoolId, async () => {
        const result = await this.authService.signup({
          email: email.trim(),
          password,
          role: 'student' as CreateUserOptions['role'],
          tenantId: joinCode.schoolId,
          isSuperAdmin: false,
        });

        const userId = result.user.id;
        const sectionName = joinCode.section?.name ?? null;

        await this.db.studentSchool.create({
          data: {
            studentId: userId,
            schoolId: joinCode.schoolId,
            grade: joinCode.grade,
            section: sectionName,
            joiningCode: joinCode.code, // persist the code so enrollment source is traceable
            isActive: true,
          },
        });

        // Auto-enroll in courses for the school + grade
        await this.enrollmentService.enrollStudentInRelevantCourses(
          userId,
          joinCode.schoolId,
          joinCode.grade,
        );

        await this.db.profile.upsert({
          where: { userId },
          create: {
            userId,
            fullName: full_name?.trim() || null,
            parentName: parent_name?.trim() || null,
            parentPhone: parent_phone?.trim() || null,
            schoolId: joinCode.schoolId,
          },
          update: {
            fullName: full_name?.trim() || undefined,
            parentName: parent_name?.trim() || undefined,
            parentPhone: parent_phone?.trim() || undefined,
            schoolId: joinCode.schoolId,
          },
        });

        if (joinCode.usageType === 'single') {
          await this.db.joinCode.update({
            where: { id: joinCode.id },
            data: { usedCount: joinCode.usedCount + 1 },
          });
        } else if (joinCode.maxUses != null) {
          await this.db.joinCode.update({
            where: { id: joinCode.id },
            data: { usedCount: joinCode.usedCount + 1 },
          });
        }

        return {
          success: true,
          school_name: joinCode.school?.name,
          grade: joinCode.grade,
          section: sectionName ?? undefined,
          student_id: String(userId),
        };
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Registration failed';
      const isDuplicate =
        typeof msg === 'string' && msg.toLowerCase().includes('already in use');
      return {
        success: false,
        error: isDuplicate ? 'An account with this email already exists' : msg,
        message: msg,
      };
    }
  }
}
