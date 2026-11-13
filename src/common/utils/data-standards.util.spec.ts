import { BadRequestException } from '@nestjs/common';
import {
  parseGrade,
  parseStatus,
  parseSubject,
  parseTime,
} from './data-standards.util';

const rejects = (fn: () => unknown) => expect(fn).toThrow(BadRequestException);

describe('parseGrade', () => {
  it('accepts Grade 1–12 and blank', () => {
    expect(parseGrade('Grade 4')).toBe('Grade 4');
    expect(parseGrade('Grade 12')).toBe('Grade 12');
    expect(parseGrade('')).toBeNull();
    expect(parseGrade(null)).toBeNull();
  });
  it.each([
    '4',
    'grade 4',
    'Grade4',
    'Class 4',
    'Grade 0',
    'Grade 13',
    'Grade 04',
    ' Grade 4',
  ])('rejects %p', (v) => rejects(() => parseGrade(v)));
});

describe('parseTime', () => {
  it('accepts 24h HH:mm and blank', () => {
    for (const t of ['00:00', '09:05', '14:30', '23:59'])
      expect(parseTime(t)).toBe(t);
    expect(parseTime(undefined)).toBeNull();
  });
  it.each(['9:00', '09:5', '24:00', '12:60', '9:00 AM', '0900', '09:00:00'])(
    'rejects %p',
    (v) => rejects(() => parseTime(v)),
  );
});

describe('parseSubject', () => {
  it('accepts exactly the listed subjects', () => {
    for (const s of ['Robotics', 'Coding', 'AI/ML', 'Python', 'Other'])
      expect(parseSubject(s)).toBe(s);
    expect(parseSubject('  ')).toBeNull();
  });
  it.each(['coding', 'CODIND', 'Math', 'Coding '])('rejects %p', (v) =>
    rejects(() => parseSubject(v)),
  );
});

describe('parseStatus', () => {
  it('accepts listed values per model', () => {
    expect(parseStatus('TeacherReport', 'reviewed')).toBe('reviewed');
    expect(parseStatus('Attendance', 'Leave-Approved')).toBe('Leave-Approved');
  });
  it('rejects wrong spelling and values from another model', () => {
    rejects(() => parseStatus('TeacherLeave', 'Approved'));
    rejects(() => parseStatus('Attendance', 'present'));
    rejects(() => parseStatus('ContactSubmission', 'approved'));
  });
  it('ignores models with no list', () => {
    expect(parseStatus('Other', 'anything')).toBe('anything');
  });
});
