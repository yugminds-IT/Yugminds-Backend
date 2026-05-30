import type { CommunityItem, CommunityPageConfig } from '@prisma/client';

export function mapCommunityConfig(c: CommunityPageConfig) {
  return {
    hero_title: c.heroTitle,
    hero_subtitle: c.heroSubtitle,
    hero_image_url: c.heroImageUrl,
    section_titles: c.sectionTitles ?? {},
    section_enabled: c.sectionEnabled ?? {},
    section_colors: c.sectionColors ?? {},
    impact_stats: c.impactStats ?? [],
    social_links: c.socialLinks ?? [],
    corner_pillars: c.cornerPillars ?? [],
    updated_at: c.updatedAt.toISOString(),
  };
}

export function mapCommunityItem(i: CommunityItem) {
  return {
    id: i.id,
    section_type: i.sectionType,
    title: i.title,
    subtitle: i.subtitle,
    description: i.description,
    media_url: i.mediaUrl,
    thumbnail_url: i.thumbnailUrl,
    creator_name: i.creatorName,
    creator_avatar_url: i.creatorAvatarUrl,
    external_url: i.externalUrl,
    cta_label: i.ctaLabel,
    cta_url: i.ctaUrl,
    likes: i.likes,
    views: i.views,
    metadata: i.metadata ?? {},
    order_index: i.orderIndex,
    is_published: i.isPublished,
    is_featured: i.isFeatured,
    updated_at: i.updatedAt.toISOString(),
  };
}

export function itemSnapshot(i: CommunityItem) {
  return {
    section_type: i.sectionType,
    title: i.title,
    subtitle: i.subtitle,
    description: i.description,
    media_url: i.mediaUrl,
    thumbnail_url: i.thumbnailUrl,
    creator_name: i.creatorName,
    creator_avatar_url: i.creatorAvatarUrl,
    external_url: i.externalUrl,
    cta_label: i.ctaLabel,
    cta_url: i.ctaUrl,
    likes: i.likes,
    views: i.views,
    metadata: i.metadata,
    order_index: i.orderIndex,
    is_published: i.isPublished,
    is_featured: i.isFeatured,
  };
}
