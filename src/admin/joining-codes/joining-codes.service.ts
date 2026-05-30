import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

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
    });

    const codes = rows.map((c) => ({
      id: c.id,
      code: c.code,
      school_id: c.schoolId,
      grade: c.grade,
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
    const usageType =
      (body.usageType as string | undefined) &&
      ['single', 'multiple'].includes(String(body.usageType))
        ? String(body.usageType)
        : 'multiple';
    const maxUsesRaw = body.maxUses as number | null | undefined;

    if (!schoolId) throw new BadRequestException('schoolId is required');
    if (!Array.isArray(grades) || grades.length === 0) {
      throw new BadRequestException('grades must be a non-empty array');
    }

    const school = await this.validateSchool(schoolId);
    if (!school) {
      throw new BadRequestException('School not found for given id');
    }

    const created: Record<string, string> = {};

    for (const grade of grades) {
      const code = await this.generateUniqueCode();
      await this.db.joinCode.create({
        data: {
          schoolId,
          grade: String(grade),
          code,
          usageType,
          maxUses: maxUsesRaw ?? null,
          usedCount: 0,
          isActive: true,
        },
      });
      created[String(grade)] = code;
    }

    return { codes: created };
  }

  async update(body: Record<string, unknown>) {
    const codeId = body.codeId as string | undefined;
    const codeValue = body.code as string | undefined;
    const regenerate = Boolean(body.regenerate);

    if (!codeId && !codeValue) {
      throw new BadRequestException('codeId or code is required');
    }

    const where = codeId ? { id: codeId } : { code: codeValue! };
    const existing = await this.db.joinCode.findUnique({ where });
    if (!existing) {
      throw new BadRequestException('Joining code not found');
    }

    if (regenerate) {
      const newCode = await this.generateUniqueCode();
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
  private async validateSchool(id: string) {
    const school = await this.db.school.findUnique({ where: { id } });
    if (school) return school;
    // Also accept tenant IDs as school IDs when a matching School record exists
    const tenant = await this.db.tenant.findUnique({ where: { id } });
    if (!tenant) return null;
    return this.db.school.findUnique({ where: { id: tenant.id } });
  }

  private async generateUniqueCode(): Promise<string> {
    for (;;) {
      const raw = Math.random().toString(36).slice(2, 10).toUpperCase();
      const code = `YUG-${raw}`;
      const existing = await this.db.joinCode.findUnique({ where: { code } });
      if (!existing) return code;
    }
  }
}
