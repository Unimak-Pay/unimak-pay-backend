-- CreateEnum
CREATE TYPE "FinancialAccountPurpose" AS ENUM ('FEE_TYPE', 'PLATFORM');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'SUBMITTED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('REQUESTED', 'SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "FeeType" DROP COLUMN "settlementAccount";

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "ussdCode" TEXT;

-- CreateTable
CREATE TABLE "FinancialAccount" (
    "id" UUID NOT NULL,
    "monimeId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" "FinancialAccountPurpose" NOT NULL,
    "feeTypeId" UUID,
    "uvan" TEXT,
    "availableBalance" BIGINT,
    "balanceUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "paymentId" UUID,
    "sourceAccount" TEXT NOT NULL,
    "destinationAccount" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "monimeTransferId" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" UUID NOT NULL,
    "financialAccountId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "destinationType" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT,
    "narration" TEXT,
    "status" "PayoutStatus" NOT NULL DEFAULT 'REQUESTED',
    "monimePayoutId" TEXT,
    "fees" BIGINT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "requestedBy" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinancialAccount_monimeId_key" ON "FinancialAccount"("monimeId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialAccount_reference_key" ON "FinancialAccount"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialAccount_feeTypeId_key" ON "FinancialAccount"("feeTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_paymentId_key" ON "Transfer"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_monimeTransferId_key" ON "Transfer"("monimeTransferId");

-- CreateIndex
CREATE INDEX "Transfer_status_idx" ON "Transfer"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_monimePayoutId_key" ON "Payout"("monimePayoutId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_idempotencyKey_key" ON "Payout"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payout_financialAccountId_status_idx" ON "Payout"("financialAccountId", "status");

-- AddForeignKey
ALTER TABLE "FinancialAccount" ADD CONSTRAINT "FinancialAccount_feeTypeId_fkey" FOREIGN KEY ("feeTypeId") REFERENCES "FeeType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_financialAccountId_fkey" FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Money sanity.
ALTER TABLE "Transfer" ADD CONSTRAINT transfer_amount_positive CHECK (amount > 0);
ALTER TABLE "Payout" ADD CONSTRAINT payout_amount_positive CHECK (amount > 0);
ALTER TABLE "Payout" ADD CONSTRAINT payout_fees_non_negative CHECK (fees IS NULL OR fees >= 0);
