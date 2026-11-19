import {
  checkResume,
  parseApplication,
  parseOpening,
  slugify,
} from './careers.validate';
import { PRESETS, parseFormConfig } from './careers.form';

const T = PRESETS.teaching;

const ok = {
  fullName: 'Ravi Kumar',
  email: ' Ravi@Mail.com ',
  phone: '98765 43210',
  city: 'Hyderabad',
  consent: true,
  answers: {
    qualification: 'B.Tech',
    currentStatus: 'fresher',
    englishLevel: 4,
    why: 'x',
    explain: 'y',
    skills: ['Python'],
    gradeBands: ['Grades 6-8'],
  },
};
const withA = (a: object) => ({ ...ok, answers: { ...ok.answers, ...a } });
describe('careers validation', () => {
  it('normalises email and phone', () => {
    const r = parseApplication(ok, T);
    expect(r.email).toBe('ravi@mail.com');
    expect(r.phone).toBe('+919876543210');
    expect(r.answers.why).toEqual({
      q: 'Why do you want to be a trainer?',
      v: 'x',
    });
  });
  it('rejects missing consent, bad skill, bad phone', () => {
    expect(() => parseApplication({ ...ok, consent: false }, T)).toThrow();
    expect(() => parseApplication(withA({ skills: ['Hacking'] }), T)).toThrow();
    expect(() => parseApplication({ ...ok, phone: '123' }, T)).toThrow();
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
    expect(checkResume(undefined, 'optional')).toBeNull();
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

describe('custom forms', () => {
  const form = {
    resume: 'off' as const,
    steps: [
      {
        id: 's1',
        title: 'Sales',
        questions: [
          {
            id: 'target',
            type: 'number' as const,
            label: 'Monthly target',
            required: true,
          },
          {
            id: 'area',
            type: 'choice' as const,
            label: 'Area',
            required: false,
            options: ['North', 'South'],
          },
        ],
      },
    ],
  };
  const base = {
    fullName: 'A',
    email: 'a@b.co',
    phone: '9876543210',
    city: 'H',
    consent: true,
  };
  it('stores custom answers with labels, leaves unasked columns empty', () => {
    const r = parseApplication(
      { ...base, answers: { target: '5', area: 'South' } },
      form,
    );
    expect(r.answers.target).toEqual({ q: 'Monthly target', v: 5 });
    expect((r as Record<string, unknown>).englishLevel).toBeNull();
    expect((r as Record<string, unknown>).skills).toEqual([]);
  });
  it('enforces required and options', () => {
    expect(() => parseApplication({ ...base, answers: {} }, form)).toThrow();
    expect(() =>
      parseApplication({ ...base, answers: { target: 1, area: 'East' } }, form),
    ).toThrow();
  });
  it('validates admin form config', () => {
    expect(parseOpening({ formConfig: form }, true)).toHaveProperty(
      'formConfig',
    );
    expect(() =>
      parseOpening({ formConfig: { ...form, resume: 'x' } }, true),
    ).toThrow();
    const dup = {
      ...form,
      steps: [
        {
          ...form.steps[0],
          questions: [form.steps[0].questions[0], form.steps[0].questions[0]],
        },
      ],
    };
    expect(() => parseOpening({ formConfig: dup }, true)).toThrow();
  });
  it('presets pass their own validation', () => {
    for (const p of Object.values(PRESETS))
      expect(() => parseOpening({ formConfig: p }, true)).not.toThrow();
  });
});

describe('configurable core fields', () => {
  const f = (core: object) => ({ ...T, core });
  const noPC = { ...ok, phone: '', city: '' };
  it('allows skipping optional or hidden phone and city', () => {
    const r = parseApplication(
      noPC,
      f({ phone: { mode: 'optional' }, city: { mode: 'off' } }),
    );
    expect(r.phone).toBe('');
    expect(r.city).toBe('');
  });
  it('still requires them by default', () => {
    expect(() => parseApplication(noPC, T)).toThrow();
  });
  it('still validates an optional phone when given', () => {
    expect(() =>
      parseApplication(
        { ...ok, phone: '123' },
        f({ phone: { mode: 'optional' } }),
      ),
    ).toThrow();
  });
  it('keeps name and email required and caps labels', () => {
    const c = parseFormConfig({
      ...T,
      core: { email: { mode: 'off', label: ' Work email ' }, consent: 'Ok?' },
    });
    expect(c.core?.email).toEqual({ label: 'Work email', mode: 'required' });
    expect(c.core?.consent).toBe('Ok?');
    expect(() =>
      parseFormConfig({ ...T, core: { phone: { mode: 'x' } } }),
    ).toThrow();
  });
});
