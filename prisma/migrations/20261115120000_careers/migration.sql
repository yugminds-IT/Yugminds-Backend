CREATE TABLE IF NOT EXISTS "JobOpening" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "location" TEXT NOT NULL,
  "jobType" TEXT NOT NULL DEFAULT 'Full-time, Permanent',
  "payMin" INTEGER,
  "payMax" INTEGER,
  "team" TEXT NOT NULL DEFAULT 'Teaching',
  "description" TEXT NOT NULL,
  "details" JSONB,
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JobOpening_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "JobOpening_slug_key" ON "JobOpening"("slug");

CREATE TABLE IF NOT EXISTS "JobApplication" (
  "id" TEXT NOT NULL,
  "refCode" TEXT NOT NULL,
  "openingId" TEXT NOT NULL,
  "fullName" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "willTravel" BOOLEAN NOT NULL DEFAULT true,
  "qualification" TEXT NOT NULL,
  "college" TEXT,
  "gradYear" INTEGER,
  "experienceYears" INTEGER NOT NULL DEFAULT 0,
  "currentStatus" TEXT NOT NULL,
  "skills" TEXT[],
  "gradeBands" TEXT[],
  "englishLevel" INTEGER NOT NULL DEFAULT 3,
  "hasTwoWheeler" BOOLEAN NOT NULL DEFAULT false,
  "answers" JSONB NOT NULL,
  "expectedSalary" INTEGER,
  "joinDate" TEXT,
  "heardFrom" TEXT,
  "videoUrl" TEXT,
  "resumeKey" TEXT,
  "resumeName" TEXT,
  "stage" TEXT NOT NULL DEFAULT 'new',
  "rating" INTEGER,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JobApplication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JobApplication_openingId_fkey" FOREIGN KEY ("openingId") REFERENCES "JobOpening"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "JobApplication_refCode_key" ON "JobApplication"("refCode");
CREATE UNIQUE INDEX IF NOT EXISTS "JobApplication_openingId_email_key" ON "JobApplication"("openingId", "email");
CREATE INDEX IF NOT EXISTS "JobApplication_stage_idx" ON "JobApplication"("stage");
CREATE INDEX IF NOT EXISTS "JobApplication_createdAt_idx" ON "JobApplication"("createdAt");
CREATE INDEX IF NOT EXISTS "JobApplication_deletedAt_idx" ON "JobApplication"("deletedAt");

CREATE TABLE IF NOT EXISTS "JobApplicationEvent" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "fromStage" TEXT,
  "toStage" TEXT,
  "body" TEXT,
  "actorId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobApplicationEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JobApplicationEvent_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "JobApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "JobApplicationEvent_applicationId_createdAt_idx" ON "JobApplicationEvent"("applicationId", "createdAt");

INSERT INTO "JobOpening" ("id","slug","title","location","jobType","payMin","payMax","team","details","description","status","updatedAt")
VALUES ('robotics-trainer-1','robotics-trainer','Robotics Trainer','Begumpet, Hyderabad, Telangana','Full-time, Permanent',15000,22000,'Teaching',
'{"teach":["Coding (Scratch, Python)","Robotics with Robocoders kits","AI and machine learning basics"],"seeking":["Passionate about technology and working with children","Comfortable speaking English in front of a class","Willing to travel to partner schools; a two-wheeler helps","Freshers welcome"]}'::jsonb,
'Deliver engaging coding, robotics and AI/ML lessons in schools using our own curriculum and Robocoders kits. Full training provided; no prior teaching or robotics experience required. In-person at partner schools across Hyderabad.',
'open', CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;
