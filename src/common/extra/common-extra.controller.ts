import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { Public } from '../../auth/decorators/public.decorator';
import { DatabaseService } from '../../database/database.service';
import { JwtAuthGuard } from '../../auth/jwt-auth/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PublicSchoolsQueryDto } from './dto/public-schools-query.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { StudentExtraController } from '../../student/extra/student-extra.controller';

interface PlaceholderResponse {
  endpoint: string;
  method: string;
  message: string;
}

@Controller()
@Public()
export class CommonExtraController {
  constructor(private readonly db: DatabaseService) {}

  private buildResponse(endpoint: string, method: string): PlaceholderResponse {
    return {
      endpoint,
      method,
      message:
        'This endpoint is implemented as a placeholder. Replace with real business logic as needed.',
    };
  }

  // Public success stories & logos

  @Get('success-stories')
  async publicSuccessStories(@Query('limit') limit?: string) {
    const take = limit
      ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100)
      : 50;
    const sections = await this.db.successStorySection.findMany({
      where: { isPublished: true },
      orderBy: { orderIndex: 'asc' },
      take,
    });
    return {
      sections: sections.map((s) => ({
        id: s.id,
        title: s.title,
        body_primary: s.bodyPrimary,
        body_secondary: s.bodySecondary,
        body_tertiary: s.bodyTertiary,
        image_url: s.imageUrl,
        storage_path: s.storagePath,
        background: s.background,
        image_position: s.imagePosition,
        order_index: s.orderIndex,
        is_published: s.isPublished,
        updated_at: s.updatedAt.toISOString(),
      })),
    };
  }

  @Get('api/logos')
  async publicLogosApi(@Query('limit') limit?: string) {
    const take = limit
      ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100)
      : 50;
    const logos = await this.db.logo.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return {
      logos: logos.map((l) => ({
        id: l.id,
        school_name: l.schoolName,
        description: l.description,
        image_url: l.imageUrl,
        upload_date: l.createdAt.toISOString(),
      })),
    };
  }

  @Get('api/schools')
  async publicSchoolsApi(@Query() query: PublicSchoolsQueryDto) {
    const take = query?.limit ?? 100;
    const q = String(query?.q ?? '').trim();
    const schools = await this.db.school.findMany({
      where: {
        isActive: true,
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { city: { contains: q, mode: 'insensitive' } },
                { state: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        schoolCode: true,
        city: true,
        state: true,
      },
      orderBy: { name: 'asc' },
      take,
    });
    return {
      schools: schools.map((s) => ({
        id: s.id,
        name: s.name,
        school_code: s.schoolCode,
        city: s.city,
        state: s.state,
      })),
    };
  }

  @Get('api/csrf-token')
  csrfToken() {
    // CSRF middleware is not enabled in this backend, but frontend expects this endpoint.
    return { csrfToken: 'not-required' };
  }

  // Contact form submission — saves to DB for admin review
  @Post('contact')
  async contact(
    @Body()
    body: {
      firstName?: string;
      lastName?: string;
      email?: string;
      areaCode?: string;
      phoneNumber?: string;
      purpose?: string;
      message?: string;
    },
  ) {
    const firstName = String(body.firstName ?? '').trim();
    const lastName = String(body.lastName ?? '').trim();
    const email = String(body.email ?? '').trim();
    const purpose = String(body.purpose ?? '').trim();
    const message = String(body.message ?? '').trim();

    if (!firstName || !lastName || !email || !purpose || !message) {
      throw new BadRequestException(
        'firstName, lastName, email, purpose, and message are required',
      );
    }

    await this.db.contactSubmission.create({
      data: {
        firstName,
        lastName,
        email,
        areaCode: String(body.areaCode ?? '+91').trim() || '+91',
        phoneNumber: String(body.phoneNumber ?? '').trim() || null,
        purpose,
        message,
        source: 'robocoders',
      },
    });

    return { success: true };
  }

  // Auth helpers / debug

  @Post('auth/track-login')
  async trackLogin(
    @Body()
    body: {
      user_id?: string;
      email?: string;
      success?: boolean;
      failure_reason?: string;
      ip_address?: string | null;
      user_agent?: string | null;
      action?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    const parsedUserId =
      typeof body.user_id === 'string' && body.user_id.trim()
        ? parseInt(body.user_id, 10)
        : undefined;
    const userId =
      typeof parsedUserId === 'number' && Number.isFinite(parsedUserId)
        ? parsedUserId
        : undefined;

    const created = await this.db.authActivity.create({
      data: {
        userId,
        email:
          typeof body.email === 'string' && body.email.trim()
            ? body.email.trim()
            : null,
        action:
          typeof body.action === 'string' && body.action.trim()
            ? body.action.trim()
            : 'login',
        success: Boolean(body.success),
        failureReason:
          typeof body.failure_reason === 'string' && body.failure_reason.trim()
            ? body.failure_reason.trim()
            : null,
        ipAddress:
          typeof body.ip_address === 'string' && body.ip_address.trim()
            ? body.ip_address.trim()
            : null,
        userAgent:
          typeof body.user_agent === 'string' && body.user_agent.trim()
            ? body.user_agent.trim()
            : null,
        metadata:
          body.metadata &&
          typeof body.metadata === 'object' &&
          !Array.isArray(body.metadata)
            ? (body.metadata as any)
            : undefined,
      },
    });

    return {
      success: true,
      activity: {
        id: created.id,
        user_id: created.userId ? String(created.userId) : null,
        email: created.email ?? null,
        action: created.action,
        success: created.success,
        failure_reason: created.failureReason ?? null,
        ip_address: created.ipAddress ?? null,
        user_agent: created.userAgent ?? null,
        created_at: created.createdAt.toISOString(),
      },
    };
  }

  @Get('auth/activity')
  @UseGuards(JwtAuthGuard)
  async getAuthActivity(
    @CurrentUser() user: { id: number; role?: string },
    @Query('limit') limit?: string,
    @Query('user_id') userId?: string,
  ) {
    const take = limit
      ? Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200)
      : 50;
    const targetUserId =
      typeof userId === 'string' && userId.trim()
        ? parseInt(userId, 10)
        : user.id;
    const isAdmin =
      String((user as { role?: string }).role ?? '').toLowerCase() === 'admin';
    const scopedUserId = isAdmin ? targetUserId : user.id;

    const rows = await this.db.authActivity.findMany({
      where: { userId: scopedUserId },
      orderBy: { createdAt: 'desc' },
      take,
    });

    return {
      activities: rows.map((r) => ({
        id: r.id,
        user_id: r.userId ? String(r.userId) : null,
        email: r.email ?? null,
        action: r.action,
        success: r.success,
        failure_reason: r.failureReason ?? null,
        ip_address: r.ipAddress ?? null,
        user_agent: r.userAgent ?? null,
        metadata: r.metadata ?? null,
        created_at: r.createdAt.toISOString(),
      })),
    };
  }

  @Post('auth/activity')
  @UseGuards(JwtAuthGuard)
  async createAuthActivity(
    @CurrentUser() user: { id: number },
    @Body()
    body: {
      action?: string;
      success?: boolean;
      failure_reason?: string;
      ip_address?: string | null;
      user_agent?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    const created = await this.db.authActivity.create({
      data: {
        userId: user.id,
        action:
          typeof body.action === 'string' && body.action.trim()
            ? body.action.trim()
            : 'activity',
        success: Boolean(body.success),
        failureReason:
          typeof body.failure_reason === 'string' && body.failure_reason.trim()
            ? body.failure_reason.trim()
            : null,
        ipAddress:
          typeof body.ip_address === 'string' && body.ip_address.trim()
            ? body.ip_address.trim()
            : null,
        userAgent:
          typeof body.user_agent === 'string' && body.user_agent.trim()
            ? body.user_agent.trim()
            : null,
        metadata:
          body.metadata &&
          typeof body.metadata === 'object' &&
          !Array.isArray(body.metadata)
            ? (body.metadata as any)
            : undefined,
      },
    });

    return {
      success: true,
      activity: {
        id: created.id,
        user_id: String(user.id),
        action: created.action,
        success: created.success,
        failure_reason: created.failureReason ?? null,
        ip_address: created.ipAddress ?? null,
        user_agent: created.userAgent ?? null,
        metadata: created.metadata ?? null,
        created_at: created.createdAt.toISOString(),
      },
    };
  }

  @Get('auth/redirect')
  authRedirect(@Query() _query: Record<string, string>): PlaceholderResponse {
    return this.buildResponse('/auth/redirect', 'GET');
  }

  // Cache / metrics / performance (frontend has implementations, this is just in case of proxy)

  @Get('metrics')
  metrics(): PlaceholderResponse {
    return this.buildResponse('/metrics', 'GET');
  }

  @Get('cache/status')
  cacheStatus(): PlaceholderResponse {
    return this.buildResponse('/cache/status', 'GET');
  }

  // Cron / test / certificates utilities

  // Test/debug endpoints

  // Misc helpers

  @Post('admin/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      // Set a high cap; we enforce tighter limits in code per upload `type`.
      limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
    }),
  )
  async adminUpload(
    @Body() body: Record<string, unknown>,
    @UploadedFile()
    file?: {
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    },
  ): Promise<{
    success: boolean;
    file: {
      url: string;
      path: string;
      filename: string;
      mime_type: string;
      size: number;
    };
  }> {
    if (!file) throw new BadRequestException('file is required');

    const type = String(body?.type ?? '').trim();
    if (!type) throw new BadRequestException('type is required');

    const courseId = String(body?.courseId ?? '').trim();
    const chapterId = String(body?.chapterId ?? '').trim();

    const maxBytesByType: Record<string, number> = {
      thumbnail: 5 * 1024 * 1024,
      material: 50 * 1024 * 1024,
      video: 100 * 1024 * 1024,
    };
    const maxBytes = maxBytesByType[type] ?? 50 * 1024 * 1024;

    if (file.size > maxBytes) {
      throw new BadRequestException(
        `Max file size for ${type} is ${Math.round(maxBytes / (1024 * 1024))}MB`,
      );
    }

    if (type === 'thumbnail' && !file.mimetype.startsWith('image/')) {
      throw new BadRequestException(
        'Only image files are allowed for thumbnails',
      );
    }

    // No external storage configured in this repo; store as data URL for now
    // (consistent with `/student/assignments/upload` and logo uploads).
    const base64 = file.buffer.toString('base64');
    const dataUrl = `data:${file.mimetype};base64,${base64}`;

    const safeCoursePart = courseId ? `course-${courseId}` : 'course-unknown';
    const safeChapterPart = chapterId
      ? `chapter-${chapterId}`
      : 'chapter-unknown';
    const filename = file.originalname || `upload-${Date.now()}`;
    const path = `uploads/${type}/${safeCoursePart}/${safeChapterPart}/${Date.now()}-${filename}`;

    return {
      success: true,
      file: {
        url: dataUrl,
        path,
        filename,
        mime_type: file.mimetype,
        size: file.size,
      },
    };
  }

  // ─── Public Certificate Verification (no auth required) ─────────────────────

  @Get('verify/:shortId')
  async verifyCertificate(@Param('shortId') shortId: string) {
    const clean = shortId.trim().toUpperCase();
    // Accept both "YM-XXXXXXXX" and raw 8-char codes
    const code = clean.startsWith('YM-') ? clean.slice(3) : clean;
    if (!/^[0-9A-F]{8}$/.test(code)) {
      throw new NotFoundException('Invalid certificate ID format');
    }

    // Find certificates whose UUID starts with this 8-char prefix
    const certs = await this.db.studentCertificate.findMany({
      where: { id: { startsWith: code.toLowerCase() } },
      include: {
        course: { select: { title: true } },
        student: {
          select: { email: true, profile: { select: { fullName: true } } },
        },
      },
      take: 2,
    });

    if (certs.length === 0) {
      throw new NotFoundException('Certificate not found');
    }
    if (certs.length > 1) {
      // Extremely unlikely but handled gracefully
      throw new BadRequestException(
        'Ambiguous certificate ID — please use the full ID',
      );
    }

    const cert = certs[0];
    const isActive = !cert.certificateUrl.startsWith('pending');

    return {
      valid: isActive,
      certificate: {
        id: cert.id,
        short_id: StudentExtraController.shortCertId(cert.id),
        student_name:
          cert.student?.profile?.fullName ?? cert.student?.email ?? 'Student',
        course_title: cert.course?.title ?? '',
        certificate_name: cert.certificateName,
        issued_at: cert.issuedAt.toISOString(),
        status: isActive ? 'active' : 'pending',
      },
    };
  }
}
