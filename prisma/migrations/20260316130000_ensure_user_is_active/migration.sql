-- Ensure User and Profile have all schema columns (fixes 500 "column (not available) does not exist" on GET /admin/teachers and GET /admin/students)

-- User.isActive
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'isActive') THEN
    ALTER TABLE "User" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
  END IF;
END $$;

-- Profile.qualification
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Profile' AND column_name = 'qualification') THEN
    ALTER TABLE "Profile" ADD COLUMN "qualification" TEXT;
  END IF;
END $$;

-- Profile.experience
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Profile' AND column_name = 'experience') THEN
    ALTER TABLE "Profile" ADD COLUMN "experience" TEXT;
  END IF;
END $$;

-- Profile.specialization
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Profile' AND column_name = 'specialization') THEN
    ALTER TABLE "Profile" ADD COLUMN "specialization" TEXT;
  END IF;
END $$;
