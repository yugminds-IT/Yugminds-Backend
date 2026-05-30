-- CreateIndex
CREATE INDEX "SchoolAdmin_userId_idx" ON "SchoolAdmin"("userId");

-- AddForeignKey
ALTER TABLE "SchoolAdmin" ADD CONSTRAINT "SchoolAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
