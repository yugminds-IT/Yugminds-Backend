import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { DatabaseService } from '../../database/database.service';
import { parseOpening, slugify } from '../../common/careers/careers.validate';
import { LIBRARY, PRESETS } from '../../common/careers/careers.form';

const out = ({ _count, ...o }: any) => ({
  ...o,
  applications: _count?.applications ?? 0,
});

@Controller('admin/job-openings')
@UseGuards(RolesGuard)
@Roles('admin')
export class OpeningsAdminController {
  constructor(private readonly db: DatabaseService) {}

  /** One source for the builder: standard questions and starting forms. */
  @Get('form-meta')
  formMeta() {
    return { library: LIBRARY, presets: PRESETS };
  }

  @Get()
  async list() {
    const rows = await this.db.jobOpening.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { applications: { where: { deletedAt: null } } } },
      },
    });
    const g = await this.db.jobApplication.groupBy({
      by: ['openingId', 'stage'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const stages = new Map<string, Record<string, number>>();
    for (const x of g)
      stages.set(x.openingId, {
        ...stages.get(x.openingId),
        [x.stage]: x._count._all,
      });
    return {
      openings: rows.map((r) => {
        const st = stages.get(r.id) ?? {};
        return {
          ...out(r),
          hired: st.hired ?? 0,
          newCount: st.new ?? 0,
          stages: st,
        };
      }),
    };
  }

  @Post()
  async create(@Body() body: Record<string, unknown>) {
    const data = parseOpening({ status: 'draft', ...body });
    const base = slugify(String(data.title));
    let slug = base;
    for (
      let i = 2;
      await this.db.jobOpening.findUnique({ where: { slug } });
      i++
    )
      slug = `${base}-${i}`;
    const row = await this.db.jobOpening.create({
      data: { ...data, slug } as any,
    });
    return out(row);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    if (!(await this.db.jobOpening.findUnique({ where: { id } })))
      throw new NotFoundException('Opening not found');
    const row = await this.db.jobOpening.update({
      where: { id },
      data: parseOpening(body, true) as any,
    });
    return out(row);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const n = await this.db.jobApplication.count({ where: { openingId: id } });
    if (n > 0)
      throw new ConflictException(
        'This role has applications. Close it instead of deleting it.',
      );
    await this.db.jobOpening.delete({ where: { id } });
    return { ok: true };
  }
}
