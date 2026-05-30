-- CreateTable
CREATE TABLE "CourseVersion" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "changesSummary" TEXT,
    "snapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourseVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourseVersion_courseId_idx" ON "CourseVersion"("courseId");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "CourseVersion_courseId_versionNumber_key" ON "CourseVersion"("courseId", "versionNumber");

-- AddForeignKey
ALTER TABLE "CourseVersion" ADD CONSTRAINT "CourseVersion_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
