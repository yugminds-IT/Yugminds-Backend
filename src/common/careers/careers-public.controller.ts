import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { randomInt } from 'crypto';
import { Public } from '../../auth/decorators/public.decorator';
import { DatabaseService } from '../../database/database.service';
import { StorageService } from '../storage/storage.service';
import { LeadAlertsService } from '../lead-alerts/lead-alerts.service';
import { checkResume, parseApplication } from './careers.validate';
import { resolveForm } from './careers.form';

const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newRef = () =>
  'YM-T-' +
  Array.from({ length: 5 }, () => REF_CHARS[randomInt(REF_CHARS.length)]).join(
    '',
  );

@Controller('careers')
@Public()
export class CareersPublicController {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly leadAlerts: LeadAlertsService,
  ) {}

  @Get('openings')
  async openings() {
    const rows = await this.db.jobOpening.findMany({
      where: { status: 'open' },
      orderBy: { createdAt: 'asc' },
    });
    return { openings: rows };
  }

  /** One role for its shareable page. Drafts stay hidden; paused/closed render a notice. */
  @Get('openings/:slug')
  async opening(@Param('slug') slug: string) {
    const o = await this.db.jobOpening.findFirst({
      where: { slug, status: { in: ['open', 'paused', 'closed'] } },
    });
    if (!o) throw new NotFoundException('Opening not found');
    return { ...o, form: resolveForm(o) };
  }

  /**
   * Applicant status check. POST so the email never lands in URLs or logs; needs the
   * reference AND the email it was sent with, and answers the same way for any miss.
   * Only public facts leave: stage changes and dates. Notes, ratings and on_hold stay private.
   */
  @Post('status')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async status(@Body() body: { ref?: string; email?: string }) {
    const ref = String(body.ref ?? '')
      .trim()
      .toUpperCase();
    const email = String(body.email ?? '')
      .trim()
      .toLowerCase();
    const a =
      ref && email
        ? await this.db.jobApplication.findFirst({
            where: { refCode: ref, email, deletedAt: null },
            include: {
              opening: { select: { title: true } },
              events: {
                where: { type: { in: ['submitted', 'stage_change'] } },
                orderBy: { createdAt: 'asc' },
              },
            },
          })
        : null;
    if (!a)
      throw new NotFoundException(
        'We could not find an application with those details. Check the reference and the email you applied with.',
      );
    const history = a.events
      .filter((e) => e.type === 'submitted' || e.toStage !== 'on_hold')
      .map((e) => ({
        stage: e.toStage ?? 'new',
        at: e.createdAt.toISOString(),
      }));
    // on_hold is an internal pause: show the last public stage instead.
    const stage =
      a.stage === 'on_hold' ? (history.at(-1)?.stage ?? 'new') : a.stage;
    return {
      ref: a.refCode,
      role: a.opening.title,
      applied_at: a.createdAt.toISOString(),
      stage,
      on_hold: a.stage === 'on_hold',
      updated_at: history.at(-1)?.at ?? a.updatedAt.toISOString(),
      history,
    };
  }

  /** Applicant closes their own application. Same ref+email proof as status; open stages only. */
  @Post('withdraw')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async withdraw(@Body() body: { ref?: string; email?: string }) {
    const ref = String(body.ref ?? '')
      .trim()
      .toUpperCase();
    const email = String(body.email ?? '')
      .trim()
      .toLowerCase();
    const a =
      ref && email
        ? await this.db.jobApplication.findFirst({
            where: { refCode: ref, email, deletedAt: null },
            include: { opening: { select: { title: true } } },
          })
        : null;
    if (!a) throw new NotFoundException('Application not found');
    if (['hired', 'rejected', 'withdrawn'].includes(a.stage))
      throw new ConflictException('This application is already closed');
    await this.db.jobApplication.update({
      where: { id: a.id },
      data: {
        stage: 'withdrawn',
        events: {
          create: {
            type: 'stage_change',
            fromStage: a.stage,
            toStage: 'withdrawn',
            body: 'Withdrawn by applicant',
          },
        },
      },
    });
    this.leadAlerts.careerWithdrawn({
      ref: a.refCode,
      name: a.fullName,
      role: a.opening.title,
    });
    return { success: true };
  }

  // Public + file upload: tight limit, signature-checked resume, one application per person per role.
  @Post('openings/:slug/apply')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseInterceptors(
    FileInterceptor('resume', {
      limits: { fileSize: 6 * 1024 * 1024, files: 1 },
    }),
  )
  async apply(
    @Param('slug') slug: string,
    @Body() body: { data?: string },
    @UploadedFile()
    file?: {
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    },
  ) {
    const opening = await this.db.jobOpening.findFirst({
      where: { slug, status: 'open' },
    });
    if (!opening) throw new NotFoundException('This role is not open');

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(String(body.data ?? ''));
    } catch {
      throw new BadRequestException('Invalid form data');
    }
    const form = resolveForm(opening);
    const data = parseApplication(raw, form);
    const ext = checkResume(file, form.resume);

    // One live application per person per role. After a rejection or withdrawal they may
    // apply again once the cooldown passes; that reuses the same record so history is kept.
    const prev = await this.db.jobApplication.findFirst({
      where: { openingId: opening.id, email: data.email },
    });
    if (prev) {
      // The wait is set per opening by the admin; 0 means they may apply straight away.
      const days =
        prev.stage === 'rejected'
          ? opening.rejectCooldownDays
          : prev.stage === 'withdrawn'
            ? opening.withdrawCooldownDays
            : null;
      if (days === null)
        throw new ConflictException(
          'You have already applied for this role with this email',
        );
      const closed = await this.db.jobApplicationEvent.findFirst({
        where: { applicationId: prev.id, toStage: prev.stage },
        orderBy: { createdAt: 'desc' },
      });
      const until = new Date(
        (closed?.createdAt ?? prev.updatedAt).getTime() + days * 86_400_000,
      );
      if (until > new Date())
        throw new ConflictException(
          `You can apply for this role again on ${until.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })}.`,
        );
    }

    // Content type comes from the verified signature, never from what the browser claimed.
    let key: string | null = null;
    if (ext && file) {
      const type = {
        pdf: 'application/pdf',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }[ext];
      key = this.storage.buildKey('careers', `resume.${ext}`);
      await this.storage.uploadBuffer(key, file.buffer, type, {
        contentDisposition: 'attachment',
      });
    }
    const refCode = prev?.refCode ?? newRef();
    try {
      const fields = {
        ...data,
        resumeKey: key,
        resumeName: ext
          ? `${data.fullName.replace(/[^\p{L}\p{N} ]/gu, '').trim() || 'resume'}.${ext}`
          : null,
      };
      if (prev)
        await this.db.jobApplication.update({
          where: { id: prev.id },
          data: {
            ...fields,
            stage: 'new',
            rating: null,
            deletedAt: null,
            createdAt: new Date(),
            events: {
              create: {
                type: 'submitted',
                toStage: 'new',
                body: 'Applied again',
              },
            },
          },
        });
      else
        await this.db.jobApplication.create({
          data: {
            ...fields,
            refCode,
            openingId: opening.id,
            events: { create: { type: 'submitted', toStage: 'new' } },
          },
        });
      if (prev?.resumeKey)
        await this.storage.deleteObject(prev.resumeKey).catch(() => undefined);
    } catch (e) {
      if (key) await this.storage.deleteObject(key).catch(() => undefined);
      if ((e as { code?: string }).code === 'P2002')
        throw new ConflictException(
          'You have already applied for this role with this email',
        );
      throw e;
    }
    this.leadAlerts.careerApplied({
      ref: refCode,
      name: data.fullName,
      email: data.email,
      phone: data.phone,
      city: data.city,
      role: opening.title,
    });
    return { success: true, ref: refCode };
  }
}
