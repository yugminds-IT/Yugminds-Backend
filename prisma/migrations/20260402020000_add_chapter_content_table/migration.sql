-- Fix missing ChapterContent table required by AdminCoursesService.get()
CREATE TABLE "ChapterContent" (
    "id" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "contentText" TEXT,
    "contentUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "durationMinutes" INTEGER,
    "storagePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChapterContent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChapterContent_chapterId_idx" ON "ChapterContent"("chapterId");

-- AddForeignKey
ALTER TABLE "ChapterContent"
ADD CONSTRAINT "ChapterContent_chapterId_fkey"
FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

