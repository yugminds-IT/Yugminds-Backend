import { BadRequestException } from '@nestjs/common';

export function validatePasswordStrength(password: string): void {
  if (!password || password.length < 8) {
    throw new BadRequestException(
      'Password must be at least 8 characters long',
    );
  }
  if (!/[A-Z]/.test(password)) {
    throw new BadRequestException(
      'Password must contain at least one uppercase letter',
    );
  }
  if (!/[a-z]/.test(password)) {
    throw new BadRequestException(
      'Password must contain at least one lowercase letter',
    );
  }
  if (!/[0-9]/.test(password)) {
    throw new BadRequestException('Password must contain at least one number');
  }
}

/**
 * Derives a human-readable initial password from a student's first name,
 * e.g. "Aarav Sharma" -> "Aarav@4821" — easy for a school to hand out and
 * for a student to type on first login. Always clears
 * validatePasswordStrength (8+ chars, upper/lower/digit) regardless of name
 * length by padding the digit count for short names. No uniqueness needed
 * across students — only email has to be unique, not password.
 */
export function deriveFriendlyPassword(fullName: string | undefined | null): string {
  const cleaned = (fullName ?? '').trim().split(/\s+/)[0]?.replace(/[^a-zA-Z]/g, '') ?? '';
  // A single-letter name can't carry both an uppercase and a lowercase
  // letter, so fall back to a name that can.
  const firstNameRaw = cleaned.length >= 2 ? cleaned : 'Student';
  const capitalized = firstNameRaw[0].toUpperCase() + firstNameRaw.slice(1).toLowerCase();
  const digitCount = Math.max(4, 8 - (capitalized.length + 1)); // +1 for '@'
  const digits = Array.from({ length: digitCount }, () => Math.floor(Math.random() * 10)).join('');
  return `${capitalized}@${digits}`;
}
