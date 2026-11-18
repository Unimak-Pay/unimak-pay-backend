-- CreateEnum
CREATE TYPE "ReconciliationRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReconciliationItemStatus" AS ENUM ('OPEN', 'AUTO_RESOLVED', 'RESOLVED');

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" UUID NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "status" "ReconciliationRunStatus" NOT NULL DEFAULT 'RUNNING',
    "triggeredBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "stats" JSONB,
    "error" TEXT,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationItem" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "ReconciliationItemStatus" NOT NULL DEFAULT 'OPEN',
    "paymentId" UUID,
    "monimePaymentId" TEXT,
    "transferId" UUID,
    "financialAccountId" TEXT,
    "expected" JSONB,
    "actual" JSONB,
    "note" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReconciliationRun_windowStart_status_idx" ON "ReconciliationRun"("windowStart", "status");

-- CreateIndex
CREATE INDEX "ReconciliationItem_status_kind_idx" ON "ReconciliationItem"("status", "kind");

-- CreateIndex
CREATE INDEX "ReconciliationItem_paymentId_idx" ON "ReconciliationItem"("paymentId");

-- CreateIndex
CREATE INDEX "ReconciliationItem_monimePaymentId_idx" ON "ReconciliationItem"("monimePaymentId");

-- AddForeignKey
ALTER TABLE "ReconciliationItem" ADD CONSTRAINT "ReconciliationItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

