import { buildWordBank } from './word-bank';

describe('buildWordBank', () => {
  it('mixes correct answers with wrong choices', () => {
    const bank = buildWordBank('q1', 'say', ['move', 'turn', 'hide']);
    expect(bank).not.toBeNull();
    expect([...bank!].sort()).toEqual(['hide', 'move', 'say', 'turn']);
  });

  it('keeps one entry per blank and drops wrong choices that duplicate a correct answer', () => {
    const bank = buildWordBank('q2', 'motion, looks', [
      'Motion',
      'sound',
      'sound',
      ' ',
    ]);
    expect([...bank!].sort()).toEqual(['looks', 'motion', 'sound']);
  });

  it('is stable for the same question id', () => {
    const a = buildWordBank('same-id', 'say', [
      'move',
      'turn',
      'hide',
      'think',
    ]);
    const b = buildWordBank('same-id', 'say', [
      'move',
      'turn',
      'hide',
      'think',
    ]);
    expect(a).toEqual(b);
  });

  it('returns null without wrong choices (typed answer mode)', () => {
    expect(buildWordBank('q3', 'say', [])).toBeNull();
    expect(buildWordBank('q3', 'say', null)).toBeNull();
    expect(buildWordBank('q3', 'say', ['say'])).toBeNull();
  });

  it('returns null without a correct answer', () => {
    expect(buildWordBank('q4', '', ['move'])).toBeNull();
  });
});
