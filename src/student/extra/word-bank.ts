/**
 * Word bank for a fill-in-the-blank question: the correct answer(s) mixed with
 * the teacher's wrong choices (stored in `options`). Order is shuffled but
 * stable per question so reloads don't reshuffle under the student, and
 * nothing in the output marks which words are correct.
 * Returns null when the teacher gave no wrong choices (typed-answer mode).
 */
export function buildWordBank(
  questionId: string,
  correctAnswer: string | null | undefined,
  options: unknown,
): string[] | null {
  const correct = String(correctAnswer ?? '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const correctNorm = new Set(correct.map((s) => s.toLowerCase()));

  const seen = new Set<string>();
  const wrong = (Array.isArray(options) ? options : [])
    .map((s) => String(s ?? '').trim())
    .filter((s) => {
      const key = s.toLowerCase();
      if (!s || correctNorm.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (wrong.length === 0 || correct.length === 0) return null;

  const words = [...correct, ...wrong];
  const rand = seededRandom(questionId);
  for (let i = words.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [words[i], words[j]] = [words[j], words[i]];
  }
  return words;
}

function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
