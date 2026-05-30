import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { DatabaseService } from '../../database/database.service';
import {
  ALLOWED_MEDIA_TYPES,
  COMMUNITY_SECTION_TYPES,
  CommunitySectionType,
  DEFAULT_COMMUNITY_CONFIG,
  fileToDataUrl,
  mediaMaxSize,
} from './community.constants';
import {
  itemSnapshot,
  mapCommunityConfig,
  mapCommunityItem,
} from './community.mapper';

@Controller('admin/community')
@UseGuards(RolesGuard)
@Roles('admin')
export class CommunityAdminController {
  constructor(private readonly db: DatabaseService) {}

  private async ensureConfig() {
    let config = await this.db.communityPageConfig.findUnique({
      where: { id: 'default' },
    });
    if (!config) {
      config = await this.db.communityPageConfig.create({
        data: {
          id: 'default',
          heroTitle: DEFAULT_COMMUNITY_CONFIG.hero_title,
          heroSubtitle: DEFAULT_COMMUNITY_CONFIG.hero_subtitle,
          sectionTitles: DEFAULT_COMMUNITY_CONFIG.section_titles,
          sectionEnabled: DEFAULT_COMMUNITY_CONFIG.section_enabled,
          impactStats: DEFAULT_COMMUNITY_CONFIG.impact_stats,
          socialLinks: DEFAULT_COMMUNITY_CONFIG.social_links,
          cornerPillars: DEFAULT_COMMUNITY_CONFIG.corner_pillars,
        },
      });
    }
    return config;
  }

  private validateMedia(file: any, optional = false) {
    if (!file) {
      if (optional) return null;
      throw new BadRequestException('media file is required');
    }
    if (!ALLOWED_MEDIA_TYPES.includes(file.mimetype)) {
      throw new BadRequestException('Unsupported media type');
    }
    const max = mediaMaxSize(file.mimetype);
    if (file.size > max) {
      throw new BadRequestException(
        `File too large (max ${file.mimetype.startsWith('video/') ? '100MB' : '5MB'})`,
      );
    }
    return fileToDataUrl(file);
  }

  private parseSectionType(raw?: string): CommunitySectionType {
    const t = (raw ?? '').trim() as CommunitySectionType;
    if (!COMMUNITY_SECTION_TYPES.includes(t)) {
      throw new BadRequestException(
        `section_type must be one of: ${COMMUNITY_SECTION_TYPES.join(', ')}`,
      );
    }
    return t;
  }

  private parseJsonField(raw: string | undefined, fallback: unknown) {
    if (raw === undefined || raw === '') return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      throw new BadRequestException('Invalid JSON field');
    }
  }

  @Get('config')
  async getConfig() {
    const config = await this.ensureConfig();
    return { config: mapCommunityConfig(config) };
  }

  @Put('config')
  @UseInterceptors(FileInterceptor('hero_image'))
  async updateConfig(
    @UploadedFile() heroFile: any,
    @Body()
    body: {
      hero_title?: string;
      hero_subtitle?: string;
      section_titles?: string;
      section_enabled?: string;
      section_colors?: string;
      impact_stats?: string;
      social_links?: string;
      corner_pillars?: string;
    },
  ) {
    const existing = await this.ensureConfig();
    let heroImageUrl = existing.heroImageUrl;
    if (heroFile) {
      heroImageUrl = this.validateMedia(heroFile, true);
    }

    const updated = await this.db.communityPageConfig.update({
      where: { id: 'default' },
      data: {
        heroTitle:
          body.hero_title !== undefined
            ? body.hero_title.trim()
            : existing.heroTitle,
        heroSubtitle:
          body.hero_subtitle !== undefined
            ? body.hero_subtitle.trim() || null
            : existing.heroSubtitle,
        heroImageUrl,
        sectionTitles:
          body.section_titles !== undefined
            ? this.parseJsonField(body.section_titles, {})
            : existing.sectionTitles,
        sectionEnabled:
          body.section_enabled !== undefined
            ? this.parseJsonField(body.section_enabled, {})
            : existing.sectionEnabled,
        sectionColors:
          body.section_colors !== undefined
            ? this.parseJsonField(body.section_colors, {})
            : existing.sectionColors,
        impactStats:
          body.impact_stats !== undefined
            ? this.parseJsonField(body.impact_stats, [])
            : existing.impactStats,
        socialLinks:
          body.social_links !== undefined
            ? this.parseJsonField(body.social_links, [])
            : existing.socialLinks,
        cornerPillars:
          body.corner_pillars !== undefined
            ? this.parseJsonField(body.corner_pillars, [])
            : existing.cornerPillars,
      },
    });

    return { config: mapCommunityConfig(updated) };
  }

  @Get('items')
  async listItems(
    @Query('type') type?: string,
    @Query('published') published?: string,
  ) {
    const where: { sectionType?: string; isPublished?: boolean } = {};
    if (type) where.sectionType = this.parseSectionType(type);
    if (published === 'true' || published === '1') where.isPublished = true;
    if (published === 'false' || published === '0') where.isPublished = false;

    const items = await this.db.communityItem.findMany({
      where,
      orderBy: [{ orderIndex: 'asc' }, { updatedAt: 'desc' }],
    });
    return { items: items.map(mapCommunityItem) };
  }

  @Get('items/:id')
  async getItem(@Param('id') id: string) {
    const item = await this.db.communityItem.findUnique({ where: { id } });
    if (!item) throw new BadRequestException('Item not found');
    return { item: mapCommunityItem(item) };
  }

  @Post('items')
  @UseInterceptors(FileInterceptor('media'))
  async createItem(
    @UploadedFile() mediaFile: any,
    @Body()
    body: {
      section_type?: string;
      title?: string;
      subtitle?: string;
      description?: string;
      creator_name?: string;
      creator_avatar_url?: string;
      external_url?: string;
      cta_label?: string;
      cta_url?: string;
      likes?: string;
      views?: string;
      metadata?: string;
      order_index?: string;
      is_published?: string;
      is_featured?: string;
    },
  ) {
    const sectionType = this.parseSectionType(body.section_type);
    const title = (body.title ?? '').trim();
    if (!title) throw new BadRequestException('title is required');

    const needsMedia = ['reel', 'project', 'learn_video', 'blog'].includes(
      sectionType,
    );
    let mediaUrl: string | null = null;
    if (mediaFile) {
      mediaUrl = this.validateMedia(mediaFile, true);
    }
    const hasExternalUrl = !!body.external_url?.trim();
    if (needsMedia && !mediaUrl && !hasExternalUrl) {
      throw new BadRequestException(
        'media or external URL is required for this section type',
      );
    }

    const orderIndex = Math.max(parseInt(body.order_index ?? '0', 10) || 0, 0);
    const isPublished =
      body.is_published === 'true' || body.is_published === '1';
    const isFeatured = body.is_featured === 'true' || body.is_featured === '1';

    const item = await this.db.communityItem.create({
      data: {
        sectionType,
        title,
        subtitle: body.subtitle?.trim() || null,
        description: body.description?.trim() || null,
        mediaUrl,
        thumbnailUrl: null,
        creatorName: body.creator_name?.trim() || null,
        creatorAvatarUrl: body.creator_avatar_url?.trim() || null,
        externalUrl: body.external_url?.trim() || null,
        ctaLabel: body.cta_label?.trim() || null,
        ctaUrl: body.cta_url?.trim() || null,
        likes: Math.max(parseInt(body.likes ?? '0', 10) || 0, 0),
        views: Math.max(parseInt(body.views ?? '0', 10) || 0, 0),
        metadata: body.metadata
          ? this.parseJsonField(body.metadata, {})
          : undefined,
        orderIndex,
        isPublished,
        isFeatured,
      },
    });

    await this.db.communityItemVersion.create({
      data: {
        itemId: item.id,
        versionNumber: 1,
        snapshot: itemSnapshot(item),
      },
    });

    return { item: mapCommunityItem(item) };
  }

  @Put('items/:id')
  @UseInterceptors(FileInterceptor('media'))
  updateItem(
    @Param('id') id: string,
    @UploadedFile() mediaFile: any,
    @Body()
    body: {
      section_type?: string;
      title?: string;
      subtitle?: string;
      description?: string;
      creator_name?: string;
      creator_avatar_url?: string;
      external_url?: string;
      cta_label?: string;
      cta_url?: string;
      likes?: string;
      views?: string;
      metadata?: string;
      order_index?: string;
      is_published?: string;
      is_featured?: string;
    },
  ) {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.communityItem.findUnique({ where: { id } });
      if (!existing) throw new BadRequestException('Item not found');

      let mediaUrl = existing.mediaUrl;
      if (mediaFile) {
        mediaUrl = this.validateMedia(mediaFile, true);
      }

      const sectionType = body.section_type
        ? this.parseSectionType(body.section_type)
        : (existing.sectionType as CommunitySectionType);

      const updated = await tx.communityItem.update({
        where: { id },
        data: {
          sectionType,
          title: body.title !== undefined ? body.title.trim() : existing.title,
          subtitle:
            body.subtitle !== undefined
              ? body.subtitle.trim() || null
              : existing.subtitle,
          description:
            body.description !== undefined
              ? body.description.trim() || null
              : existing.description,
          mediaUrl,
          creatorName:
            body.creator_name !== undefined
              ? body.creator_name.trim() || null
              : existing.creatorName,
          creatorAvatarUrl:
            body.creator_avatar_url !== undefined
              ? body.creator_avatar_url.trim() || null
              : existing.creatorAvatarUrl,
          externalUrl:
            body.external_url !== undefined
              ? body.external_url.trim() || null
              : existing.externalUrl,
          ctaLabel:
            body.cta_label !== undefined
              ? body.cta_label.trim() || null
              : existing.ctaLabel,
          ctaUrl:
            body.cta_url !== undefined
              ? body.cta_url.trim() || null
              : existing.ctaUrl,
          likes:
            body.likes !== undefined
              ? Math.max(parseInt(body.likes, 10) || 0, 0)
              : existing.likes,
          views:
            body.views !== undefined
              ? Math.max(parseInt(body.views, 10) || 0, 0)
              : existing.views,
          metadata:
            body.metadata !== undefined
              ? this.parseJsonField(body.metadata, {})
              : existing.metadata,
          orderIndex:
            body.order_index !== undefined
              ? Math.max(parseInt(body.order_index, 10) || 0, 0)
              : existing.orderIndex,
          isPublished:
            body.is_published !== undefined
              ? body.is_published === 'true' || body.is_published === '1'
              : existing.isPublished,
          isFeatured:
            body.is_featured !== undefined
              ? body.is_featured === 'true' || body.is_featured === '1'
              : existing.isFeatured,
        },
      });

      const max = await tx.communityItemVersion.aggregate({
        where: { itemId: id },
        _max: { versionNumber: true },
      });
      await tx.communityItemVersion.create({
        data: {
          itemId: id,
          versionNumber: (max._max.versionNumber ?? 0) + 1,
          snapshot: itemSnapshot(updated),
        },
      });

      return { item: mapCommunityItem(updated) };
    });
  }

  @Post('items/:id/thumbnail')
  @UseInterceptors(FileInterceptor('thumbnail'))
  async uploadThumbnail(@Param('id') id: string, @UploadedFile() file: any) {
    const thumbnailUrl = this.validateMedia(file);
    const updated = await this.db.communityItem.update({
      where: { id },
      data: { thumbnailUrl },
    });
    return { item: mapCommunityItem(updated) };
  }

  @Post('items/:id/avatar')
  @UseInterceptors(FileInterceptor('avatar'))
  async uploadAvatar(@Param('id') id: string, @UploadedFile() file: any) {
    const creatorAvatarUrl = this.validateMedia(file);
    const updated = await this.db.communityItem.update({
      where: { id },
      data: { creatorAvatarUrl },
    });
    return { item: mapCommunityItem(updated) };
  }

  @Delete('items/:id')
  async deleteItem(@Param('id') id: string) {
    await this.db.communityItem
      .delete({ where: { id } })
      .catch((e: { code?: string }) => {
        if (e?.code === 'P2025')
          throw new BadRequestException('Item not found');
        throw e;
      });
    return { success: true };
  }

  @Get('items/:id/versions')
  async listVersions(@Param('id') id: string) {
    const versions = await this.db.communityItemVersion.findMany({
      where: { itemId: id },
      orderBy: { versionNumber: 'desc' },
      take: 50,
    });
    return {
      versions: versions.map((v) => ({
        id: v.id,
        version_number: v.versionNumber,
        created_at: v.createdAt.toISOString(),
      })),
    };
  }

  @Post('items/:id/revert')
  async revertItem(
    @Param('id') id: string,
    @Body() body: { version_id?: string },
  ) {
    const versionId = (body?.version_id ?? '').trim();
    if (!versionId) throw new BadRequestException('version_id is required');

    return this.db.$transaction(async (tx) => {
      const version = await tx.communityItemVersion.findFirst({
        where: { id: versionId, itemId: id },
      });
      if (!version) throw new BadRequestException('Version not found');

      const snap = version.snapshot as Record<string, unknown>;
      const updated = await tx.communityItem.update({
        where: { id },
        data: {
          sectionType: String(snap.section_type ?? 'project'),
          title: String(snap.title ?? '').trim(),
          subtitle: snap.subtitle != null ? String(snap.subtitle) : null,
          description:
            snap.description != null ? String(snap.description) : null,
          mediaUrl: snap.media_url != null ? String(snap.media_url) : null,
          thumbnailUrl:
            snap.thumbnail_url != null ? String(snap.thumbnail_url) : null,
          creatorName:
            snap.creator_name != null ? String(snap.creator_name) : null,
          creatorAvatarUrl:
            snap.creator_avatar_url != null
              ? String(snap.creator_avatar_url)
              : null,
          externalUrl:
            snap.external_url != null ? String(snap.external_url) : null,
          ctaLabel: snap.cta_label != null ? String(snap.cta_label) : null,
          ctaUrl: snap.cta_url != null ? String(snap.cta_url) : null,
          likes: Number(snap.likes) || 0,
          views: Number(snap.views) || 0,
          metadata: (snap.metadata as object) ?? undefined,
          orderIndex: Number(snap.order_index) || 0,
          isPublished: !!snap.is_published,
          isFeatured: !!snap.is_featured,
        },
      });

      const max = await tx.communityItemVersion.aggregate({
        where: { itemId: id },
        _max: { versionNumber: true },
      });
      await tx.communityItemVersion.create({
        data: {
          itemId: id,
          versionNumber: (max._max.versionNumber ?? 0) + 1,
          snapshot: itemSnapshot(updated),
        },
      });

      return { success: true, item: mapCommunityItem(updated) };
    });
  }

  @Post('migrate-success-stories')
  async migrateSuccessStories() {
    const stories = await this.db.successStorySection.findMany({
      orderBy: { orderIndex: 'asc' },
    });
    if (stories.length === 0) {
      return { migrated: 0, message: 'No success stories to migrate' };
    }

    const existing = await this.db.communityItem.count();
    if (existing > 0) {
      return {
        migrated: 0,
        message: 'Community items already exist; migration skipped',
      };
    }

    let migrated = 0;
    for (const s of stories) {
      const isVideo = Boolean(
        (s.storagePath &&
          /\.(mp4|webm|mov|m4v|ogg|ogv)$/i.test(s.storagePath)) ||
        (s.imageUrl &&
          /\.(mp4|webm|mov|m4v|ogg|ogv)(\?.*)?$/i.test(s.imageUrl)),
      );
      await this.db.communityItem.create({
        data: {
          sectionType: isVideo ? 'reel' : 'project',
          title: s.title,
          description: s.bodyPrimary,
          mediaUrl: s.imageUrl,
          orderIndex: s.orderIndex,
          isPublished: s.isPublished,
          metadata: {
            migrated_from: 'success_story',
            legacy_id: s.id,
            body_secondary: s.bodySecondary,
            body_tertiary: s.bodyTertiary,
          },
        },
      });
      migrated++;
    }

    await this.ensureConfig();
    return { migrated, message: `Migrated ${migrated} success stories` };
  }
}
