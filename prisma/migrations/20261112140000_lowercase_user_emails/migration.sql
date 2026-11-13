-- User.email is stored trimmed + lowercase (login/reset look it up exactly).
-- Idempotent; the unique index makes this fail loudly if two rows would collide.
UPDATE "User" SET email = lower(btrim(email)) WHERE email <> lower(btrim(email));
