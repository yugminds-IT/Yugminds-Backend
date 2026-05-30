-- CreateTable
CREATE TABLE "TeacherSectionAssignment" (
    "id" TEXT NOT NULL,
    "teacherId" INTEGER NOT NULL,
    "sectionId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherSectionAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeacherSectionAssignment_teacherId_sectionId_key" ON "TeacherSectionAssignment"("teacherId", "sectionId");

-- CreateIndex
CREATE INDEX "TeacherSectionAssignment_teacherId_idx" ON "TeacherSectionAssignment"("teacherId");

-- CreateIndex
CREATE INDEX "TeacherSectionAssignment_sectionId_idx" ON "TeacherSectionAssignment"("sectionId");

-- CreateIndex
CREATE INDEX "TeacherSectionAssignment_schoolId_idx" ON "TeacherSectionAssignment"("schoolId");

-- AddForeignKey
ALTER TABLE "TeacherSectionAssignment" ADD CONSTRAINT "TeacherSectionAssignment_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherSectionAssignment" ADD CONSTRAINT "TeacherSectionAssignment_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherSectionAssignment" ADD CONSTRAINT "TeacherSectionAssignment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
