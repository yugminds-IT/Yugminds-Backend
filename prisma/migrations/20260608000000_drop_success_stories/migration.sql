-- Drop the deprecated Success Stories feature (replaced by Community).
-- Child table first (it holds the FK to SuccessStorySection).
DROP TABLE IF EXISTS "SuccessStoryVersion";
DROP TABLE IF EXISTS "SuccessStorySection";
