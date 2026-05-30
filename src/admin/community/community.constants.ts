export const COMMUNITY_SECTION_TYPES = [
  'reel',
  'profile',
  'project',
  'learn_video',
  'challenge',
  'blog',
] as const;

export type CommunitySectionType = (typeof COMMUNITY_SECTION_TYPES)[number];

export const DEFAULT_COMMUNITY_CONFIG = {
  hero_title: 'Yugminds Community',
  hero_subtitle:
    'Discover how our students are building the future, one project at a time',
  hero_image_url: null as string | null,
  section_titles: {
    reels: 'Watch Yugminds Impact',
    profiles: 'Active Profiles',
    projects: 'Yugminds Projects',
    learn_videos: 'Explore, Learn, and Build with Us',
    challenges: 'Yugminds Challenges',
    blogs: 'Recent Blogs',
  },
  section_enabled: {
    reels: true,
    profiles: true,
    projects: true,
    learn_videos: true,
    challenges: true,
    blogs: true,
  },
  impact_stats: [
    { value: '10+', label: 'Competition Winners', icon: 'trophy' },
    { value: '500+', label: 'Certified Students', icon: 'award' },
    { value: '100%', label: 'Parent Satisfaction', icon: 'star' },
  ],
  social_links: [
    { platform: 'youtube', label: 'YouTube', url: '' },
    { platform: 'facebook', label: 'Facebook', url: '' },
    { platform: 'linkedin', label: 'LinkedIn', url: '' },
    { platform: 'instagram', label: 'Instagram', url: '' },
    { platform: 'whatsapp', label: 'WhatsApp', url: '' },
  ],
  corner_pillars: [
    {
      title: 'Share a Story',
      description: 'Tell us about your learning journey',
      image_url: null,
      link_url: '/contact',
    },
    {
      title: 'Make a Project',
      description: 'Showcase your STEM creations',
      image_url: null,
      link_url: '/programs',
    },
    {
      title: 'Learn a Skill',
      description: 'Explore courses and tutorials',
      image_url: null,
      link_url: '/programs',
    },
  ],
};

export const ALLOWED_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
  'video/quicktime',
];

export function mediaMaxSize(mimetype: string): number {
  return mimetype.startsWith('video/') ? 100 * 1024 * 1024 : 5 * 1024 * 1024;
}

export function fileToDataUrl(file: {
  mimetype: string;
  buffer: Buffer;
}): string {
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}
