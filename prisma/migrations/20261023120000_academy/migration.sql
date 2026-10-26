-- RoboCoders Academy: standalone B2C app (own accounts, courses, progress, commerce).
-- No LMS tables are altered.
-- CreateEnum
CREATE TYPE "AcademyRole" AS ENUM ('LEARNER', 'TUTOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "AcademyLessonType" AS ENUM ('VIDEO', 'PDF', 'TEXT', 'QUIZ', 'LINK');

-- CreateEnum
CREATE TYPE "AcademyEnrollmentSource" AS ENUM ('PURCHASE', 'GRANT');

-- CreateEnum
CREATE TYPE "AcademyProductType" AS ENUM ('COURSE', 'SESSION_PACK');

-- CreateEnum
CREATE TYPE "AcademyOrderStatus" AS ENUM ('CREATED', 'PAID', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "AcademyBookingStatus" AS ENUM ('CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- CreateTable
CREATE TABLE "AcademyAccount" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "AcademyRole" NOT NULL DEFAULT 'LEARNER',
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "parentName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademyAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyCourse" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "thumbnailUrl" TEXT,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "importedFromLmsCourseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademyCourse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyModule" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AcademyModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyLesson" (
    "id" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "AcademyLessonType" NOT NULL,
    "contentUrl" TEXT,
    "body" TEXT,
    "quiz" JSONB,
    "durationMinutes" INTEGER,
    "isPreview" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AcademyLesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyEnrollment" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "source" "AcademyEnrollmentSource" NOT NULL,
    "orderId" TEXT,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AcademyEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyLessonProgress" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "quizScore" INTEGER,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademyLessonProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyCertificate" (
    "id" TEXT NOT NULL,
    "shortId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "learnerName" TEXT NOT NULL,
    "courseTitle" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademyCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyProduct" (
    "id" TEXT NOT NULL,
    "type" "AcademyProductType" NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "thumbnailUrl" TEXT,
    "priceInPaise" INTEGER NOT NULL,
    "mrpInPaise" INTEGER,
    "courseId" TEXT,
    "sessionMinutes" INTEGER,
    "sessionCount" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademyProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyOrder" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "amountInPaise" INTEGER NOT NULL,
    "status" "AcademyOrderStatus" NOT NULL DEFAULT 'CREATED',
    "razorpayOrderId" TEXT NOT NULL,
    "razorpayPaymentId" TEXT,
    "receiptNo" TEXT NOT NULL,
    "buyerName" TEXT,
    "buyerPhone" TEXT,
    "paidAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademyOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyTutorProfile" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "headline" TEXT,
    "bio" TEXT,
    "subjects" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "photoUrl" TEXT,
    "defaultMeetingLink" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademyTutorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyTutorAvailability" (
    "id" TEXT NOT NULL,
    "tutorId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,

    CONSTRAINT "AcademyTutorAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademySessionCredit" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "orderId" TEXT,
    "total" INTEGER NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "minutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademySessionCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyBooking" (
    "id" TEXT NOT NULL,
    "tutorId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "creditId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "AcademyBookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "meetingLink" TEXT,
    "tutorNotes" TEXT,
    "cancelledBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademyBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AcademyAccount_email_key" ON "AcademyAccount"("email");

-- CreateIndex
CREATE INDEX "AcademyAccount_role_createdAt_idx" ON "AcademyAccount"("role", "createdAt");

-- CreateIndex
CREATE INDEX "AcademyModule_courseId_sortOrder_idx" ON "AcademyModule"("courseId", "sortOrder");

-- CreateIndex
CREATE INDEX "AcademyLesson_moduleId_sortOrder_idx" ON "AcademyLesson"("moduleId", "sortOrder");

-- CreateIndex
CREATE INDEX "AcademyEnrollment_courseId_idx" ON "AcademyEnrollment"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyEnrollment_learnerId_courseId_key" ON "AcademyEnrollment"("learnerId", "courseId");

-- CreateIndex
CREATE INDEX "AcademyLessonProgress_learnerId_courseId_idx" ON "AcademyLessonProgress"("learnerId", "courseId");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyLessonProgress_learnerId_lessonId_key" ON "AcademyLessonProgress"("learnerId", "lessonId");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyCertificate_shortId_key" ON "AcademyCertificate"("shortId");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyCertificate_learnerId_courseId_key" ON "AcademyCertificate"("learnerId", "courseId");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyProduct_slug_key" ON "AcademyProduct"("slug");

-- CreateIndex
CREATE INDEX "AcademyProduct_isActive_sortOrder_idx" ON "AcademyProduct"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyOrder_razorpayOrderId_key" ON "AcademyOrder"("razorpayOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyOrder_receiptNo_key" ON "AcademyOrder"("receiptNo");

-- CreateIndex
CREATE INDEX "AcademyOrder_accountId_idx" ON "AcademyOrder"("accountId");

-- CreateIndex
CREATE INDEX "AcademyOrder_status_createdAt_idx" ON "AcademyOrder"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyTutorProfile_accountId_key" ON "AcademyTutorProfile"("accountId");

-- CreateIndex
CREATE INDEX "AcademyTutorAvailability_tutorId_idx" ON "AcademyTutorAvailability"("tutorId");

-- CreateIndex
CREATE INDEX "AcademySessionCredit_learnerId_idx" ON "AcademySessionCredit"("learnerId");

-- CreateIndex
CREATE INDEX "AcademyBooking_tutorId_startsAt_idx" ON "AcademyBooking"("tutorId", "startsAt");

-- CreateIndex
CREATE INDEX "AcademyBooking_learnerId_startsAt_idx" ON "AcademyBooking"("learnerId", "startsAt");

-- CreateIndex
CREATE INDEX "AcademyBooking_status_startsAt_idx" ON "AcademyBooking"("status", "startsAt");

-- AddForeignKey
ALTER TABLE "AcademyModule" ADD CONSTRAINT "AcademyModule_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "AcademyCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyLesson" ADD CONSTRAINT "AcademyLesson_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "AcademyModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyProduct" ADD CONSTRAINT "AcademyProduct_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "AcademyCourse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyOrder" ADD CONSTRAINT "AcademyOrder_productId_fkey" FOREIGN KEY ("productId") REFERENCES "AcademyProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyTutorAvailability" ADD CONSTRAINT "AcademyTutorAvailability_tutorId_fkey" FOREIGN KEY ("tutorId") REFERENCES "AcademyTutorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademySessionCredit" ADD CONSTRAINT "AcademySessionCredit_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "AcademyOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyBooking" ADD CONSTRAINT "AcademyBooking_creditId_fkey" FOREIGN KEY ("creditId") REFERENCES "AcademySessionCredit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One live booking per tutor slot. Partial (not expressible in schema.prisma) so a
-- CANCELLED booking frees the slot for someone else.
CREATE UNIQUE INDEX "AcademyBooking_tutor_slot_live_key" ON "AcademyBooking"("tutorId", "startsAt")
  WHERE "status" IN ('CONFIRMED', 'COMPLETED', 'NO_SHOW');
