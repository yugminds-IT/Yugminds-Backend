import { BadRequestException } from '@nestjs/common';
import { parsePhone } from '../utils/phone.util';

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
export const SKILLS = [
  'Scratch',
  'Python',
  'Arduino',
  'Robotics kits',
  'AI / ML basics',
  'Web / HTML',
];
export const GRADE_BANDS = ['Grades 1-5', 'Grades 6-8', 'Grades 9-12'];
export const CURRENT = ['fresher', 'student', 'working'];

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
const pick = (v: unknown, allowed: string[], label: string) => {
  if (!Array.isArray(v)) return [];
  const out = [...new Set(v.map(String))];
  if (out.some((x) => !allowed.includes(x)))
    throw fail(`${label} has an unknown option`);
  return out;
};

/** Cleans the untrusted public form; throws 400 with a readable message. */
export function parseApplication(b: Record<string, unknown>) {
  const email = str(b.email, 200, 'Email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Email is invalid');
  const phone = parsePhone(b.phone);
  if (!phone) throw fail('Phone is required');
  const currentStatus = str(b.currentStatus, 20, 'Current status');
  if (!CURRENT.includes(currentStatus)) throw fail('Current status is invalid');
  const videoUrl = str(b.videoUrl, 300, 'Video link', false);
  if (videoUrl && !/^https?:\/\//i.test(videoUrl))
    throw fail('Video link must start with http(s)://');
  if (b.consent !== true) throw fail('Please accept the consent to apply');
  return {
    fullName: str(b.fullName, 80, 'Name'),
    email,
    phone,
    city: str(b.city, 80, 'City'),
    willTravel: b.willTravel !== false,
    qualification: str(b.qualification, 120, 'Qualification'),
    college: str(b.college, 160, 'College', false) || null,
    gradYear: int(b.gradYear, 1990, 2040, 'Graduation year'),
    experienceYears: int(b.experienceYears, 0, 40, 'Experience') ?? 0,
    currentStatus,
    skills: pick(b.skills, SKILLS, 'Skills'),
    gradeBands: pick(b.gradeBands, GRADE_BANDS, 'Grades'),
    englishLevel: int(b.englishLevel, 1, 5, 'English level', true) as number,
    hasTwoWheeler: b.hasTwoWheeler === true,
    answers: {
      why: str(b.why, 1000, 'Why do you want to be a trainer'),
      explain: str(b.explain, 1000, 'Your explanation'),
    },
    expectedSalary: int(b.expectedSalary, 0, 1000000, 'Expected salary'),
    joinDate: str(b.joinDate, 40, 'Joining date', false) || null,
    heardFrom: str(b.heardFrom, 80, 'Heard from', false) || null,
    videoUrl: videoUrl || null,
  };
}

const MAX_RESUME = 5 * 1024 * 1024;
/** Checks size and the file's real signature (PDF, DOC, DOCX), not just the name the browser sent. */
export function checkResume(f?: {
  buffer: Buffer;
  size: number;
  originalname: string;
}) {
  if (!f) throw fail('Please attach your resume (PDF or Word)');
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
