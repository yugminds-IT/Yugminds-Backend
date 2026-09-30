const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_PART_RE = /^[^\s@]{1,64}$/;

/**
 * Normalizes an optional email domain ("  @SNT.edu.in " → "snt.edu.in").
 * Returns null when blank; throws when present but not a valid hostname.
 */
export function normalizeEmailDomain(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const domain = String(raw).trim().toLowerCase().replace(/^@/, '');
  if (!domain) return null;
  if (!DOMAIN_RE.test(domain)) {
    throw new Error(`Invalid email domain "${domain}" (expected something like school.edu.in)`);
  }
  return domain;
}

/**
 * Applies a required domain to an email: a bare local part ("ravi") gets the
 * domain appended; a full address must already use that domain.
 */
export function applyEmailDomain(
  email: string,
  domain: string,
): { email: string } | { error: string } {
  const at = email.lastIndexOf('@');
  const local = at === -1 ? email : email.slice(0, at);
  if (!LOCAL_PART_RE.test(local)) return { error: 'Invalid email address' };
  if (at !== -1 && email.slice(at + 1) !== domain) {
    return { error: `Email must use @${domain}` };
  }
  return { email: `${local}@${domain}` };
}
