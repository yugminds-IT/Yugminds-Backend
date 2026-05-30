-- CreateTable StudentCertificate
CREATE TABLE "StudentCertificate" (
  "id" TEXT NOT NULL,
  "studentId" INTEGER NOT NULL,
  "courseId" TEXT NOT NULL,
  "certificateName" TEXT NOT NULL,
  "certificateUrl" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "issuedBy" INTEGER,

  CONSTRAINT "StudentCertificate_pkey" PRIMARY KEY ("id")
);

-- Unique: one certificate per student per course
CREATE UNIQUE INDEX "StudentCertificate_studentId_courseId_key"
ON "StudentCertificate" ("studentId", "courseId");

-- Indexes
CREATE INDEX "StudentCertificate_studentId_idx" ON "StudentCertificate" ("studentId");
CREATE INDEX "StudentCertificate_courseId_idx" ON "StudentCertificate" ("courseId");
CREATE INDEX "StudentCertificate_issuedAt_idx" ON "StudentCertificate" ("issuedAt");

-- Foreign keys
ALTER TABLE "StudentCertificate"
ADD CONSTRAINT "StudentCertificate_studentId_fkey"
FOREIGN KEY ("studentId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StudentCertificate"
ADD CONSTRAINT "StudentCertificate_courseId_fkey"
FOREIGN KEY ("courseId") REFERENCES "Course"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StudentCertificate"
ADD CONSTRAINT "StudentCertificate_issuedBy_fkey"
FOREIGN KEY ("issuedBy") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

