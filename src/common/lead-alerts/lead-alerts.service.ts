import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

/**
 * Emails the team the moment a website lead comes in: a project brief or a
 * call-back request. Sent through the company mailbox's SMTP (Hostinger by
 * default). Skipped silently when the vars below are missing:
 *
 *   LEAD_ALERT_EMAILS   comma-separated recipients, e.g. info@yugminds.org
 *   SMTP_USER           the mailbox that sends, e.g. info@yugminds.org
 *   SMTP_PASS           that mailbox's password
 *   SMTP_HOST / SMTP_PORT  optional, default smtp.hostinger.com / 465
 *
 * It also sends the person who wrote a YugMinds project brief a confirmation
 * with a recap of their brief and what happens next (confirmBrief).
 *
 * Fire-and-forget: a slow or failing mail server never delays or breaks the
 * visitor's submission; failures are logged.
 */
export type Lead = {
  kind: 'brief' | 'callback';
  name: string;
  phone?: string | null;
  email?: string | null;
  topic: string;
  message?: string;
};

@Injectable()
export class LeadAlertsService {
  private readonly log = new Logger(LeadAlertsService.name);
  private transport: nodemailer.Transporter | null = null;

  notify(lead: Lead): void {
    void this.email(lead).catch((e: unknown) =>
      this.log.warn(`Lead email alert failed: ${String(e)}`),
    );
  }

  /** "We've got your brief": sent to the person who wrote it. */
  confirmBrief(brief: {
    firstName: string;
    email: string;
    project: string;
    message: string;
  }): void {
    void this.sendConfirmation(brief).catch((e: unknown) =>
      this.log.warn(`Brief confirmation email failed: ${String(e)}`),
    );
  }

  /** The shared SMTP connection, or null when mail isn't configured. */
  private mailer() {
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!user || !pass) return null;
    this.transport ??= nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.hostinger.com',
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user, pass },
    });
    return { transport: this.transport, from: user };
  }

  private async sendConfirmation(b: {
    firstName: string;
    email: string;
    project: string;
    message: string;
  }) {
    const m = this.mailer();
    if (!m) return;
    const team = process.env.LEAD_ALERT_EMAILS?.split(',')[0]?.trim() || m.from;
    const phone = '+91 85003 45655';
    const steps = [
      'A person on our team reads your brief and replies, usually by email or a phone call.',
      'We set up a short call to understand what you need and what it is for.',
      'You get a plan: which of our companies builds it, a timeline and a cost.',
    ];
    const text = [
      `Hi ${b.firstName},`,
      '',
      `Thanks for sending us your project brief. It has reached the YugMinds team, and a person (not a bot) will read it.`,
      '',
      'What happens next',
      ...steps.map((s, i) => `${i + 1}. ${s}`),
      '',
      'Your brief',
      `What you need built: ${b.project}`,
      b.message,
      '',
      `Want to add something, like sketches, links or files? Just reply to this email. If it's urgent, call us on ${phone}.`,
      '',
      'The YugMinds team',
      'Software, electronics, machines and Robocoders robotics lessons, made in Hyderabad.',
      'https://yugminds.org',
    ].join('\n');

    const e = escapeHtml;
    const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#1e3a8a;padding:24px 28px;color:#ffffff">
<div style="font-size:14px;color:#bfdbfe">YugMinds</div>
<div style="font-size:24px;font-weight:bold;margin-top:6px">We've got your brief, ${e(b.firstName)}.</div>
</td></tr>
<tr><td style="padding:24px 28px;font-size:15px;line-height:1.6">
<p style="margin:0 0 16px">Thanks for sending us your project brief. It has reached the YugMinds team, and a person (not a bot) will read it.</p>
<p style="margin:0 0 8px;font-weight:bold">What happens next</p>
<ol style="margin:0 0 20px;padding-left:20px">${steps.map((s) => `<li style="margin:0 0 6px">${e(s)}</li>`).join('')}</ol>
<div style="background:#eff6ff;border-radius:10px;padding:16px 18px;margin:0 0 20px">
<p style="margin:0 0 4px;font-size:13px;color:#1d4ed8;font-weight:bold">Your brief</p>
<p style="margin:0 0 8px;font-weight:bold">${e(b.project)}</p>
<p style="margin:0;white-space:pre-line;color:#334155">${e(b.message)}</p>
</div>
<p style="margin:0 0 16px">Want to add something, like sketches, links or files? Just reply to this email. If it's urgent, call us on <a href="tel:+918500345655" style="color:#1d4ed8">${phone}</a>.</p>
<p style="margin:0">The YugMinds team</p>
</td></tr>
<tr><td style="padding:16px 28px;background:#f8fafc;font-size:12px;color:#64748b">
Software, electronics, machines and Robocoders robotics lessons, made in Hyderabad. <a href="https://yugminds.org" style="color:#1d4ed8">yugminds.org</a><br>
You're getting this one email because you sent us a brief on our website.
</td></tr>
</table></td></tr></table></body></html>`;

    await m.transport.sendMail({
      from: `"YugMinds" <${m.from}>`,
      to: b.email,
      replyTo: team,
      subject: `We've got your brief, ${b.firstName}`,
      text,
      html,
    });
  }

  private headline(lead: Lead) {
    return lead.kind === 'callback'
      ? `New call-back request: ${lead.name}`
      : `New project brief: ${lead.name}`;
  }

  private lines(lead: Lead) {
    return [
      `${lead.kind === 'callback' ? 'Call back about' : 'Project'}: ${lead.topic}`,
      `Name: ${lead.name}`,
      lead.phone ? `Phone: +91 ${lead.phone}` : '',
      lead.email ? `Email: ${lead.email}` : '',
      lead.message ? `\n${lead.message}` : '',
    ].filter(Boolean);
  }

  private async email(lead: Lead) {
    const to = process.env.LEAD_ALERT_EMAILS;
    const m = this.mailer();
    if (!to || !m) return;
    const text = [
      ...this.lines(lead),
      '',
      'Open it in Admin → Contact Submissions.',
    ].join('\n');
    await m.transport.sendMail({
      from: `"YugMinds website" <${m.from}>`,
      to,
      // Reply goes straight to the lead when they gave an email.
      replyTo: lead.email || undefined,
      subject: this.headline(lead),
      text,
    });
  }
}

/* Visitors' text goes into the HTML email, so it must not be able to inject markup. */
function escapeHtml(v: string) {
  return v.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );
}
