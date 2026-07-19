-- Store the S3 object key alongside the public URL, so replace/regenerate
-- flows can delete the old object without reverse-parsing it from the URL.
ALTER TABLE "StudentCertificate" ADD COLUMN IF NOT EXISTS "certificateKey" TEXT;
ALTER TABLE "Logo" ADD COLUMN IF NOT EXISTS "imageKey" TEXT;
