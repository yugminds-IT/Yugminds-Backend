-- Subject is a fixed list (Robotics, Coding, AI/ML, Python, Other). Fix the
-- 4 off-list Assignment rows found in the live audit.
UPDATE "Assignment" SET subject = 'Coding' WHERE subject IN ('CODIND', 'coding');
UPDATE "Assignment" SET subject = 'Other' WHERE subject = 'Math';
