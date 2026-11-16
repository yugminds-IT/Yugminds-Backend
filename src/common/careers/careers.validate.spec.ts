import {
  checkResume,
  parseApplication,
  parseOpening,
  slugify,
} from './careers.validate';

const ok = {
  fullName: 'Ravi Kumar',
  email: ' Ravi@Mail.com ',
  phone: '98765 43210',
  city: 'Hyderabad',
  qualification: 'B.Tech',
  currentStatus: 'fresher',
  englishLevel: 4,
  why: 'x',
  explain: 'y',
  skills: ['Python'],
  gradeBands: ['Grades 6-8'],
  consent: true,
};
describe('careers validation', () => {
  it('normalises email and phone', () => {
    const r = parseApplication(ok);
    expect(r.email).toBe('ravi@mail.com');
    expect(r.phone).toBe('+919876543210');
  });
  it('rejects missing consent, bad skill, bad phone', () => {
    expect(() => parseApplication({ ...ok, consent: false })).toThrow();
    expect(() => parseApplication({ ...ok, skills: ['Hacking'] })).toThrow();
    expect(() => parseApplication({ ...ok, phone: '123' })).toThrow();
  });
  it('checks resume signature and size', () => {
    const pdf = Buffer.from('%PDF-1.4 ...');
    expect(
      checkResume({ buffer: pdf, size: pdf.length, originalname: 'a.pdf' }),
    ).toBe('pdf');
    expect(() =>
      checkResume({
        buffer: Buffer.from('MZ..exe'),
        size: 7,
        originalname: 'a.pdf',
      }),
    ).toThrow();
    expect(() =>
      checkResume({ buffer: pdf, size: 6e6, originalname: 'a.pdf' }),
    ).toThrow();
    expect(() => checkResume(undefined)).toThrow();
  });
});

describe('parseOpening', () => {
  const ok = {
    title: 'Lab Tech',
    location: 'Hyd',
    description: 'x',
    teach: 'a\n\n b ',
    payMin: '10',
    payMax: 20,
  };
  it('cleans a create payload', () => {
    const o = parseOpening(ok) as any;
    expect(o.details).toEqual({ teach: ['a', 'b'], seeking: [] });
    expect(o.payMin).toBe(10);
    expect(o.jobType).toBe('Full-time, Permanent');
  });
  it('rejects bad pay range, status and empty title', () => {
    expect(() => parseOpening({ ...ok, payMin: 30 })).toThrow();
    expect(() => parseOpening({ ...ok, status: 'x' })).toThrow();
    expect(() => parseOpening({ ...ok, title: ' ' })).toThrow();
  });
  it('positions default to 1, accept paused, reject 0', () => {
    expect((parseOpening(ok) as any).positions).toBe(1);
    expect(parseOpening({ status: 'paused', positions: '3' }, true)).toEqual({
      status: 'paused',
      positions: 3,
    });
    expect(() => parseOpening({ ...ok, positions: 0 })).toThrow();
  });
  it('partial returns only given keys', () => {
    expect(parseOpening({ status: 'closed' }, true)).toEqual({
      status: 'closed',
    });
  });
  it('slugifies', () =>
    expect(slugify(' Robotics Trainer (Hyd)! ')).toBe('robotics-trainer-hyd'));
});
