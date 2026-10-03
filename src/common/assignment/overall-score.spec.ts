import { overallScore } from './overall-score';

describe('overallScore', () => {
  it('weights course 60% and daily 40% when both exist', () => {
    expect(overallScore(80, 50)).toBe(68);
  });

  it('uses the only available component on its own', () => {
    expect(overallScore(null, 100)).toBe(100);
    expect(overallScore(70, null)).toBe(70);
  });

  it('is 0 with no graded work', () => {
    expect(overallScore(null, null)).toBe(0);
  });

  it('keeps a real 0% course score in the weighting', () => {
    expect(overallScore(0, 100)).toBe(40);
  });
});
