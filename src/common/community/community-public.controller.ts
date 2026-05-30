import { Controller, Get } from '@nestjs/common';
import { Public } from '../../auth/decorators/public.decorator';
import { DatabaseService } from '../../database/database.service';
import { DEFAULT_COMMUNITY_CONFIG } from '../../admin/community/community.constants';
import {
  mapCommunityConfig,
  mapCommunityItem,
} from '../../admin/community/community.mapper';

@Controller()
@Public()
export class CommunityPublicController {
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

  @Get('community')
  async getCommunityPage() {
    const config = await this.ensureConfig();
    const items = await this.db.communityItem.findMany({
      where: { isPublished: true },
      orderBy: [{ orderIndex: 'asc' }, { updatedAt: 'desc' }],
    });

    const mapped = items.map(mapCommunityItem);
    const byType = (type: string) =>
      mapped.filter((i) => i.section_type === type);

    return {
      config: mapCommunityConfig(config),
      items: {
        reels: byType('reel'),
        profiles: byType('profile'),
        projects: byType('project'),
        learn_videos: byType('learn_video'),
        challenges: byType('challenge'),
        blogs: byType('blog'),
      },
    };
  }
}
