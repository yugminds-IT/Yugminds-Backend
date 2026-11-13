import { BadRequestException } from '@nestjs/common';
import { isStandardSection, parseSection } from './section-name.util';

describe('parseSection', () => {
  it.each(['Section A', 'Section B', 'Section C2'])('accepts %s', (v) =>
    expect(parseSection(v)).toBe(v),
  );
  it.each([
    'A',
    'b',
    'section a',
    'SECTION A',
    'Sec A',
    'Section  A',
    'Section',
  ])('rejects %s', (v) =>
    expect(() => parseSection(v)).toThrow(BadRequestException),
  );
  it('blank / null → null', () => {
    expect(parseSection('')).toBeNull();
    expect(parseSection('  ')).toBeNull();
    expect(parseSection(null)).toBeNull();
    expect(parseSection(undefined)).toBeNull();
  });
  it('isStandardSection', () => {
    expect(isStandardSection('Section A')).toBe(true);
    expect(isStandardSection('A')).toBe(false);
    expect(isStandardSection(null)).toBe(false);
  });
});
