/** Frontend hosts (one Next.js app serving all three brands) — always allowed, whatever ALLOWED_ORIGINS says. */
const BRAND_ORIGINS = [
  'https://yugminds.org',
  'https://www.yugminds.org',
  'https://robocoders.yugminds.org',
  'https://lms.yugminds.org',
];

/** CORS origins: ALLOWED_ORIGINS (comma-separated, e.g. localhost/previews) plus the brand hosts. */
export function getAllowedOrigins(): string[] {
  const fromEnv = process.env.ALLOWED_ORIGINS?.split(',')
    .map((o) => o.trim())
    .filter(Boolean) ?? ['http://localhost:3000'];
  return [...new Set([...fromEnv, ...BRAND_ORIGINS])];
}
