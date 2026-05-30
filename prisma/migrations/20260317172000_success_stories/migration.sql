-- CreateTable SuccessStorySection
CREATE TABLE "SuccessStorySection" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "bodyPrimary" TEXT NOT NULL,
  "bodySecondary" TEXT,
  "bodyTertiary" TEXT,
  "imageUrl" TEXT,
  "storagePath" TEXT,
  "background" TEXT NOT NULL DEFAULT 'white',
  "imagePosition" TEXT NOT NULL DEFAULT 'left',
  "orderIndex" INTEGER NOT NULL DEFAULT 0,
  "isPublished" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SuccessStorySection_pkey" PRIMARY KEY ("id")
);

-- CreateTable SuccessStoryVersion
CREATE TABLE "SuccessStoryVersion" (
  "id" TEXT NOT NULL,
  "sectionId" TEXT NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SuccessStoryVersion_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "SuccessStorySection_isPublished_idx" ON "SuccessStorySection"("isPublished");
CREATE INDEX "SuccessStorySection_orderIndex_idx" ON "SuccessStorySection"("orderIndex");
CREATE INDEX "SuccessStorySection_updatedAt_idx" ON "SuccessStorySection"("updatedAt");
CREATE INDEX "SuccessStoryVersion_sectionId_idx" ON "SuccessStoryVersion"("sectionId");

-- Unique
CREATE UNIQUE INDEX "SuccessStoryVersion_sectionId_versionNumber_key" ON "SuccessStoryVersion"("sectionId", "versionNumber");

-- ForeignKey
ALTER TABLE "SuccessStoryVersion" ADD CONSTRAINT "SuccessStoryVersion_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "SuccessStorySection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
