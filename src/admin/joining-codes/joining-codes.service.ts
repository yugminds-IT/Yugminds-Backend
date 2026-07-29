import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import {
  deriveSchoolAbbreviation,
  deriveGradeAbbreviation,
  deriveSectionAbbreviation,
  buildJoinCodeCandidate,
} from '../../common/utils/join-code.util';

interface ListParams {
  schoolId?: string;
}

@Injectable()
export class AdminJoiningCodesService {
  constructor(private readonly db: DatabaseService) {}

  async list(params: ListParams) {
    const { schoolId } = params;
    if (!schoolId) {
      throw new BadRequestException('schoolId is required');
    }

    const rows = await this.db.joinCode.findMany({
      where: { schoolId },
      orderBy: { createdAt: 'desc' },
      include: { section: { select: { name: true } } },
    });

    const codes = rows.map((c) => ({
      id: c.id,
      code: c.code,
      school_id: c.schoolId,
      grade: c.grade,
      section: c.section?.name ?? null,
      is_active: c.isActive,
      usage_type: (c.usageType as 'single' | 'multiple') ?? 'single',
      times_used: c.usedCount,
      max_uses: c.maxUses,
      expires_at: c.expiresAt ? c.expiresAt.toISOString() : null,
      created_at: c.createdAt.toISOString(),
      updated_at: c.updatedAt?.toISOString?.() ?? c.createdAt.toISOString(),
    }));

    return { codes };
  }

  async create(body: Record<string, unknown>) {
    const schoolId = String(body.schoolId ?? '').trim();
    const grades = (body.grades as string[] | undefined) ?? [];
    // Optional: grade name -> section names. When a grade has entries here,
    // one code is generated PER SECTION (with gradeId/sectionId populated,
    // so signup enrolls the student into that exact section) instead of one
    // grade-wide code. A grade absent from this map (or with an empty
    // array) keeps the original whole-grade behavior.
    const sectionsByGrade =
      (body.sections as Record<string, string[]> | undefined) ?? {};
    const usageType =
      (body.usageType as string | undefined) &&
      ['single', 'multiple'].includes(String(body.usageType))
        ? String(body.usageType)
        : 'multiple';
    const maxUsesRaw = body.maxUses as number | null | undefined;
    // A "single" code with no explicit cap defaults to max_uses=1 — purely
    // cosmetic (the actual enforcement is in ValidateJoiningCodeService,
    // which checks usageType directly), but keeps the admin-facing
    // "times_used / max_uses" display honest for single-use codes instead
    // of showing a blank cap on a code that's actually one-time-only.
    const maxUses =
      maxUsesRaw ?? (usageType === 'single' ? 1 : null);
    // Codes never expired before (create() never set expiresAt at all,
    // despite the UI telling admins "codes expire after 1 year") — default
    // to a real 1-year expiration so that claim is actually true. Admins
    // can still change it per-code via Edit.
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    if (!schoolId) throw new BadRequestException('schoolId is required');
    if (!Array.isArray(grades) || grades.length === 0) {
      throw new BadRequestException('grades must be a non-empty array');
    }

    const school = await this.validateSchool(schoolId);
    if (!school) {
      throw new BadRequestException('School not found for given id');
    }
    const schoolCode = await this.ensureSchoolCode(school.id, school.name, school.schoolCode);

    // Kept for backward compatibility with existing frontend code that reads
    // `codes[gradeName]` for the whole-grade case (still exactly one entry
    // per grade there). Section-scoped codes are also listed in `results`.
    const created: Record<string, string> = {};
    const results: Array<{ grade: string; section: string | null; code: string }> = [];

    for (const grade of grades) {
      const gradeName = String(grade);
      const gradeRow = await this.db.grade.findFirst({
        where: { schoolId, name: gradeName },
        select: { id: true },
      });
      const sectionNames = (sectionsByGrade[gradeName] ?? []).filter(Boolean);

      if (gradeRow && sectionNames.length > 0) {
        for (const sectionName of sectionNames) {
          const sectionRow = await this.db.section.findFirst({
            where: { gradeId: gradeRow.id, name: sectionName },
            select: { id: true },
          });
          const code = await this.generateUniqueCode(schoolCode, gradeName, sectionName);
          await this.db.joinCode.create({
            data: {
              schoolId,
              grade: gradeName,
              gradeId: gradeRow.id,
              sectionId: sectionRow?.id ?? null,
              code,
              usageType,
              maxUses,
              usedCount: 0,
              isActive: true,
              expiresAt,
            },
          });
          results.push({ grade: gradeName, section: sectionName, code });
        }
      } else {
        const code = await this.generateUniqueCode(schoolCode, gradeName);
        await this.db.joinCode.create({
          data: {
            schoolId,
            grade: gradeName,
            gradeId: gradeRow?.id ?? null,
            code,
            usageType,
            maxUses,
            usedCount: 0,
            isActive: true,
            expiresAt,
          },
        });
        created[gradeName] = code;
        results.push({ grade: gradeName, section: null, code });
      }
    }

    return { codes: created, results };
  }

  async update(body: Record<string, unknown>) {
    const codeId = body.codeId as string | undefined;
    const codeValue = body.code as string | undefined;
    const regenerate = Boolean(body.regenerate);

    if (!codeId && !codeValue) {
      throw new BadRequestException('codeId or code is required');
    }

    const where = codeId ? { id: codeId } : { code: codeValue! };
    const existing = await this.db.joinCode.findUnique({
      where,
      include: { section: true },
    });
    if (!existing) {
      throw new BadRequestException('Joining code not found');
    }

    if (regenerate) {
      const school = await this.db.school.findUnique({
        where: { id: existing.schoolId },
      });
      const schoolCode = school
        ? await this.ensureSchoolCode(school.id, school.name, school.schoolCode)
        : deriveSchoolAbbreviation('');
      const newCode = await this.generateUniqueCode(
        schoolCode,
        existing.grade,
        existing.section?.name,
      );
      await this.db.joinCode.update({
        where: { id: existing.id },
        data: {
          code: newCode,
          usedCount: 0,
        },
      });
      return { success: true, code: newCode };
    }

    const data: Record<string, unknown> = {};

    if (body.usageType) {
      const usageType = String(body.usageType);
      if (!['single', 'multiple'].includes(usageType)) {
        throw new BadRequestException('usageType must be single or multiple');
      }
      data.usageType = usageType;
    }

    if (body.isActive !== undefined) {
      data.isActive = Boolean(body.isActive);
    }

    if (body.maxUses !== undefined) {
      const maxUses = body.maxUses as number | null;
      data.maxUses = maxUses ?? null;
    }

    if (body.expiresAt !== undefined) {
      const expiresAtStr = body.expiresAt as string | null;
      data.expiresAt = expiresAtStr ? new Date(expiresAtStr) : null;
    }

    if (body.grade !== undefined) {
      data.grade = String(body.grade);
    }

    if (body.code && codeId) {
      data.code = String(body.code);
    }

    if (Object.keys(data).length === 0) {
      return { success: true, message: 'No changes applied' };
    }

    await this.db.joinCode.update({
      where: { id: existing.id },
      data,
    });

    return { success: true };
  }

  /**
   * Ensure there is a School row for the given id.
   * The UI currently sends Tenant ids from /admin/schools,
   * so we accept either an existing School id or a Tenant id
   * and create a minimal School record for that tenant.
   */
  async remove(codeId: string) {
    if (!codeId) throw new BadRequestException('codeId is required');
    const existing = await this.db.joinCode.findUnique({
      where: { id: codeId },
    });
    if (!existing) {
      throw new BadRequestException('Joining code not found');
    }
    await this.db.joinCode.delete({ where: { id: codeId } });
    return { success: true };
  }

  private async validateSchool(id: string) {
    const school = await this.db.school.findUnique({ where: { id } });
    if (school) return school;
    // Also accept tenant IDs as school IDs when a matching School record exists
    const tenant = await this.db.tenant.findUnique({ where: { id } });
    if (!tenant) return null;
    return this.db.school.findUnique({ where: { id: tenant.id } });
  }

  /**
   * Returns the school's schoolCode, deriving and persisting one on the fly
   * for legacy schools that predate this field (mirrors the same fallback in
   * AdminSchoolsService.initAcademicStructure).
   */
  private async ensureSchoolCode(
    schoolId: string,
    name: string,
    existingCode: string | null,
  ): Promise<string> {
    if (existingCode) return existingCode;
    const base = deriveSchoolAbbreviation(name);
    let candidate = base;
    for (let suffix = 2; suffix < 100; suffix++) {
      const taken = await this.db.school.findUnique({
        where: { schoolCode: candidate },
        select: { id: true },
      });
      if (!taken) break;
      candidate = `${base}${suffix}`;
    }
    await this.db.school.update({
      where: { id: schoolId },
      data: { schoolCode: candidate },
    });
    return candidate;
  }

  private async generateUniqueCode(
    schoolCode: string,
    gradeName: string,
    sectionName?: string,
  ): Promise<string> {
    const gradeAbbr = deriveGradeAbbreviation(gradeName);
    const sectionAbbr = sectionName
      ? deriveSectionAbbreviation(sectionName)
      : undefined;
    const base = buildJoinCodeCandidate(schoolCode, gradeAbbr, sectionAbbr);

    for (let attempt = 0; attempt < 20; attempt++) {
      const code = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const existing = await this.db.joinCode.findUnique({ where: { code } });
      if (!existing) return code;
    }
    const raw = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `${base}-${raw}`;
  }
}
