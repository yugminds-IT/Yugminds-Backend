import { randomInt } from 'node:crypto';

/**
 * Builds joining codes: YUG-<SCHOOL>-<GRADE>-<SECTION>-<RANDOM>
 * (e.g. "Green Valley Public School", "Grade 4", "Section A" -> YUG-GVPS-G4-A-7KQ4M2XD).
 * The readable prefix helps staff recognise a code; the random suffix is what
 * makes it a secret. A code gates anonymous account creation inside a school, so
 * it must not be derivable from the (public) school name and grade.
 * All three derive* functions are pure string transforms with no DB access,
 * so they're reused as-is by the school-creation flow and the manual
 * joining-codes admin flow, instead of duplicating this logic in both places.
 */

/** First letter of each word, alnum-only, uppercased, capped at 6 chars. */
export function deriveSchoolAbbreviation(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter((w) => w.length > 0);
  const abbr = words
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 6);
  return abbr || 'SCH';
}

/** "Grade 4" -> "G4", "Pre-K" -> "PK", "Kindergarten" -> "KG", else alnum-only capped at 4. */
export function deriveGradeAbbreviation(gradeName: string): string {
  const trimmed = gradeName.trim();
  const gradeMatch = /^grade\s*(\d+)$/i.exec(trimmed);
  if (gradeMatch) return `G${gradeMatch[1]}`;
  if (/^pre-?k$/i.test(trimmed)) return 'PK';
  if (/^kindergarten$/i.test(trimmed)) return 'KG';
  const fallback = trimmed
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 4);
  return fallback || 'GR';
}

/** "Section A" -> "A", else alnum-only capped at 4. */
export function deriveSectionAbbreviation(sectionName: string): string {
  const trimmed = sectionName.trim();
  const sectionMatch = /^section\s*(.+)$/i.exec(trimmed);
  const base = sectionMatch ? sectionMatch[1] : trimmed;
  const fallback = base
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 4);
  return fallback || 'A';
}

/** Unambiguous uppercase alphabet (no 0/O, 1/I/L): 31^8 ≈ 8.5e11 codes per prefix. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const JOIN_CODE_RANDOM_LENGTH = 8;

/** Cryptographically random suffix (never Math.random: codes are bearer secrets). */
export function randomJoinCodeSuffix(length = JOIN_CODE_RANDOM_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++)
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Assembles a fresh candidate; section segment omitted when not applicable. */
export function buildJoinCodeCandidate(
  schoolCode: string,
  gradeAbbr: string,
  sectionAbbr?: string | null,
): string {
  const parts = ['YUG', schoolCode, gradeAbbr];
  if (sectionAbbr) parts.push(sectionAbbr);
  parts.push(randomJoinCodeSuffix());
  return parts.join('-');
}
