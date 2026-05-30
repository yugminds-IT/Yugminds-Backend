-- AlterTable
ALTER TABLE "Logo" ADD COLUMN "schoolId" TEXT;

-- CreateIndex
CREATE INDEX "Logo_schoolId_idx" ON "Logo"("schoolId");
