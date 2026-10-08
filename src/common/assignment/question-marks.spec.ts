import { BadRequestException } from '@nestjs/common';
import {
  assertQuestionMarksFitTotal,
  sumQuestionMarks,
} from './question-marks';

describe('question-marks', () => {
  it('sums positive marks and treats missing/invalid as 1', () => {
    expect(sumQuestionMarks([{ marks: 2 }, { marks: 3 }])).toBe(5);
    expect(sumQuestionMarks([{}, { marks: 0 }, { marks: -1 }])).toBe(3);
  });

  it('allows a total with room left, and skips when there is no cap or no questions', () => {
    expect(() =>
      assertQuestionMarksFitTotal(5, [{ marks: 1 }, { marks: 1 }]),
    ).not.toThrow();
    expect(() =>
      assertQuestionMarksFitTotal(null, [{ marks: 99 }]),
    ).not.toThrow();
    expect(() => assertQuestionMarksFitTotal(5, [])).not.toThrow();
  });

  it('rejects when question marks exceed the assignment total', () => {
    expect(() =>
      assertQuestionMarksFitTotal(5, [
        { marks: 1 },
        { marks: 1 },
        { marks: 1 },
        { marks: 1 },
        { marks: 1 },
        { marks: 1 },
      ]),
    ).toThrow(BadRequestException);
  });
});
