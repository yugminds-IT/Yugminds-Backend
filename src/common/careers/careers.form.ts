import { BadRequestException } from '@nestjs/common';

/**
 * Per-role application form. The fixed "About you" step (name, email, phone, city) and the
 * resume/consent step are always asked; everything between is configured per opening.
 * Library questions (with `key`) fill existing JobApplication columns; the rest land in `answers`.
 */
export type QType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'url'
  | 'choice'
  | 'multi'
  | 'yesno'
  | 'scale';
export type Question = {
  id: string;
  key?: string;
  type: QType;
  label: string;
  help?: string;
  required: boolean;
  options?: string[];
};
export type Mode = 'required' | 'optional' | 'off';
export const CORE_KEYS = ['fullName', 'email', 'phone', 'city'] as const;
/** Admin overrides for the fixed steps. Name and email are always asked (identity + replies). */
export type CoreCfg = Partial<
  Record<(typeof CORE_KEYS)[number], { label?: string; mode?: Mode }>
> & { consent?: string };
export type FormConfig = {
  resume: Mode;
  steps: { id: string; title: string; questions: Question[] }[];
  core?: CoreCfg;
};

const fail = (m: string) => new BadRequestException(m);
const TYPES: QType[] = [
  'text',
  'textarea',
  'number',
  'date',
  'url',
  'choice',
  'multi',
  'yesno',
  'scale',
];

/** Standard questions mapped to columns. Type is fixed by key; admins may reword label/help/options. */
export const LIBRARY: Record<
  string,
  { label: string; type: QType; options?: string[]; max?: number }
> = {
  qualification: { label: 'Highest qualification', type: 'text', max: 120 },
  college: { label: 'College / institute', type: 'text', max: 160 },
  gradYear: { label: 'Graduation year', type: 'number' },
  experienceYears: { label: 'Years of experience', type: 'number' },
  currentStatus: {
    label: 'Right now I am',
    type: 'choice',
    options: ['fresher', 'student', 'working'],
  },
  skills: {
    label: 'What do you know?',
    type: 'multi',
    options: [
      'Scratch',
      'Python',
      'Arduino',
      'Robotics kits',
      'AI / ML basics',
      'Web / HTML',
    ],
  },
  gradeBands: {
    label: 'Which grades can you teach?',
    type: 'multi',
    options: ['Grades 1-5', 'Grades 6-8', 'Grades 9-12'],
  },
  englishLevel: {
    label: 'Spoken English (1 = basic, 5 = fluent)',
    type: 'scale',
  },
  hasTwoWheeler: { label: 'I have a two-wheeler', type: 'yesno' },
  willTravel: {
    label: 'I can travel to schools across Hyderabad',
    type: 'yesno',
  },
  expectedSalary: { label: 'Expected salary (₹ / month)', type: 'number' },
  joinDate: { label: 'Earliest joining date', type: 'date' },
  heardFrom: { label: 'How did you hear about us?', type: 'text', max: 80 },
  videoUrl: { label: 'Intro video link', type: 'url', max: 300 },
};
const RANGE: Record<string, [number, number]> = {
  gradYear: [1990, 2040],
  experienceYears: [0, 40],
  expectedSalary: [0, 1_000_000],
};

const lib = (
  key: string,
  required: boolean,
  extra: Partial<Question> = {},
): Question => ({
  id: key,
  key,
  type: LIBRARY[key].type,
  label: LIBRARY[key].label,
  options: LIBRARY[key].options,
  required,
  ...extra,
});
const q = (
  id: string,
  type: QType,
  label: string,
  required: boolean,
  help?: string,
): Question => ({
  id,
  type,
  label,
  required,
  help,
});

export const PRESETS: Record<'teaching' | 'general' | 'blank', FormConfig> = {
  // Exactly the form every role used before forms were configurable.
  teaching: {
    resume: 'required',
    steps: [
      {
        id: 'background',
        title: 'Background',
        questions: [
          lib('qualification', true, {
            help: 'For example B.Tech, Diploma, B.Sc, 12th',
          }),
          lib('college', false),
          lib('gradYear', false),
          lib('experienceYears', false),
          lib('currentStatus', true),
        ],
      },
      {
        id: 'skills',
        title: 'Skills',
        questions: [
          lib('skills', false),
          lib('gradeBands', false),
          lib('englishLevel', true),
          lib('hasTwoWheeler', false),
          lib('willTravel', false),
        ],
      },
      {
        id: 'questions',
        title: 'Questions',
        questions: [
          q('why', 'textarea', 'Why do you want to be a trainer?', true),
          q(
            'explain',
            'textarea',
            'Explain a sensor (or how a robot knows where it is) to a 10-year-old',
            true,
            'A few sentences is enough.',
          ),
          lib('expectedSalary', false),
          lib('joinDate', false),
          lib('heardFrom', false),
          lib('videoUrl', false, {
            help: 'A one-minute video of you explaining something. YouTube or Drive link.',
          }),
        ],
      },
    ],
  },
  general: {
    resume: 'required',
    steps: [
      {
        id: 'background',
        title: 'Background',
        questions: [
          lib('qualification', true),
          lib('experienceYears', false),
          lib('currentStatus', true),
        ],
      },
      {
        id: 'questions',
        title: 'Questions',
        questions: [
          q('why', 'textarea', 'Why are you interested in this role?', true),
          lib('expectedSalary', false),
          lib('joinDate', false),
          lib('heardFrom', false),
        ],
      },
    ],
  },
  blank: { resume: 'required', steps: [] },
};

export const LEGACY_LABELS: Record<string, string> = {
  why: 'Why do you want to be a trainer?',
  explain:
    'Explain a sensor (or how a robot knows where it is) to a 10-year-old',
};

const ID = /^[A-Za-z0-9_]{2,30}$/;
const txt = (v: unknown, max: number, label: string, required = true) => {
  const s = String(v ?? '').trim();
  if (required && !s) throw fail(`${label} is required`);
  if (s.length > max) throw fail(`${label} is too long`);
  return s;
};

/** Validates an admin-submitted form definition and returns the cleaned copy. */
export function parseFormConfig(raw: unknown): FormConfig {
  const r = raw as Partial<FormConfig> | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.steps))
    throw fail('Application form is invalid');
  if (!['required', 'optional', 'off'].includes(String(r.resume)))
    throw fail('Resume setting is invalid');
  if (r.steps.length > 6) throw fail('At most 6 steps in the form');
  const ids = new Set<string>();
  let total = 0;
  const steps = r.steps.map((s) => {
    const sid = String(s?.id ?? '');
    if (!ID.test(sid)) throw fail('Step id is invalid');
    const questions = (Array.isArray(s.questions) ? s.questions : []).map(
      (x: Question) => {
        total++;
        if (!ID.test(String(x?.id)) || ids.has(x.id))
          throw fail('Question id is invalid or repeated');
        ids.add(x.id);
        const key = x.key ? String(x.key) : undefined;
        if (key && !LIBRARY[key])
          throw fail(`Unknown standard question ${key}`);
        if (key && x.id !== key)
          throw fail('Standard question id must match its key');
        const type = key ? LIBRARY[key].type : x.type;
        if (!TYPES.includes(type)) throw fail('Question type is invalid');
        let options: string[] | undefined;
        if (type === 'choice' || type === 'multi') {
          options = (Array.isArray(x.options) ? x.options : [])
            .map((o) => String(o).trim())
            .filter(Boolean);
          if (options.length < 2 || options.length > 20)
            throw fail('Choice questions need 2 to 20 options');
          if (options.some((o) => o.length > 60))
            throw fail('Option is too long');
          if (new Set(options).size !== options.length)
            throw fail('Options must be different');
        }
        return {
          id: x.id,
          key,
          type,
          label: txt(x.label, 160, 'Question'),
          help: txt(x.help, 200, 'Help text', false) || undefined,
          required: x.required === true,
          options,
        } as Question;
      },
    );
    const title = txt(s.title, 40, 'Step title');
    if (!questions.length) throw fail(`Step "${title}" has no questions`);
    return { id: sid, title, questions };
  });
  if (total > 40) throw fail('At most 40 questions in the form');
  if (new Set(steps.map((s) => s.id)).size !== steps.length)
    throw fail('Step ids repeat');
  const out: FormConfig = { resume: r.resume as FormConfig['resume'], steps };
  const c = r.core && typeof r.core === 'object' ? r.core : {};
  const core: CoreCfg = {};
  for (const k of CORE_KEYS) {
    const x = c[k];
    if (!x) continue;
    const mode = x.mode ?? 'required';
    if (!['required', 'optional', 'off'].includes(mode))
      throw fail('Field setting is invalid');
    core[k] = {
      label: txt(x.label, 40, 'Field label', false) || undefined,
      mode: k === 'fullName' || k === 'email' ? 'required' : mode,
    };
  }
  const consent = txt(c.consent, 500, 'Consent text', false);
  if (consent) core.consent = consent;
  if (Object.keys(core).length) out.core = core;
  return out;
}

/** The opening's form; roles created before forms existed (null) get the Teaching form. */
export const resolveForm = (o: { formConfig: unknown }): FormConfig =>
  o.formConfig ? (o.formConfig as FormConfig) : PRESETS.teaching;

/** Checks the applicant's answers (`{[questionId]: value}`) against the form. */
export function parseAnswers(form: FormConfig, raw: unknown) {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const cols: Record<string, unknown> = {
    qualification: '',
    currentStatus: '',
    college: null,
    gradYear: null,
    experienceYears: 0,
    skills: [],
    gradeBands: [],
    englishLevel: null,
    hasTwoWheeler: null,
    willTravel: null,
    expectedSalary: null,
    joinDate: null,
    heardFrom: null,
    videoUrl: null,
  };
  const answers: Record<
    string,
    { q: string; v: string | number | boolean | string[] | null }
  > = {};
  for (const s of form.steps)
    for (const x of s.questions) {
      const v = a[x.id];
      const empty =
        v == null || v === '' || (Array.isArray(v) && v.length === 0);
      let out: string | number | boolean | string[] | null = null;
      if (x.type === 'yesno') {
        out = v === true;
        if (x.required && !out) throw fail(`${x.label} must be ticked`);
      } else if (empty) {
        if (x.required) throw fail(`${x.label} is required`);
        out = x.type === 'multi' ? [] : null;
      } else if (
        x.type === 'text' ||
        x.type === 'textarea' ||
        x.type === 'url' ||
        x.type === 'date'
      ) {
        const max =
          x.type === 'textarea' ? 2000 : (x.key && LIBRARY[x.key].max) || 300;
        out = txt(v, max, x.label);
        if (x.type === 'url' && !/^https?:\/\//i.test(out))
          throw fail(`${x.label} must start with http(s)://`);
        if (x.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(out))
          throw fail(`${x.label} is invalid`);
      } else if (x.type === 'number' || x.type === 'scale') {
        const [min, max] =
          x.type === 'scale'
            ? [1, 5]
            : (x.key && RANGE[x.key]) || [0, 1_000_000_000];
        const n = Number(v);
        if (!Number.isInteger(n) || n < min || n > max)
          throw fail(`${x.label} is invalid`);
        out = n;
      } else if (x.type === 'choice') {
        if (!x.options?.includes(String(v)))
          throw fail(`${x.label} has an unknown option`);
        out = String(v);
      } else if (x.type === 'multi') {
        const l = [...new Set((Array.isArray(v) ? v : []).map(String))];
        if (l.some((i) => !x.options?.includes(i)))
          throw fail(`${x.label} has an unknown option`);
        out = l;
      }
      if (x.key) cols[x.key] = out ?? cols[x.key];
      else answers[x.id] = { q: x.label, v: out };
    }
  return { cols, answers };
}

export type Response = { label: string; value: string; type: QType };
/** Labelled answers for the admin view. Handles old `{why, explain}` strings too. */
export function toResponses(answers: unknown): Response[] {
  const a = (answers && typeof answers === 'object' ? answers : {}) as Record<
    string,
    unknown
  >;
  const out: Response[] = [];
  for (const [id, x] of Object.entries(a)) {
    const legacy = typeof x === 'string';
    const v = legacy ? x : (x as { v?: unknown })?.v;
    const label = legacy
      ? (LEGACY_LABELS[id] ?? id)
      : String((x as { q?: unknown })?.q ?? id);
    const value =
      v === true
        ? 'Yes'
        : v === false
          ? 'No'
          : Array.isArray(v)
            ? v.join(', ')
            : String(v ?? '');
    if (value) out.push({ label, value, type: legacy ? 'textarea' : 'text' });
  }
  return out;
}
