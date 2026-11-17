-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'UNMATCHED', 'FAILED');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "monimePaymentId" TEXT;

-- AlterTable
ALTER TABLE "WebhookEvent" DROP CONSTRAINT "WebhookEvent_pkey",
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
ALTER COLUMN "id" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "type" SET DATA TYPE VARCHAR(100),
ADD CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_monimePaymentId_key" ON "Payment"("monimePaymentId");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_idx" ON "WebhookEvent"("status");

