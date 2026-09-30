import { applyEmailDomain, normalizeEmailDomain } from './email-domain.util';

describe('normalizeEmailDomain', () => {
  it('returns null for blank input', () => {
    expect(normalizeEmailDomain(undefined)).toBeNull();
    expect(normalizeEmailDomain(null)).toBeNull();
    expect(normalizeEmailDomain('   ')).toBeNull();
  });

  it('trims, lowercases and strips a leading @', () => {
    expect(normalizeEmailDomain('  @SNT.edu.in ')).toBe('snt.edu.in');
    expect(normalizeEmailDomain('snthighschool.com')).toBe('snthighschool.com');
  });

  it.each(['snt', 'snt..edu', '-snt.edu', 'snt.edu-', 'a@b.com', 'snt edu.in', 'snt.c'])(
    'rejects %s',
    (bad) => {
      expect(() => normalizeEmailDomain(bad)).toThrow(/Invalid email domain/);
    },
  );
});

describe('applyEmailDomain', () => {
  it('appends the domain to a bare local part', () => {
    expect(applyEmailDomain('ravi', 'snt.edu.in')).toEqual({ email: 'ravi@snt.edu.in' });
  });

  it('keeps emails already on the domain', () => {
    expect(applyEmailDomain('ravi@snt.edu.in', 'snt.edu.in')).toEqual({ email: 'ravi@snt.edu.in' });
  });

  it.each(['ravi smith', '@snt.edu.in', 'a@b@snt.edu.in'])('rejects malformed %s', (bad) => {
    expect(applyEmailDomain(bad, 'snt.edu.in')).toEqual({ error: 'Invalid email address' });
  });

  it('rejects emails on another domain', () => {
    expect(applyEmailDomain('ravi@gmail.com', 'snt.edu.in')).toEqual({
      error: 'Email must use @snt.edu.in',
    });
  });
});
