/**
 * Emails sent to a trainer applicant when a reviewer moves them to a new stage.
 * Fixed wording per stage: the only free text is the reviewer's optional note,
 * which is HTML-escaped. Pure functions so they can be tested and previewed.
 */
const RAIL = [
  'Applied',
  'Screening',
  'Interview',
  'Demo class',
  'Offer',
  'Joined',
];
const AT: Record<string, number> = {
  screening: 1,
  interview: 2,
  demo_class: 3,
  offer: 4,
  hired: 5,
};

type Copy = { subject: string; head: string; intro: string; next: string[] };
const COPY: Record<string, (role: string) => Copy> = {
  screening: (role) => ({
    subject: 'Next step on your YugMinds application: a short call',
    head: "Let's talk, {first}.",
    intro: `We read your application for ${role} and we would like to talk to you. The next step is a short phone chat with our team.`,
    next: [
      'Keep your phone handy over the next few days.',
      'Our call may show up as an unknown number.',
      'Cannot talk then? Reply to this email with a time that suits you.',
    ],
  }),
  interview: (role) => ({
    subject: 'You are invited to interview at YugMinds',
    head: 'You are invited to interview, {first}.',
    intro: `Thanks for the screening call. For ${role}, we would now like to talk about teaching, kids and technology.`,
    next: [
      'Reply to confirm the time below, or suggest another.',
      'Carry a photo ID.',
      'Think of one idea you enjoyed learning and how you would teach it.',
    ],
  }),
  demo_class: () => ({
    subject: 'Your YugMinds demo class',
    head: 'Time for your demo class, {first}.',
    intro:
      'You are through the interview. Now teach us: a ten-minute topic of your choice, as if we were a class of Grade 6 students.',
    next: [
      'Pick a topic you know well, such as sensors, loops or a simple robot.',
      'Props, a laptop or a whiteboard are all fine. Keep it hands-on.',
      'We share feedback with you the same day.',
    ],
  }),
  offer: (role) => ({
    subject: 'An offer from YugMinds',
    head: 'We would like to offer you the role, {first}.',
    intro: `Congratulations. We would like you to join us as ${role}. Paid training on our curriculum and Robocoders kits comes first.`,
    next: [
      'Read the note below and reply to this email to accept.',
      'Keep your photo ID and education certificates ready.',
      'Questions about pay, timing or schools? Ask us in your reply.',
    ],
  }),
  hired: (role) => ({
    subject: 'Welcome to YugMinds',
    head: 'Welcome aboard, {first}.',
    intro: `You are now part of the YugMinds team as ${role}. We are glad to have you.`,
    next: [
      'Watch for a message from us with your joining date and training schedule.',
      'Keep your photo ID and education certificates ready for day one.',
      'Questions before you start? Just reply to this email.',
    ],
  }),
  on_hold: (role) => ({
    subject: 'Your YugMinds application is on hold',
    head: 'Your application is on hold, {first}.',
    intro: `We are pausing your application for ${role} for now. This is not a no. We will contact you as soon as we can move it forward.`,
    next: [
      'You do not need to do anything.',
      'If your phone number or availability changes, reply to this email.',
    ],
  }),
  rejected: (role) => ({
    subject: 'Your YugMinds application',
    head: 'Thank you for applying, {first}.',
    intro: `We have decided not to move ahead with your application for ${role} this time. We read it with care, and we are grateful for the time you put in.`,
    next: [
      'We keep your details and will reach out if a suitable role opens.',
      'You are welcome to apply again as your experience grows.',
    ],
  }),
};

export const STAGE_EMAIL_STAGES = Object.keys(COPY);

const esc = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );

/** First name if it looks like a plain name, else "there" (the address is unverified). */
export const firstName = (full: string) =>
  /^[\p{L}][\p{L} .'-]{0,79}$/u.test(full.trim())
    ? full.trim().split(/\s+/)[0]
    : 'there';

const FONT_HEAD = "'Chakra Petch','Trebuchet MS',Arial,sans-serif";
const FONT_BODY = 'Arial,Helvetica,sans-serif';
const PHONE = '+91 85003 45655';
const SITE = 'https://yugminds.org';
export const trackUrl = (ref: string) => `${SITE}/careers/status?ref=${ref}`;
const ADMIN_URL = `${SITE}/lms/admin/careers`;

type Mail = { subject: string; text: string; html: string };

/** Hiring progress on the navy hero: done = bright, current = tall bar, later = dim. */
function rail(stage: string) {
  const at = AT[stage] ?? (stage === 'new' ? 0 : undefined);
  if (at === undefined) return '';
  const w = Math.floor(100 / RAIL.length);
  const cells = RAIL.map((label, i) => {
    const bar = i <= at ? '#93c5fd' : '#3b4f9a';
    const colour = i === at ? '#ffffff' : i < at ? '#bfdbfe' : '#8da2d9';
    return `<td width="${w}%" style="padding:0 2px"><div style="height:${i === at ? 8 : 4}px;background:${bar};border-radius:4px"></div><div style="font-size:11px;line-height:1.3;margin-top:7px;color:${colour};font-weight:${i === at ? 'bold' : 'normal'}">${label}</div></td>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:26px 0 0"><tr>${cells}</tr></table>`;
}

const btn = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 22px;border-radius:6px">${label}</a>`;

/** One shell for every careers email. `calm` swaps the navy hero for a light one (no good-news framing). */
function shell(o: {
  head: string;
  hero?: string;
  body: string;
  foot: string;
  calm?: boolean;
}) {
  const bg = o.calm ? '#eff6ff' : '#1e3a8a';
  const ink = o.calm ? '#0f172a' : '#ffffff';
  const sub = o.calm ? '#1d4ed8' : '#93c5fd';
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:${FONT_BODY};color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:${bg};padding:22px 28px 28px">
<div style="font-family:${FONT_HEAD};font-size:15px;font-weight:bold;color:${sub};margin-bottom:18px">YugMinds Careers</div>
<h1 style="margin:0;font-family:${FONT_HEAD};font-size:30px;line-height:1.15;color:${ink}">${esc(o.head)}</h1>
${o.hero ?? ''}
</td></tr>
<tr><td style="padding:26px 28px 6px;font-size:15px;line-height:1.6">${o.body}</td></tr>
<tr><td style="padding:16px 28px;background:#f8fafc;font-size:12px;line-height:1.6;color:#64748b">${o.foot}</td></tr>
</table></td></tr></table></body></html>`;
}

const para = (t: string) => `<p style="margin:0 0 18px">${esc(t)}</p>`;
const heading = (t: string) =>
  `<p style="margin:0 0 8px;font-family:${FONT_HEAD};font-size:17px;font-weight:bold">${esc(t)}</p>`;
const bullets = (a: string[]) =>
  `<ul style="margin:0 0 20px;padding-left:20px">${a.map((n) => `<li style="margin:0 0 6px">${esc(n)}</li>`).join('')}</ul>`;
/** Real sequence, so numbers are earned. */
const steps = (a: string[]) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px">${a
    .map(
      (n, i) =>
        `<tr><td valign="top" style="padding:0 12px 10px 0"><div style="width:24px;height:24px;line-height:24px;text-align:center;border-radius:12px;background:#dbeafe;color:#1e3a8a;font-size:13px;font-weight:bold">${i + 1}</div></td><td style="padding:2px 0 10px">${esc(n)}</td></tr>`,
    )
    .join('')}</table>`;
const noteBox = (note?: string) =>
  note
    ? `<div style="margin:0 0 20px;padding:14px 16px;background:#eff6ff;border-left:4px solid #1d4ed8;border-radius:4px"><div style="font-family:${FONT_HEAD};font-weight:bold;color:#1e3a8a;margin-bottom:4px">A note from our team</div>${esc(note).replace(/\r?\n/g, '<br>')}</div>`
    : '';
const applicantFoot = (ref: string, role: string) =>
  `Your reference is <b>${esc(ref)}</b>. Reply to this email or call ${PHONE}.<br>You got this because you applied for ${esc(role)} on <a href="${SITE}" style="color:#1d4ed8">yugminds.org</a>.`;
const textFoot = (ref: string) =>
  [
    `Track your application: ${trackUrl(ref)}`,
    `Your reference is ${ref}. Reply to this email or call ${PHONE}.`,
    '',
    'The YugMinds team',
    SITE,
  ].join('\n');

export function stageEmail(
  stage: string,
  a: { first: string; role: string; ref: string; note?: string },
): Mail | null {
  const make = COPY[stage];
  if (!make) return null;
  const c = make(a.role);
  const head = c.head.replace('{first}', a.first);
  const note = a.note?.trim();
  const calm = AT[stage] === undefined;
  const text = [
    head,
    '',
    c.intro,
    '',
    ...(note ? ['A note from our team:', note, ''] : []),
    'What to do next',
    ...c.next.map((n, i) => `${i + 1}. ${n}`),
    '',
    textFoot(a.ref),
  ].join('\n');
  const html = shell({
    head,
    hero: rail(stage),
    calm,
    body:
      para(c.intro) +
      noteBox(note) +
      heading('What to do next') +
      bullets(c.next) +
      `<p style="margin:0 0 22px">${btn(trackUrl(a.ref), 'Track your application')}</p>` +
      `<p style="margin:0 0 20px">The YugMinds team</p>`,
    foot: applicantFoot(a.ref, a.role),
  });
  return { subject: c.subject, text, html };
}

const NEXT = [
  'Our team reads your application, usually within a few days.',
  'If it is a fit, we call you for a short screening chat.',
  'Then an interview, a short demo class, and an offer.',
];

/** Sent to the applicant the moment they apply. The reference is the hero: it is what they must keep. */
export function receivedEmail(a: {
  first: string;
  role: string;
  ref: string;
}): Mail {
  const head = `We got your application, ${a.first}.`;
  const intro = `Thanks for applying for ${a.role}. A person on our team will read it.`;
  const text = [
    head,
    '',
    intro,
    `Your reference: ${a.ref}`,
    '',
    'What happens next',
    ...NEXT.map((n, i) => `${i + 1}. ${n}`),
    '',
    'Keep your phone handy.',
    '',
    textFoot(a.ref),
  ].join('\n');
  const html = shell({
    head,
    hero:
      `<div style="margin-top:20px;display:inline-block;padding:12px 18px;border:1px dashed #93c5fd;border-radius:8px"><div style="font-size:12px;color:#bfdbfe">Your reference</div><div style="font-family:'Courier New',monospace;font-size:24px;font-weight:bold;letter-spacing:2px;color:#ffffff">${esc(a.ref)}</div></div>` +
      rail('new'),
    body:
      para(intro) +
      heading('What happens next') +
      steps(NEXT) +
      para(
        'Keep your phone handy. Save your reference: with your email, it lets you check your status any time.',
      ) +
      `<p style="margin:0 0 22px">${btn(trackUrl(a.ref), 'Track your application')}</p>` +
      `<p style="margin:0 0 20px">The YugMinds team</p>`,
    foot: applicantFoot(a.ref, a.role),
  });
  return { subject: `We got your application (${a.ref})`, text, html };
}

const row = (k: string, v: string) =>
  `<tr><td style="padding:6px 16px 6px 0;color:#64748b;white-space:nowrap" valign="top">${k}</td><td style="padding:6px 0;font-weight:bold">${v}</td></tr>`;

/** To HR: scannable details and one button into the admin. */
export function hrNewEmail(a: {
  ref: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  role: string;
}): Mail {
  const text = `${a.name}\n${a.phone}\n${a.email}\n${a.city}\n\nOpen it: ${ADMIN_URL}`;
  const html = shell({
    head: `New application: ${a.role}`,
    body:
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px">${row('Name', esc(a.name))}${row('Phone', `<a href="tel:${esc(a.phone)}" style="color:#1d4ed8">${esc(a.phone)}</a>`)}${row('Email', `<a href="mailto:${esc(a.email)}" style="color:#1d4ed8">${esc(a.email)}</a>`)}${row('City', esc(a.city))}${row('Reference', esc(a.ref))}</table>` +
      `<p style="margin:0 0 22px">${btn(ADMIN_URL, 'Review in Admin')}</p>`,
    foot: 'Sent to the hiring team because someone applied on yugminds.org.',
  });
  return { subject: `New application: ${a.role} (${a.ref})`, text, html };
}

export function hrWithdrawnEmail(a: {
  ref: string;
  name: string;
  role: string;
}): Mail {
  const text = `${a.name} withdrew their application for ${a.role} (${a.ref}).\n\nOpen it: ${ADMIN_URL}`;
  const html = shell({
    head: `Withdrawn: ${a.role}`,
    calm: true,
    body:
      para(
        `${a.name} closed their own application. No further emails go to them.`,
      ) +
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px">${row('Reference', esc(a.ref))}</table>` +
      `<p style="margin:0 0 22px">${btn(ADMIN_URL, 'Open in Admin')}</p>`,
    foot: 'Sent to the hiring team because an applicant withdrew on yugminds.org.',
  });
  return { subject: `Application withdrawn: ${a.role} (${a.ref})`, text, html };
}
