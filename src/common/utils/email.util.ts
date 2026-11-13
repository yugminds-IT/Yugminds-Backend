/** The ONE stored form of a login email: trimmed + lowercase. */
export const normalizeEmail = (v: unknown): string =>
  String(v ?? '')
    .trim()
    .toLowerCase();

/** class-transformer helper so DTO validation sees the normalized email. */
export const emailTransform = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? normalizeEmail(value) : value;
