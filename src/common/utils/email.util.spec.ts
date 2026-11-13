import { normalizeEmail } from './email.util';

describe('normalizeEmail', () => {
  it.each([
    ['A@B.com', 'a@b.com'],
    ['  Sw@Yugminds.ORG ', 'sw@yugminds.org'],
    ['x@y.com', 'x@y.com'],
  ])('%s -> %s', (i, o) => expect(normalizeEmail(i)).toBe(o));
  it('null/undefined -> empty', () => {
    expect(normalizeEmail(null)).toBe('');
    expect(normalizeEmail(undefined)).toBe('');
  });
});
