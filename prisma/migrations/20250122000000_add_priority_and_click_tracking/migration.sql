-- CreateEnum (if not exists)
DO $$ BEGIN
    CREATE TYPE "CampaignPriority" AS ENUM ('low', 'normal', 'high', 'urgent');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AlterTable (if column doesn't exist)
DO $$ BEGIN
    ALTER TABLE "Campaign" ADD COLUMN "priority" "CampaignPriority" NOT NULL DEFAULT 'normal';
EXCEPTION
    WHEN duplicate_column THEN null;
END $$;

-- CreateIndex (if not exists)
CREATE INDEX IF NOT EXISTS "Campaign_priority_idx" ON "Campaign"("priority");

-- CreateTable (if not exists)
CREATE TABLE IF NOT EXISTS "ClickEvent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "recipientId" TEXT,
    "contactId" TEXT,
    "phoneE164" TEXT NOT NULL,
    "linkType" TEXT NOT NULL DEFAULT 'unsubscribe',
    "clickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "ClickEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (if not exists)
CREATE INDEX IF NOT EXISTS "ClickEvent_campaignId_idx" ON "ClickEvent"("campaignId");
CREATE INDEX IF NOT EXISTS "ClickEvent_recipientId_idx" ON "ClickEvent"("recipientId");
CREATE INDEX IF NOT EXISTS "ClickEvent_contactId_idx" ON "ClickEvent"("contactId");
CREATE INDEX IF NOT EXISTS "ClickEvent_phoneE164_idx" ON "ClickEvent"("phoneE164");
CREATE INDEX IF NOT EXISTS "ClickEvent_clickedAt_idx" ON "ClickEvent"("clickedAt");
CREATE INDEX IF NOT EXISTS "ClickEvent_campaignId_clickedAt_idx" ON "ClickEvent"("campaignId", "clickedAt");

-- CreateUniqueIndex (if not exists)
CREATE UNIQUE INDEX IF NOT EXISTS "ClickEvent_campaignId_recipientId_linkType_key" ON "ClickEvent"("campaignId", "recipientId", "linkType");

-- AddForeignKey (if not exists)
DO $$ BEGIN
    ALTER TABLE "ClickEvent" ADD CONSTRAINT "ClickEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "ClickEvent" ADD CONSTRAINT "ClickEvent_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "CampaignRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "ClickEvent" ADD CONSTRAINT "ClickEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
