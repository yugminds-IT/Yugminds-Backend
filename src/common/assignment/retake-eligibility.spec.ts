import { canRetakeAssignment, RetakeSettings } from './retake-eligibility';

const base: RetakeSettings = {
  retakeEnabled: true,
  maxRetakeAttempts: 1,
  retakeAccessScope: 'all',
  retakeWindowOpen: true,
};

describe('canRetakeAssignment', () => {
  it('is false when retakes are disabled and there is no grant', () => {
    expect(
      canRetakeAssignment({ ...base, retakeEnabled: false }, 1, false),
    ).toBe(false);
  });

  it('respects the attempt cap (max retakes + the first attempt)', () => {
    expect(canRetakeAssignment(base, 1, false)).toBe(true);
    expect(canRetakeAssignment(base, 2, false)).toBe(false);
  });

  it('needs a personal grant when access is limited to selected students', () => {
    const selected = { ...base, retakeAccessScope: 'selected' };
    expect(canRetakeAssignment(selected, 1, false)).toBe(false);
    expect(canRetakeAssignment(selected, 1, true)).toBe(true);
  });

  it('needs an open window or a grant for fixed-attempt assignments', () => {
    const closed = { ...base, retakeWindowOpen: false };
    expect(canRetakeAssignment(closed, 1, false)).toBe(false);
    expect(canRetakeAssignment(closed, 1, true)).toBe(true);
  });

  it('ignores the window when attempts are unlimited', () => {
    expect(
      canRetakeAssignment(
        { ...base, maxRetakeAttempts: null, retakeWindowOpen: false },
        9,
        false,
      ),
    ).toBe(true);
  });

  it('a personal grant allows one attempt even with class retakes off or the cap used up', () => {
    expect(
      canRetakeAssignment({ ...base, retakeEnabled: false }, 1, true),
    ).toBe(true);
    expect(canRetakeAssignment(base, 5, true)).toBe(true);
  });
});
