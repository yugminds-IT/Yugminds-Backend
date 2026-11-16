import {
  firstName,
  hrNewEmail,
  hrWithdrawnEmail,
  receivedEmail,
  stageEmail,
  STAGE_EMAIL_STAGES,
} from './careers-mail';

const a = { first: 'Ravi', role: 'Robotics Trainer', ref: 'YM-T-ABCDE' };

describe('stageEmail', () => {
  it('builds subject, text and html for every emailed stage', () => {
    expect(STAGE_EMAIL_STAGES).toEqual([
      'screening',
      'interview',
      'demo_class',
      'offer',
      'hired',
      'on_hold',
      'rejected',
    ]);
    for (const s of STAGE_EMAIL_STAGES) {
      const m = stageEmail(s, a)!;
      expect(m.subject).toBeTruthy();
      expect(m.text).toContain('Ravi');
      expect(m.text).toContain('YM-T-ABCDE');
      expect(m.html).toContain('Robotics Trainer');
    }
  });

  it('returns null for internal stages', () => {
    for (const s of ['new', 'withdrawn']) expect(stageEmail(s, a)).toBeNull();
  });

  it('escapes the reviewer note and role in html', () => {
    const m = stageEmail('interview', {
      ...a,
      role: '<b>x</b>',
      note: '<script>alert(1)</script>\nSat 10am',
    })!;
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<b>x</b>');
    expect(m.html).toContain('Sat 10am');
  });

  it('shows the hiring rail only for forward stages', () => {
    expect(stageEmail('offer', a)!.html).toContain('Demo class');
    expect(stageEmail('rejected', a)!.html).not.toContain('Demo class');
    expect(stageEmail('on_hold', a)!.html).not.toContain('Demo class');
  });

  it('falls back to "there" for odd names', () => {
    expect(firstName('Ravi Kumar')).toBe('Ravi');
    expect(firstName('<img src=x>')).toBe('there');
  });
});

describe('other careers emails', () => {
  const b = {
    ...a,
    name: 'Ravi <b>',
    email: 'r@x.com',
    phone: '+919876543210',
    city: 'Hyd',
  };
  it('received email shows the reference and a status link', () => {
    const m = receivedEmail(a);
    expect(m.html).toContain('YM-T-ABCDE');
    expect(m.text).toContain('/careers/status?ref=YM-T-ABCDE');
  });
  it('HR emails escape applicant text', () => {
    expect(hrNewEmail(b).html).not.toContain('<b>');
    expect(hrWithdrawnEmail(b).html).not.toContain('<b>');
  });
});
