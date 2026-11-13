import { BadRequestException } from '@nestjs/common';
import { parsePhone } from './phone.util';

describe('parsePhone', () => {
  it.each([
    [undefined, null],
    [null, null],
    ['', null],
    ['   ', null],
    ['-', null],
    ['N/A', null],
    ['9876543210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['04066337733', '+914066337733'],
    ['919876543210', '+919876543210'],
    ['+919876543210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['(+91) 98765-43210', '+919876543210'],
    [' +1 415 555 2671 ', '+14155552671'],
  ])('%p -> %p', (input, out) => {
    expect(parsePhone(input)).toBe(out);
  });

  it.each([
    '12345',
    '98765',
    '+91 123',
    'abc123',
    '98765 43210 99',
    '0000000000',
    '+0123456789',
  ])('rejects %p', (input) => {
    expect(() => parsePhone(input)).toThrow(BadRequestException);
  });

  it('is idempotent', () => {
    const once = parsePhone('98765 43210');
    expect(parsePhone(once)).toBe(once);
  });
});
