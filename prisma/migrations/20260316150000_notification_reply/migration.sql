-- CreateTable NotificationReply
CREATE TABLE "NotificationReply" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "replyText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationReply_notificationId_idx" ON "NotificationReply"("notificationId");
CREATE INDEX "NotificationReply_userId_idx" ON "NotificationReply"("userId");

-- AddForeignKey
ALTER TABLE "NotificationReply" ADD CONSTRAINT "NotificationReply_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationReply" ADD CONSTRAINT "NotificationReply_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
