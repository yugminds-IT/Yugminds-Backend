-- CreateTable Logo for school logos
CREATE TABLE "Logo" (
    "id" TEXT NOT NULL,
    "schoolName" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "Logo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Logo_createdAt_idx" ON "Logo"("createdAt");
