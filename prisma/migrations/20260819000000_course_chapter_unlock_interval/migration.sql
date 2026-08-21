-- Chapter drip-unlock schedule: chapter at position K unlocks at
-- enrollment date + K * chapterUnlockIntervalDays, ANDed with the existing
-- completion-gate. NULL = no drip (today's pure completion-gating,
-- unchanged for every existing course).
ALTER TABLE "Course" ADD COLUMN "chapterUnlockIntervalDays" INTEGER;
