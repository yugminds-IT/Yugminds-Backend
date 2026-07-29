import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { StorageService } from '../../common/storage/storage.service';

export interface UploadedFileLike {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
}

@Injectable()
export class AdminLogosService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Reads image dimensions from raw buffer without any extra dependency.
   * Returns `'svg'` for SVG (no fixed pixel dimensions — exempt from the
   * 300×300 minimum by design) or the parsed `{w, h}` for a raster image.
   * Throws for a PNG/JPEG whose dimensions couldn't be parsed — a caller
   * that treated "unparseable" the same as "dimensions unknown, allow it"
   * would let a corrupt/truncated file silently bypass the minimum-size
   * check entirely (that was the previous behavior here).
   */
  readImageDims(
    buffer: Buffer,
    mimetype: string,
  ): { w: number; h: number } | 'svg' {
    if (mimetype === 'image/svg+xml') return 'svg';
    if (mimetype === 'image/png') {
      // PNG: bytes 16-19 = width, 20-23 = height (big-endian)
      if (buffer.length < 24) {
        throw new BadRequestException('Could not read PNG dimensions — file may be corrupt');
      }
      return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20) };
    }
    if (mimetype === 'image/jpeg') {
      // Scan JPEG for SOF0/SOF2 markers (0xFF C0 / 0xFF C2)
      let i = 2;
      while (i < buffer.length - 8) {
        if (buffer[i] !== 0xff) break;
        const marker = buffer[i + 1];
        const len = buffer.readUInt16BE(i + 2);
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          marker === 0xc9 ||
          (marker >= 0xca && marker <= 0xcf)
        ) {
          return {
            w: buffer.readUInt16BE(i + 7),
            h: buffer.readUInt16BE(i + 5),
          };
        }
        i += 2 + len;
      }
      throw new BadRequestException('Could not read JPEG dimensions — file may be corrupt');
    }
    throw new BadRequestException('Unsupported image type');
  }

  async list(opts: { limit?: string; offset?: string; search?: string }) {
    const { limit, offset, search } = opts;
    const take = limit
      ? Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100)
      : 20;
    const skip = offset ? Math.max(parseInt(offset, 10) || 0, 0) : 0;
    const where: Record<string, unknown> = { deletedAt: null };
    const q = (search ?? '').trim();
    if (q) {
      where.schoolName = { contains: q, mode: 'insensitive' };
    }
    const [logos, total] = await Promise.all([
      this.db.logo.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.db.logo.count({ where }),
    ]);
    const data = logos.map((l) => ({
      id: l.id,
      school_id: (l as any).schoolId ?? null,
      school_name: l.schoolName,
      description: l.description,
      image_url: l.imageUrl,
      upload_date: l.createdAt.toISOString(),
    }));
    return { data, total };
  }

  async create(
    file: UploadedFileLike,
    body: { school_name?: string; school_id?: string; description?: string },
  ) {
    let schoolName = (body?.school_name ?? '').trim();
    const schoolId = (body?.school_id ?? '').trim() || null;
    let schoolNumber: number | null = null;

    // Resolve school name from school_id when provided
    if (schoolId) {
      const school = await this.db.school.findUnique({
        where: { id: schoolId },
        select: { name: true, schoolNumber: true },
      });
      if (!school) throw new BadRequestException('School not found');
      schoolName = school.name;
      schoolNumber = school.schoolNumber;

      // Without this, re-uploading via "Upload New" for a school that
      // already has a logo silently creates a second Logo row and leaves
      // the old row + its S3 object orphaned. Use Edit → Replace instead.
      const existingLogo = await this.db.logo.findFirst({
        where: { schoolId, deletedAt: null },
        select: { id: true },
      });
      if (existingLogo) {
        throw new BadRequestException(
          `${schoolName} already has a logo — use Replace or Edit on the existing one instead of uploading a new one.`,
        );
      }
    }

    if (!schoolName) {
      throw new BadRequestException('school_id or school_name is required');
    }
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (!['image/png', 'image/jpeg', 'image/svg+xml'].includes(file.mimetype)) {
      throw new BadRequestException('Only JPG, PNG, SVG allowed');
    }
    if (file.size > 2 * 1024 * 1024) {
      throw new BadRequestException('Max file size is 2MB');
    }
    const dims = this.readImageDims(file.buffer, file.mimetype);
    if (dims !== 'svg' && (dims.w < 300 || dims.h < 300)) {
      throw new BadRequestException('Minimum image dimensions are 300×300 px');
    }
    const logoKey = this.storage.buildKey(
      `logos/${schoolNumber ?? 'unassigned'}`,
      file.originalname ?? 'logo.png',
    );
    const imageUrl = await this.storage.uploadBuffer(
      logoKey,
      file.buffer,
      file.mimetype,
    );
    const logo = await this.db.logo.create({
      data: {
        schoolName,
        schoolId,
        description: body?.description?.trim() || null,
        imageUrl,
        imageKey: logoKey,
      } as any,
    });
    return {
      id: logo.id,
      school_id: (logo as any).schoolId ?? null,
      school_name: logo.schoolName,
      description: logo.description,
      image_url: logo.imageUrl,
      upload_date: logo.createdAt.toISOString(),
    };
  }

  async get(id: string) {
    const logo = await this.db.logo.findUnique({ where: { id } });
    if (!logo || logo.deletedAt) {
      throw new BadRequestException('Logo not found');
    }
    return {
      id: logo.id,
      school_id: (logo as any).schoolId ?? null,
      school_name: logo.schoolName,
      description: logo.description,
      image_url: logo.imageUrl,
      upload_date: logo.createdAt.toISOString(),
    };
  }

  async update(
    id: string,
    file: UploadedFileLike | undefined,
    body: {
      school_name?: string;
      school_id?: string;
      description?: string;
      replace_image?: string;
    },
  ) {
    const existing = await this.db.logo.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new BadRequestException('Logo not found');
    }
    const existingSchoolNumber = existing.schoolId
      ? (
          await this.db.school.findUnique({
            where: { id: existing.schoolId },
            select: { schoolNumber: true },
          })
        )?.schoolNumber
      : null;
    const data: {
      schoolName?: string;
      schoolId?: string | null;
      description?: string | null;
      imageUrl?: string;
      imageKey?: string;
    } = {};
    const newSchoolId = (body?.school_id ?? '').trim() || null;
    if (newSchoolId !== null) {
      const school = await this.db.school.findUnique({
        where: { id: newSchoolId },
        select: { name: true },
      });
      if (!school) throw new BadRequestException('School not found');
      data.schoolName = school.name;
      data.schoolId = newSchoolId;
    } else if (body?.school_name !== undefined) {
      const name = body.school_name.trim();
      if (!name) throw new BadRequestException('school_name cannot be empty');
      data.schoolName = name;
    }
    if (body?.description !== undefined) {
      const desc = body.description.trim();
      data.description = desc || null;
    }
    const wantsReplace = body?.replace_image === 'true';
    if (wantsReplace) {
      if (!file)
        throw new BadRequestException(
          'file is required when replace_image=true',
        );
      if (
        !['image/png', 'image/jpeg', 'image/svg+xml'].includes(file.mimetype)
      ) {
        throw new BadRequestException('Only JPG, PNG, SVG allowed');
      }
      if (file.size > 2 * 1024 * 1024) {
        throw new BadRequestException('Max file size is 2MB');
      }
      const dims = this.readImageDims(file.buffer, file.mimetype);
      if (dims !== 'svg' && (dims.w < 300 || dims.h < 300)) {
        throw new BadRequestException(
          'Minimum image dimensions are 300×300 px',
        );
      }
      const logoKey = this.storage.buildKey(
        `logos/${existingSchoolNumber ?? 'unassigned'}`,
        file.originalname ?? 'logo.png',
      );
      data.imageUrl = await this.storage.uploadBuffer(
        logoKey,
        file.buffer,
        file.mimetype,
      );
      data.imageKey = logoKey;
    }
    const oldLogoKey = wantsReplace ? existing.imageKey : null;
    const updated = await this.db.logo.update({
      where: { id },
      data: data as any,
    });
    if (oldLogoKey) {
      await this.storage.deleteObject(oldLogoKey).catch(() => {});
    }
    return {
      id: updated.id,
      school_id: (updated as any).schoolId ?? null,
      school_name: updated.schoolName,
      description: updated.description,
      image_url: updated.imageUrl,
      upload_date: updated.createdAt.toISOString(),
    };
  }

  async remove(id: string, hard?: string) {
    const logo = await this.db.logo.findUnique({ where: { id } });
    if (!logo) {
      throw new BadRequestException('Logo not found');
    }
    const hardDelete = hard === 'true' || hard === '1';
    if (hardDelete) {
      await this.db.logo.delete({ where: { id } });
      if (logo.imageKey) {
        await this.storage.deleteObject(logo.imageKey).catch(() => {});
      }
    } else {
      await this.db.logo.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    }
    return { success: true };
  }
}
