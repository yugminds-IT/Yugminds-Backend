/*
  Warnings:

  - Added the required column `grade` to the `JoinCode` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `JoinCode` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "JoinCode" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "grade" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;
