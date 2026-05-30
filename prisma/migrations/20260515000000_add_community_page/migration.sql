-- Community page CMS tables
CREATE TABLE "CommunityPageConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "heroTitle" TEXT NOT NULL DEFAULT 'Yugminds Community',
    "heroSubtitle" TEXT,
    "heroImageUrl" TEXT,
    "sectionTitles" JSONB,
    "sectionEnabled" JSONB,
    "impactStats" JSONB,
    "socialLinks" JSONB,
    "cornerPillars" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityPageConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommunityItem" (
    "id" TEXT NOT NULL,
    "sectionType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "description" TEXT,
    "mediaUrl" TEXT,
    "thumbnailUrl" TEXT,
    "creatorName" TEXT,
    "creatorAvatarUrl" TEXT,
    "externalUrl" TEXT,
    "ctaLabel" TEXT,
    "ctaUrl" TEXT,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "views" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommunityItemVersion" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityItemVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CommunityItem_sectionType_isPublished_orderIndex_idx" ON "CommunityItem"("sectionType", "isPublished", "orderIndex");
CREATE INDEX "CommunityItem_isFeatured_idx" ON "CommunityItem"("isFeatured");
CREATE INDEX "CommunityItem_updatedAt_idx" ON "CommunityItem"("updatedAt");
CREATE UNIQUE INDEX "CommunityItemVersion_itemId_versionNumber_key" ON "CommunityItemVersion"("itemId", "versionNumber");
CREATE INDEX "CommunityItemVersion_itemId_idx" ON "CommunityItemVersion"("itemId");

ALTER TABLE "CommunityItemVersion" ADD CONSTRAINT "CommunityItemVersion_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CommunityItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
