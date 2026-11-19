ALTER TABLE "JobOpening" ADD COLUMN "formConfig" JSONB;
ALTER TABLE "JobApplication" ALTER COLUMN "willTravel" DROP NOT NULL, ALTER COLUMN "willTravel" DROP DEFAULT;
ALTER TABLE "JobApplication" ALTER COLUMN "qualification" SET DEFAULT '';
ALTER TABLE "JobApplication" ALTER COLUMN "currentStatus" SET DEFAULT '';
ALTER TABLE "JobApplication" ALTER COLUMN "englishLevel" DROP NOT NULL, ALTER COLUMN "englishLevel" DROP DEFAULT;
ALTER TABLE "JobApplication" ALTER COLUMN "hasTwoWheeler" DROP NOT NULL, ALTER COLUMN "hasTwoWheeler" DROP DEFAULT;
