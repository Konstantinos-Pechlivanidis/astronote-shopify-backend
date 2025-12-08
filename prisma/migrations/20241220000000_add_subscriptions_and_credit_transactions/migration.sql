-- CreateEnum
CREATE TYPE "SubscriptionPlanType" AS ENUM ('starter', 'pro');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'inactive', 'cancelled');

-- CreateEnum
CREATE TYPE "CreditTxnType" AS ENUM ('credit', 'debit', 'refund');

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN "stripeCustomerId" VARCHAR(255),
ADD COLUMN "stripeSubscriptionId" VARCHAR(255),
ADD COLUMN "planType" "SubscriptionPlanType",
ADD COLUMN "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'inactive',
ADD COLUMN "lastFreeCreditsAllocatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Shop_stripeCustomerId_idx" ON "Shop"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "Shop_stripeSubscriptionId_idx" ON "Shop"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "Shop_subscriptionStatus_idx" ON "Shop"("subscriptionStatus");

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" "CreditTxnType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" VARCHAR(200),
    "campaignId" TEXT,
    "messageId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "walletId" TEXT,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditTransaction_shopId_idx" ON "CreditTransaction"("shopId");

-- CreateIndex
CREATE INDEX "CreditTransaction_campaignId_idx" ON "CreditTransaction"("campaignId");

-- CreateIndex
CREATE INDEX "CreditTransaction_messageId_idx" ON "CreditTransaction"("messageId");

-- CreateIndex
CREATE INDEX "CreditTransaction_walletId_idx" ON "CreditTransaction"("walletId");

-- CreateIndex
CREATE INDEX "CreditTransaction_createdAt_idx" ON "CreditTransaction"("createdAt");

-- CreateIndex
CREATE INDEX "CreditTransaction_reason_idx" ON "CreditTransaction"("reason");

-- CreateIndex
CREATE INDEX "CreditTransaction_shopId_reason_idx" ON "CreditTransaction"("shopId", "reason");

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "MessageLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

