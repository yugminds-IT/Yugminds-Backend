-- AlterTable Assignment: due date
ALTER TABLE "Assignment" ADD COLUMN "dueDate" TIMESTAMP(3);

-- AlterTable AssignmentSubmission: attachment fields
ALTER TABLE "AssignmentSubmission" ADD COLUMN "fileUrl" TEXT;
ALTER TABLE "AssignmentSubmission" ADD COLUMN "textContent" TEXT;

