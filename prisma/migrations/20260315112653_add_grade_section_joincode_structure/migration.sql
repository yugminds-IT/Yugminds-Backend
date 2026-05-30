-- AlterTable
ALTER TABLE "JoinCode" ADD COLUMN     "gradeId" TEXT,
ADD COLUMN     "sectionId" TEXT;

-- CreateIndex
CREATE INDEX "JoinCode_sectionId_idx" ON "JoinCode"("sectionId");

-- CreateIndex
CREATE INDEX "JoinCode_gradeId_idx" ON "JoinCode"("gradeId");

-- AddForeignKey
ALTER TABLE "JoinCode" ADD CONSTRAINT "JoinCode_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JoinCode" ADD CONSTRAINT "JoinCode_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "Grade"("id") ON DELETE CASCADE ON UPDATE CASCADE;
