import { BadRequestException } from '@nestjs/common';

/**
 * The ONE stored form of a phone number: "+<country><digits>", no spaces.
 * Indian numbers are "+91XXXXXXXXXX". Blank / "-" / anything with no digits
 * means "no phone" and is stored as null.
 *
 * Accepted input (everything else → 400):
 *   9876543210 · 09876543210 · 919876543210 · +91 98765 43210 · (+91) 98765-43210
 *   +<8–15 digits>  (international, kept as typed minus separators)
 */
export function parsePhone(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!/\d/.test(raw)) return null;
  const compact = raw.replace(/[\s\-().]/g, '');
  const bad = () =>
    new BadRequestException(
      `Invalid phone "${raw}". Use the standard form, e.g. "+919876543210".`,
    );
  if (!/^\+?\d+$/.test(compact)) throw bad();

  if (compact.startsWith('+')) {
    if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
    throw bad();
  }
  if (/^[1-9]\d{9}$/.test(compact)) return `+91${compact}`;
  if (/^0\d{10}$/.test(compact)) return `+91${compact.slice(1)}`;
  if (/^91[1-9]\d{9}$/.test(compact)) return `+${compact}`;
  throw bad();
}
