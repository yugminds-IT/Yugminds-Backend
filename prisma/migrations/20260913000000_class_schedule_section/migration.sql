-- AlterTable
ALTER TABLE "ClassSchedule" ADD COLUMN IF NOT EXISTS "section" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ClassSchedule_schoolId_grade_section_idx" ON "ClassSchedule"("schoolId", "grade", "section");
