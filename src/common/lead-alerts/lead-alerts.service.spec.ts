import * as nodemailer from 'nodemailer';
import { LeadAlertsService } from './lead-alerts.service';

jest.mock('nodemailer');

describe('LeadAlertsService', () => {
  const env = { ...process.env };
  let sendMail: jest.Mock;

  beforeEach(() => {
    sendMail = jest.fn().mockResolvedValue({});
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    process.env.LEAD_ALERT_EMAILS = 'info@yugminds.org';
    process.env.SMTP_USER = 'info@yugminds.org';
    process.env.SMTP_PASS = 'secret';
    delete process.env.SMTP_HOST;
  });
  afterAll(() => {
    process.env = env;
  });

  const flush = () => new Promise((r) => setImmediate(r));
  const callback = {
    kind: 'callback' as const,
    name: 'Ravi Kumar',
    phone: '9876543210',
    topic: 'School robotics lab',
  };

  it('does nothing when the mailbox password is not set', async () => {
    delete process.env.SMTP_PASS;
    new LeadAlertsService().notify(callback);
    await flush();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('emails a call-back request through Hostinger', async () => {
    new LeadAlertsService().notify(callback);
    await flush();
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.hostinger.com',
        port: 465,
        secure: true,
      }),
    );
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe('info@yugminds.org');
    expect(mail.subject).toBe('New call-back request: Ravi Kumar');
    expect(mail.text).toContain('Phone: +91 9876543210');
    expect(mail.replyTo).toBeUndefined();
  });

  it('lets the team reply straight to a brief sender', async () => {
    new LeadAlertsService().notify({
      kind: 'brief',
      name: 'Asha Rao',
      email: 'asha@example.com',
      topic: 'Project brief: A robot or smart device',
      message: 'A delivery robot for our warehouse.',
    });
    await flush();
    const mail = sendMail.mock.calls[0][0];
    expect(mail.replyTo).toBe('asha@example.com');
    expect(mail.text).toContain('A delivery robot for our warehouse.');
  });

  it('never throws to the caller when sending fails', async () => {
    sendMail.mockRejectedValue(new Error('SMTP down'));
    expect(() => new LeadAlertsService().notify(callback)).not.toThrow();
    await flush();
  });

  it('sends a fixed-template confirmation and never echoes sender-supplied text', async () => {
    new LeadAlertsService().confirmBrief({
      firstName: 'Asha',
      email: 'asha@example.com',
    });
    await flush();
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe('asha@example.com');
    expect(mail.replyTo).toBe('info@yugminds.org');
    expect(mail.subject).toBe("We've got your brief, Asha");
    expect(mail.text).toContain('Hi Asha,');
    expect(mail.text).not.toContain('Your brief');
  });

  it('falls back to a neutral greeting when the name is not a plain name', async () => {
    new LeadAlertsService().confirmBrief({
      firstName: 'Click http://evil.example/pay NOW <b>',
      email: 'victim@example.com',
    });
    await flush();
    const mail = sendMail.mock.calls[0][0];
    expect(mail.subject).toBe("We've got your brief, there");
    expect(mail.text).toContain('Hi there,');
    expect(mail.text).not.toContain('evil.example');
    expect(mail.html).not.toContain('evil.example');
  });

  it('sends a stage email and reports whether it went out', async () => {
    const svc = new LeadAlertsService();
    const a = {
      stage: 'interview',
      name: 'Ravi Kumar',
      email: 'ravi@example.com',
      role: 'Robotics Trainer',
      ref: 'YM-T-ABCDE',
    };
    expect(await svc.careerStage(a)).toBe(true);
    expect(sendMail.mock.calls[0][0].to).toBe('ravi@example.com');
    expect(await svc.careerStage({ ...a, stage: 'withdrawn' })).toBe(false);
    delete process.env.SMTP_PASS;
    expect(await new LeadAlertsService().careerStage(a)).toBe(false);
  });
});
