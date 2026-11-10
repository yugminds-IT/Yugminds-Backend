import {
  buildJoinCodeCandidate,
  JOIN_CODE_RANDOM_LENGTH,
  randomJoinCodeSuffix,
} from './join-code.util';

describe('joining codes are not derivable from public school info', () => {
  it('keeps the readable prefix and adds a random suffix', () => {
    const code = buildJoinCodeCandidate('GVPS', 'G4', 'A');
    expect(code).toMatch(
      new RegExp(`^YUG-GVPS-G4-A-[2-9A-HJKMNP-Z]{${JOIN_CODE_RANDOM_LENGTH}}$`),
    );
    expect(buildJoinCodeCandidate('GVPS', 'G4')).toMatch(
      new RegExp(`^YUG-GVPS-G4-[2-9A-HJKMNP-Z]{${JOIN_CODE_RANDOM_LENGTH}}$`),
    );
  });

  it('never produces the same code twice for the same school/grade/section', () => {
    const codes = new Set(
      Array.from({ length: 2000 }, () =>
        buildJoinCodeCandidate('GVPS', 'G4', 'A'),
      ),
    );
    expect(codes.size).toBe(2000);
    expect(randomJoinCodeSuffix(12)).toHaveLength(12);
  });
});
