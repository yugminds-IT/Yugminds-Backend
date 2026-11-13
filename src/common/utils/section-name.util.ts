import { BadRequestException } from '@nestjs/common';

/**
 * The ONE section format stored everywhere: "Section A", "Section B", …
 * Never converted — a value in any other spelling ("A", "sec a", "SECTION A")
 * is rejected so bad data can't enter.
 */
export const STANDARD_SECTION = /^Section [A-Z0-9]+$/;

export const isStandardSection = (v: unknown): v is string =>
  typeof v === 'string' && STANDARD_SECTION.test(v);

/** Blank → null; the standard form → itself; anything else → 400. */
export function parseSection(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!STANDARD_SECTION.test(raw)) {
    throw new BadRequestException(
      `Invalid section "${raw}". Use the standard form, e.g. "Section A".`,
    );
  }
  return raw;
}
