import {
  examDeadline,
  duePhase,
  dueClosesAt,
  resolveCloseDate,
  examPhase,
  parseAssignmentType,
  parseExamFields,
} from './assignment-types';

const t = (s: string) => new Date(s);
const win = {
  startsAt: t('2026-11-20T10:00:00Z'),
  endsAt: t('2026-11-20T12:00:00Z'),
};

describe('assignment types', () => {
  it('rejects unknown types, accepts EXAM', () => {
    expect(parseAssignmentType('EXAM')).toBe('EXAM');
    expect(() => parseAssignmentType('QUIZ')).toThrow();
  });

  it('phases follow the server window', () => {
    expect(examPhase(win, t('2026-11-20T09:59:59Z'))).toBe('upcoming');
    expect(examPhase(win, t('2026-11-20T11:00:00Z'))).toBe('open');
    expect(examPhase(win, t('2026-11-20T12:00:01Z'))).toBe('closed');
  });

  it('deadline is capped by duration and by window end', () => {
    const a = { ...win, durationMinutes: 30 };
    expect(examDeadline(a, t('2026-11-20T10:10:00Z'))).toEqual(
      t('2026-11-20T10:40:00Z'),
    );
    expect(examDeadline(a, t('2026-11-20T11:50:00Z'))).toEqual(win.endsAt);
  });

  it('validates exam fields', () => {
    const ok = {
      exam_type: 'ANNUAL',
      starts_at: win.startsAt,
      ends_at: win.endsAt,
    };
    expect(
      parseExamFields({ ...ok, duration_minutes: 60 }).durationMinutes,
    ).toBe(60);
    expect(() => parseExamFields({ ...ok, ends_at: win.startsAt })).toThrow();
    expect(() => parseExamFields({ ...ok, duration_minutes: 0 })).toThrow();
    expect(() => parseExamFields({ ...ok, duration_minutes: 121 })).toThrow();
    expect(() => parseExamFields({ ...ok, exam_type: 'NOPE' })).toThrow();
  });

  it('due phase runs to end of due day IST and honours policy', () => {
    const due = t('2026-10-10T00:00:00Z');
    expect(dueClosesAt(due)).toEqual(t('2026-10-10T18:29:59.999Z'));
    const a = { dueDate: due, lateSubmissionPolicy: 'close' };
    expect(duePhase(a, t('2026-10-10T18:00:00Z'))).toBe('open');
    expect(duePhase(a, t('2026-10-10T18:30:00Z'))).toBe('closed');
    expect(
      duePhase(
        { ...a, lateSubmissionPolicy: 'allow' },
        t('2026-10-11T00:00:00Z'),
      ),
    ).toBe('late');
    expect(duePhase({ dueDate: null }, t('2030-01-01T00:00:00Z'))).toBe('open');
    expect(
      duePhase({ ...a, assignmentType: 'EXAM' }, t('2030-01-01T00:00:00Z')),
    ).toBe('open');
  });

  it('close date extends the late window, then closes', () => {
    const a = {
      dueDate: t('2026-10-10T00:00:00Z'),
      closeDate: t('2026-10-14T00:00:00Z'),
      lateSubmissionPolicy: 'allow',
    };
    expect(duePhase(a, t('2026-10-12T00:00:00Z'))).toBe('late');
    expect(duePhase(a, t('2026-10-14T18:29:00Z'))).toBe('late');
    expect(duePhase(a, t('2026-10-14T18:31:00Z'))).toBe('closed');
    expect(
      duePhase(
        { ...a, lateSubmissionPolicy: 'close' },
        t('2026-10-12T00:00:00Z'),
      ),
    ).toBe('closed');
  });

  it('validates close date', () => {
    const due = t('2026-10-10T00:00:00Z');
    expect(resolveCloseDate('allow', due, '2026-10-12')).toEqual(
      t('2026-10-12T00:00:00Z'),
    );
    expect(resolveCloseDate('allow', due, '2026-10-10')).toEqual(
      t('2026-10-10T00:00:00Z'),
    );
    expect(resolveCloseDate('close', due, '2026-10-12')).toBeNull();
    expect(resolveCloseDate('allow', due, '')).toBeNull();
    expect(() => resolveCloseDate('allow', due, '2026-10-09')).toThrow();
    expect(() => resolveCloseDate('allow', null, '2026-10-09')).toThrow();
  });
});
