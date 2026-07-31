import { toReportUiStatus } from './report-status.util';

describe('toReportUiStatus', () => {
  it('maps each raw status to its UI vocabulary', () => {
    expect(toReportUiStatus('submitted')).toBe('Pending');
    expect(toReportUiStatus('reviewed')).toBe('Reviewed');
    expect(toReportUiStatus('approved')).toBe('Approved');
    expect(toReportUiStatus('rejected')).toBe('Rejected');
  });

  it('is case-insensitive', () => {
    expect(toReportUiStatus('APPROVED')).toBe('Approved');
    expect(toReportUiStatus('Rejected')).toBe('Rejected');
  });

  it('defaults to Pending for null/undefined/unknown values', () => {
    expect(toReportUiStatus(null)).toBe('Pending');
    expect(toReportUiStatus(undefined)).toBe('Pending');
    expect(toReportUiStatus('something-else')).toBe('Pending');
  });
});
