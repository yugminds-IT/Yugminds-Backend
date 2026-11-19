import { BadRequestException } from '@nestjs/common';
import { CareersAdminController } from './careers-admin.controller';

const app = {
  id: 'a1',
  openingId: 'o1',
  fullName: 'Ravi Kumar',
  email: 'r@x.com',
  refCode: 'YM-T-ABCDE',
  stage: 'rejected',
  title: 'Trainer',
};

function setup(result: { sent: boolean; reason?: string }) {
  const db: any = {
    jobApplication: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ ...app, opening: { title: 'Trainer' } }),
      update: jest.fn().mockResolvedValue({}),
    },
    jobOpening: {
      findUnique: jest.fn().mockResolvedValue({ title: 'Trainer' }),
    },
    jobApplicationEvent: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue({ fromStage: 'rejected' }),
    },
  };
  const mail: any = { careerStage: jest.fn().mockResolvedValue(result) };
  return { db, mail, c: new CareersAdminController(db, {} as any, mail) };
}

describe('CareersAdminController emails', () => {
  it('requires date/time/place to email an interview', async () => {
    const { c, db } = setup({ sent: true });
    await expect(
      c.update('a1', { stage: 'interview' }, { id: 1 }),
    ).rejects.toThrow(BadRequestException);
    expect(db.jobApplication.update).not.toHaveBeenCalled();
  });

  it('marks reopened and logs a sent email', async () => {
    const { c, db, mail } = setup({ sent: true });
    const r = await c.update('a1', { stage: 'screening' }, { id: 1 });
    expect(mail.careerStage.mock.calls[0][0].reopened).toBe(true);
    expect(r.emailed).toBe(true);
    expect(db.jobApplicationEvent.create.mock.calls[0][0].data.type).toBe(
      'email',
    );
  });

  it('logs a failed send so it can be resent, but not a missing mailer', async () => {
    let t = setup({ sent: false, reason: 'failed' });
    expect(
      (await t.c.update('a1', { stage: 'screening' }, { id: 1 })).reason,
    ).toBe('failed');
    expect(t.db.jobApplicationEvent.create.mock.calls[0][0].data.type).toBe(
      'email_failed',
    );
    t = setup({ sent: false, reason: 'not_configured' });
    await t.c.update('a1', { stage: 'screening' }, { id: 1 });
    expect(t.db.jobApplicationEvent.create).not.toHaveBeenCalled();
  });

  it('previews without sending and rejects stages with no email', async () => {
    const { c, mail } = setup({ sent: true });
    const p = await c.preview('a1', { stage: 'screening', message: 'hi' });
    expect(p.html).toContain('reopened');
    expect(mail.careerStage).not.toHaveBeenCalled();
    await expect(c.preview('a1', { stage: 'new' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('resend keeps the reopened wording and refuses an interview with no details', async () => {
    const { c, mail, db } = setup({ sent: true });
    db.jobApplication.findFirst.mockResolvedValue({
      ...app,
      stage: 'screening',
    });
    await c.resend('a1', {}, { id: 1 });
    expect(mail.careerStage.mock.calls[0][0].reopened).toBe(true);
    db.jobApplication.findFirst.mockResolvedValue({
      ...app,
      stage: 'interview',
    });
    await expect(c.resend('a1', {}, { id: 1 })).rejects.toThrow(
      BadRequestException,
    );
  });
});
