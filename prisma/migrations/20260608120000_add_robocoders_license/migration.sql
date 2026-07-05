-- CreateTable
CREATE TABLE "RobocodersLicense" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "systemLabel" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "licenseNumber" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "expiryDate" TIMESTAMP(3) NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "activationKey" TEXT NOT NULL,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RobocodersLicense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RobocodersLicense_schoolId_idx" ON "RobocodersLicense"("schoolId");

-- CreateIndex
CREATE INDEX "RobocodersLicense_machineId_idx" ON "RobocodersLicense"("machineId");

-- CreateIndex
CREATE INDEX "RobocodersLicense_schoolId_machineId_idx" ON "RobocodersLicense"("schoolId", "machineId");

-- AddForeignKey
ALTER TABLE "RobocodersLicense" ADD CONSTRAINT "RobocodersLicense_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
