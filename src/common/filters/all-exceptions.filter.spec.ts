import { AllExceptionsFilter } from './all-exceptions.filter';
import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';

function mockHost(url = '/teacher/reports') {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status };
  const request = { method: 'POST', url, user: null };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('AllExceptionsFilter P2002 mapping', () => {
  const filter = new AllExceptionsFilter();
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

  afterAll(() => errorSpy.mockRestore());

  it('maps TeacherReport unique constraint to the report duplicate message', () => {
    const { host, status, json } = mockHost();
    filter.catch(
      {
        code: 'P2002',
        meta: { target: ['teacherId', 'schoolId', 'reportDate', 'periodId'] },
      },
      host,
    );
    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'A report for this period has already been submitted for this date.',
      }),
    );
  });

  it('keeps email unique as Email is already in use', () => {
    const { host, json } = mockHost('/admin/teachers');
    filter.catch({ code: 'P2002', meta: { target: ['email'] } }, host);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Email is already in use' }),
    );
  });

  it('uses a generic message for other unique constraints', () => {
    const { host, json } = mockHost();
    filter.catch({ code: 'P2002', meta: { target: ['schoolCode'] } }, host);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'A record with these values already exists',
      }),
    );
  });

  it('still forwards HttpException messages unchanged', () => {
    const { host, json } = mockHost();
    filter.catch(
      new HttpException('Cannot submit a report for a future date.', 400),
      host,
    );
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Cannot submit a report for a future date.',
      }),
    );
  });
});
