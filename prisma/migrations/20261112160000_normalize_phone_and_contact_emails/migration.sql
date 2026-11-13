-- One stored phone form: "+<country><digits>" (Indian: +91XXXXXXXXXX); blank/"-" -> NULL.
-- Mirrors parsePhone() in src/common/utils/phone.util.ts. Idempotent. Unparseable values are left untouched.
-- School.email: trimmed + lowercase (same rule as User.email).

UPDATE "Profile" SET "phone" = CASE
    WHEN "phone" !~ '[0-9]' THEN NULL
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^\+[1-9][0-9]{7,14}$' THEN regexp_replace("phone", '[\s\-().]', '', 'g')
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^[1-9][0-9]{9}$' THEN '+91' || regexp_replace("phone", '[\s\-().]', '', 'g')
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^0[0-9]{10}$' THEN '+91' || substr(regexp_replace("phone", '[\s\-().]', '', 'g'), 2)
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^91[1-9][0-9]{9}$' THEN '+' || regexp_replace("phone", '[\s\-().]', '', 'g')
    ELSE "phone"
  END
WHERE "phone" IS NOT NULL AND "phone" IS DISTINCT FROM (CASE
    WHEN "phone" !~ '[0-9]' THEN NULL
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^\+[1-9][0-9]{7,14}$' THEN regexp_replace("phone", '[\s\-().]', '', 'g')
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^[1-9][0-9]{9}$' THEN '+91' || regexp_replace("phone", '[\s\-().]', '', 'g')
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^0[0-9]{10}$' THEN '+91' || substr(regexp_replace("phone", '[\s\-().]', '', 'g'), 2)
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^91[1-9][0-9]{9}$' THEN '+' || regexp_replace("phone", '[\s\-().]', '', 'g')
    ELSE "phone"
  END);

UPDATE "Profile" SET "parentPhone" = CASE
    WHEN "parentPhone" !~ '[0-9]' THEN NULL
    WHEN regexp_replace("parentPhone", '[\s\-().]', '', 'g') ~ '^\+[1-9][0-9]{7,14}$' THEN regexp_replace("parentPhone", '[\s\-().]', '', 'g')
    WHEN regexp_replace("parentPhone", '[\s\-().]', '', 'g') ~ '^[1-9][0-9]{9}$' THEN '+91' || regexp_replace("parentPhone", '[\s\-().]', '', 'g')
    WHEN regexp_replace("parentPhone", '[\s\-().]', '', 'g') ~ '^0[0-9]{10}$' THEN '+91' || substr(regexp_replace("parentPhone", '[\s\-().]', '', 'g'), 2)
    WHEN regexp_replace("parentPhone", '[\s\-().]', '', 'g') ~ '^91[1-9][0-9]{9}$' THEN '+' || regexp_replace("parentPhone", '[\s\-().]', '', 'g')
    ELSE "parentPhone"
  END
WHERE "parentPhone" IS NOT NULL AND "parentPhone" IS DISTINCT FROM (CASE
    WHEN "parentPhone" !~ '[0-9]' THEN NULL
    WHEN regexp_replace("parentPhone", '[\s\-().]', '', 'g') ~ '^\+[1-9][0-9]{7,14}$' THEN regexp_replace("parentPhone", '[\s\-().]', '', 'g')
    WHEN regexp_replace("parentPhone", '[\s\-().]', '', 'g') ~ '^[1-9][0-9]{9}$' THEN '+91' || regexp_replace("parentPhone", '[\s\-().]', '', 'g')
    WHEN regexp_replace("parentPhone", '[\s\-().]', '', 'g') ~ '^0[0-9]{10}$' THEN '+91' || substr(regexp_replace("parentPhone", '[\s\-().]', '', 'g'), 2)
    WHEN regexp_replace("parentPhone", '[\s\-().]', '', 'g') ~ '^91[1-9][0-9]{9}$' THEN '+' || regexp_replace("parentPhone", '[\s\-().]', '', 'g')
    ELSE "parentPhone"
  END);

UPDATE "School" SET "phone" = CASE
    WHEN "phone" !~ '[0-9]' THEN NULL
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^\+[1-9][0-9]{7,14}$' THEN regexp_replace("phone", '[\s\-().]', '', 'g')
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^[1-9][0-9]{9}$' THEN '+91' || regexp_replace("phone", '[\s\-().]', '', 'g')
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^0[0-9]{10}$' THEN '+91' || substr(regexp_replace("phone", '[\s\-().]', '', 'g'), 2)
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^91[1-9][0-9]{9}$' THEN '+' || regexp_replace("phone", '[\s\-().]', '', 'g')
    ELSE "phone"
  END
WHERE "phone" IS NOT NULL AND "phone" IS DISTINCT FROM (CASE
    WHEN "phone" !~ '[0-9]' THEN NULL
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^\+[1-9][0-9]{7,14}$' THEN regexp_replace("phone", '[\s\-().]', '', 'g')
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^[1-9][0-9]{9}$' THEN '+91' || regexp_replace("phone", '[\s\-().]', '', 'g')
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^0[0-9]{10}$' THEN '+91' || substr(regexp_replace("phone", '[\s\-().]', '', 'g'), 2)
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^91[1-9][0-9]{9}$' THEN '+' || regexp_replace("phone", '[\s\-().]', '', 'g')
    ELSE "phone"
  END);

UPDATE "AcademyAccount" SET "phone" = CASE
    WHEN "phone" !~ '[0-9]' THEN NULL
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^\+[1-9][0-9]{7,14}$' THEN regexp_replace("phone", '[\s\-().]', '', 'g')
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^[1-9][0-9]{9}$' THEN '+91' || regexp_replace("phone", '[\s\-().]', '', 'g')
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^0[0-9]{10}$' THEN '+91' || substr(regexp_replace("phone", '[\s\-().]', '', 'g'), 2)
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^91[1-9][0-9]{9}$' THEN '+' || regexp_replace("phone", '[\s\-().]', '', 'g')
    ELSE "phone"
  END
WHERE "phone" IS NOT NULL AND "phone" IS DISTINCT FROM (CASE
    WHEN "phone" !~ '[0-9]' THEN NULL
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^\+[1-9][0-9]{7,14}$' THEN regexp_replace("phone", '[\s\-().]', '', 'g')
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^[1-9][0-9]{9}$' THEN '+91' || regexp_replace("phone", '[\s\-().]', '', 'g')
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^0[0-9]{10}$' THEN '+91' || substr(regexp_replace("phone", '[\s\-().]', '', 'g'), 2)
    WHEN regexp_replace("phone", '[\s\-().]', '', 'g') ~ '^91[1-9][0-9]{9}$' THEN '+' || regexp_replace("phone", '[\s\-().]', '', 'g')
    ELSE "phone"
  END);

UPDATE "School" SET email = lower(btrim(email)) WHERE email IS NOT NULL AND email <> lower(btrim(email));
UPDATE "ContactSubmission" SET email = lower(btrim(email)) WHERE email IS NOT NULL AND email <> lower(btrim(email));
UPDATE "AcademyAccount" SET email = lower(btrim(email)) WHERE email IS NOT NULL AND email <> lower(btrim(email));
