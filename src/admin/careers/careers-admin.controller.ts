import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { DatabaseService } from '../../database/database.service';
import { StorageService } from '../../common/storage/storage.service';
import { LeadAlertsService } from '../../common/lead-alerts/lead-alerts.service';
import { toResponses } from '../../common/careers/careers.form';
import { STAGES } from '../../common/careers/careers.validate';

const row = (a: any) => ({
  id: a.id,
  ref: a.refCode,
  role: a.opening?.title ?? null,
  full_name: a.fullName,
  email: a.email,
  phone: a.phone,
  city: a.city,
  stage: a.stage,
  rating: a.rating,
  experience_years: a.experienceYears,
  qualification: a.qualification,
  english_level: a.englishLevel,
  has_two_wheeler: a.hasTwoWheeler,
  will_travel: a.willTravel,
  skills: a.skills,
  updated_at: a.updatedAt?.toISOString(),
  created_at: a.createdAt.toISOString(),
});

@Controller('admin/careers')
@UseGuards(RolesGuard)
@Roles('admin')
export class CareersAdminController {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly mail: LeadAlertsService,
  ) {}

  @Get()
  async list(
    @Query('stage') stage?: string,
    @Query('search') search?: string,
    @Query('opening') opening?: string,
    @Query('city') city?: string,
    @Query('sort') sort?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Math.max(parseInt(limit ?? '20', 10) || 20, 1), 100);
    const pg = Math.max(parseInt(page ?? '1', 10) || 1, 1);
    const where: Record<string, unknown> = { deletedAt: null };
    if (stage && stage !== 'all') {
      if (!(STAGES as readonly string[]).includes(stage))
        throw new BadRequestException('Unknown stage');
      where.stage = stage;
    }
    if (opening) where.openingId = opening;
    if (city) where.city = city;
    const q = search?.trim();
    if (q)
      where.OR = [
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { refCode: { contains: q, mode: 'insensitive' } },
        { city: { contains: q, mode: 'insensitive' } },
      ];
    const [rows, total, grouped, cityRows] = await Promise.all([
      this.db.jobApplication.findMany({
        where,
        include: { opening: { select: { title: true } } },
        orderBy: { createdAt: sort === 'oldest' ? 'asc' : 'desc' },
        take,
        skip: (pg - 1) * take,
      }),
      this.db.jobApplication.count({ where }),
      this.db.jobApplication.groupBy({
        by: ['stage'],
        where: { deletedAt: null, ...(opening ? { openingId: opening } : {}) },
        _count: { stage: true },
      }),
      this.db.jobApplication.findMany({
        where: { deletedAt: null, ...(opening ? { openingId: opening } : {}) },
        select: { city: true },
        distinct: ['city'],
        orderBy: { city: 'asc' },
      }),
    ]);
    const counts: Record<string, number> = Object.fromEntries(
      STAGES.map((s) => [s, 0]),
    );
    for (const g of grouped) counts[g.stage] = g._count.stage;
    return {
      applications: rows.map(row),
      total,
      page: pg,
      limit: take,
      stage_counts: counts,
      cities: cityRows.map((c) => c.city).filter(Boolean),
    };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const a = await this.db.jobApplication.findFirst({
      where: { id, deletedAt: null },
      include: {
        opening: { select: { title: true } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!a) throw new NotFoundException('Application not found');
    return {
      ...row(a),
      will_travel: a.willTravel,
      college: a.college,
      grad_year: a.gradYear,
      current_status: a.currentStatus,
      skills: a.skills,
      grade_bands: a.gradeBands,
      english_level: a.englishLevel,
      has_two_wheeler: a.hasTwoWheeler,
      responses: toResponses(a.answers),
      expected_salary: a.expectedSalary,
      join_date: a.joinDate,
      heard_from: a.heardFrom,
      video_url: a.videoUrl,
      has_resume: !!a.resumeKey,
      resume_name: a.resumeName,
      events: a.events.map((e) => ({
        id: e.id,
        type: e.type,
        from_stage: e.fromStage,
        to_stage: e.toStage,
        body: e.body,
        created_at: e.createdAt.toISOString(),
      })),
    };
  }

  /** Streams the resume through the API so the bucket never needs CORS or public listing. */
  @Get(':id/resume')
  async resume(@Param('id') id: string, @Res() res: Response) {
    const a = await this.db.jobApplication.findFirst({
      where: { id, deletedAt: null },
    });
    if (!a?.resumeKey) throw new NotFoundException('No resume on file');
    const obj = await this.storage.getObject(a.resumeKey).catch(() => null);
    if (!obj) throw new NotFoundException('The resume file is missing');
    const { body, contentType } = obj;
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    // Names can hold non-ASCII letters; a raw header value would crash the response.
    const name = a.resumeName ?? 'resume';
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(body);
  }

  /** One endpoint for the three reviewer actions; each leaves a timeline event. */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body()
    body: {
      stage?: string;
      rating?: number | null;
      note?: string;
      notify?: boolean;
      message?: string;
    },
    @CurrentUser() user: { id: number },
  ) {
    const a = await this.db.jobApplication.findFirst({
      where: { id, deletedAt: null },
    });
    if (!a) throw new NotFoundException('Application not found');
    const data: Record<string, unknown> = {};
    const events: Record<string, unknown>[] = [];
    if (body.stage !== undefined && body.stage !== a.stage) {
      if (!(STAGES as readonly string[]).includes(body.stage))
        throw new BadRequestException('Unknown stage');
      data.stage = body.stage;
      events.push({
        type: 'stage_change',
        fromStage: a.stage,
        toStage: body.stage,
        actorId: user.id,
      });
    }
    if (body.rating !== undefined) {
      if (
        body.rating !== null &&
        !(Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5)
      )
        throw new BadRequestException('Rating must be 1 to 5');
      data.rating = body.rating;
    }
    const note = body.note?.trim();
    if (note) {
      if (note.length > 2000) throw new BadRequestException('Note is too long');
      events.push({ type: 'note', body: note, actorId: user.id });
    }
    const message = body.message?.trim();
    if (message && message.length > 600)
      throw new BadRequestException('Message is too long');
    await this.db.jobApplication.update({
      where: { id },
      data: {
        ...data,
        ...(events.length ? { events: { create: events as any } } : {}),
      },
    });
    let emailed = false;
    if (data.stage && body.notify !== false) {
      const op = await this.db.jobOpening.findUnique({
        where: { id: a.openingId },
        select: { title: true },
      });
      emailed = await this.mail.careerStage({
        stage: String(data.stage),
        name: a.fullName,
        email: a.email,
        role: op?.title ?? 'the role',
        ref: a.refCode,
        note: message,
      });
      if (emailed)
        await this.db.jobApplicationEvent.create({
          data: {
            applicationId: id,
            type: 'email',
            toStage: String(data.stage),
            actorId: user.id,
          },
        });
    }
    return { success: true, emailed };
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const a = await this.db.jobApplication.findFirst({
      where: { id, deletedAt: null },
    });
    if (!a) throw new NotFoundException('Application not found');
    await this.db.jobApplication.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { success: true };
  }

  /** Privacy request: erases the row and the resume file for good. */
  @Delete(':id/purge')
  async purge(@Param('id') id: string) {
    const a = await this.db.jobApplication.findFirst({ where: { id } });
    if (!a) throw new NotFoundException('Application not found');
    if (a.resumeKey)
      await this.storage.deleteObject(a.resumeKey).catch(() => undefined);
    await this.db.jobApplication.delete({ where: { id } });
    return { success: true };
  }
}
