import { BadRequestException } from '@nestjs/common';
import { parsePhone } from '../utils/phone.util';
import { parseAnswers, parseFormConfig, type FormConfig } from './careers.form';

export const STAGES = [
  'new',
  'screening',
  'interview',
  'demo_class',
  'offer',
  'hired',
  'rejected',
  'withdrawn',
  'on_hold',
] as const;
const fail = (m: string) => new BadRequestException(m);
const str = (v: unknown, max: number, label: string, required = true) => {
  const s = String(v ?? '').trim();
  if (required && !s) throw fail(`${label} is required`);
  if (s.length > max) throw fail(`${label} is too long`);
  return s;
};
const int = (
  v: unknown,
  min: number,
  max: number,
  label: string,
  required = false,
) => {
  if (v == null || v === '') {
    if (required) throw fail(`${label} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw fail(`${label} is invalid`);
  return n;
};

/** Cleans the untrusted public form: fixed core fields here, role questions via the opening's form. */
export function parseApplication(b: Record<string, unknown>, form: FormConfig) {
  const email = str(b.email, 200, 'Email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Email is invalid');
  const mode = (k: 'phone' | 'city') => form.core?.[k]?.mode ?? 'required';
  const phoneRaw = String(b.phone ?? '').trim();
  const phone =
    mode('phone') === 'off' || (mode('phone') === 'optional' && !phoneRaw)
      ? ''
      : parsePhone(b.phone);
  if (phone == null || (!phone && mode('phone') === 'required'))
    throw fail('Phone is required');
  if (b.consent !== true) throw fail('Please accept the consent to apply');
  const { cols, answers } = parseAnswers(form, b.answers);
  return {
    fullName: str(b.fullName, 80, 'Name'),
    email,
    phone,
    city:
      mode('city') === 'off'
        ? ''
        : str(b.city, 80, 'City', mode('city') === 'required'),
    ...cols,
    answers,
  };
}

const MAX_RESUME = 5 * 1024 * 1024;
/** Checks size and the file's real signature (PDF, DOC, DOCX), not just the name the browser sent. */
export function checkResume(
  f?: { buffer: Buffer; size: number; originalname: string },
  mode: FormConfig['resume'] = 'required',
) {
  if (!f || mode === 'off') {
    if (mode === 'required')
      throw fail('Please attach your resume (PDF or Word)');
    return null;
  }
  if (f.size > MAX_RESUME) throw fail('Resume must be 5 MB or smaller');
  const h = f.buffer.subarray(0, 4).toString('hex');
  const ext =
    f.buffer.subarray(0, 4).toString('latin1') === '%PDF'
      ? 'pdf'
      : h === '504b0304'
        ? 'docx'
        : h === 'd0cf11e0'
          ? 'doc'
          : null;
  if (!ext) throw fail('Resume must be a PDF or Word file');
  return ext;
}

const lines = (v: unknown, label: string) => {
  const a = (Array.isArray(v) ? v : String(v ?? '').split('\n'))
    .map((x) => String(x).trim())
    .filter(Boolean);
  if (a.length > 10) throw fail(`${label}: at most 10 items`);
  if (a.some((x) => x.length > 200)) throw fail(`${label}: item too long`);
  return a;
};

/** Admin create/edit of a job opening. Pass partial=true for PATCH (only given keys are returned). */
export function parseOpening(b: Record<string, unknown>, partial = false) {
  const has = (k: string) => !partial || b[k] !== undefined;
  const o: Record<string, unknown> = {};
  if (has('title')) o.title = str(b.title, 100, 'Title');
  if (has('team')) o.team = str(b.team || 'Teaching', 50, 'Team');
  if (has('location')) o.location = str(b.location, 120, 'Location');
  if (has('jobType'))
    o.jobType = str(b.jobType || 'Full-time, Permanent', 60, 'Job type');
  if (has('description'))
    o.description = str(b.description, 5000, 'Description');
  if (has('positions'))
    o.positions = int(b.positions ?? 1, 1, 999, 'Number of positions', true);
  if (has('rejectCooldownDays'))
    o.rejectCooldownDays =
      int(b.rejectCooldownDays ?? 90, 0, 730, 'Wait after a rejection') ?? 90;
  if (has('withdrawCooldownDays'))
    o.withdrawCooldownDays =
      int(b.withdrawCooldownDays ?? 30, 0, 730, 'Wait after a withdrawal') ??
      30;
  if (has('payMin')) o.payMin = int(b.payMin, 0, 10_000_000, 'Minimum pay');
  if (has('payMax')) o.payMax = int(b.payMax, 0, 10_000_000, 'Maximum pay');
  if (
    typeof o.payMin === 'number' &&
    typeof o.payMax === 'number' &&
    o.payMin > o.payMax
  )
    throw fail('Minimum pay cannot exceed maximum pay');
  if (has('status')) {
    const s = String(b.status ?? 'draft');
    if (!['draft', 'open', 'paused', 'closed'].includes(s))
      throw fail('Unknown status');
    o.status = s;
  }
  if (b.formConfig !== undefined)
    o.formConfig = b.formConfig === null ? null : parseFormConfig(b.formConfig);
  if (has('teach') || has('seeking'))
    o.details = {
      teach: lines(b.teach, 'What you will teach'),
      seeking: lines(b.seeking, 'Who we are looking for'),
    };
  return o;
}

export const slugify = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'role';
