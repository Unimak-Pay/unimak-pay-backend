-- CreateEnum
CREATE TYPE "PayerKind" AS ENUM ('APPLICANT', 'STUDENT');

-- CreateEnum
CREATE TYPE "Recurrence" AS ENUM ('ONCE', 'PER_YEAR');

-- CreateEnum
CREATE TYPE "Residency" AS ENUM ('LOCAL', 'INTERNATIONAL');

-- CreateEnum
CREATE TYPE "FeeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "ObligationStatus" AS ENUM ('OPEN', 'PAID');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('CHARGE', 'PAYMENT', 'ADJUSTMENT', 'REFUND');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('USSD', 'DOTS');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED', 'PENDING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SENT', 'DEAD');

-- CreateTable
CREATE TABLE "FeeType" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payerKind" "PayerKind" NOT NULL,
    "recurrence" "Recurrence" NOT NULL,
    "settlementAccount" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fee" (
    "id" UUID NOT NULL,
    "feeTypeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "allowInstalments" BOOLEAN NOT NULL DEFAULT false,
    "defaultMinInstalment" BIGINT,
    "dueDate" TIMESTAMP(3),
    "status" "FeeStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateRule" (
    "id" UUID NOT NULL,
    "feeId" UUID NOT NULL,
    "programCode" TEXT,
    "department" TEXT,
    "level" INTEGER,
    "residency" "Residency",
    "intake" TEXT,
    "amount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstalmentRule" (
    "id" UUID NOT NULL,
    "feeId" UUID NOT NULL,
    "programCode" TEXT NOT NULL,
    "minInstalment" BIGINT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstalmentRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EligibilityRule" (
    "id" UUID NOT NULL,
    "feeId" UUID NOT NULL,
    "programCode" TEXT,
    "department" TEXT,
    "level" INTEGER,
    "residency" "Residency",
    "intake" TEXT,
    "finalYear" BOOLEAN,

    CONSTRAINT "EligibilityRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingConfig" (
    "id" UUID NOT NULL,
    "channel" "Channel" NOT NULL,
    "totalRateBps" INTEGER NOT NULL,
    "monimeRateBps" INTEGER NOT NULL DEFAULT 0,
    "monimeFlat" BIGINT NOT NULL DEFAULT 0,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payer" (
    "id" UUID NOT NULL,
    "kind" "PayerKind" NOT NULL,
    "ref" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "programCode" TEXT NOT NULL,
    "department" TEXT,
    "level" INTEGER,
    "finalYear" BOOLEAN,
    "residency" "Residency" NOT NULL,
    "intake" TEXT NOT NULL,
    "applicantStatus" TEXT,
    "snapshotAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Obligation" (
    "id" UUID NOT NULL,
    "payerId" UUID NOT NULL,
    "feeId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "rateRuleId" UUID,
    "status" "ObligationStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Obligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" UUID NOT NULL,
    "obligationId" UUID NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "paymentId" UUID,
    "memo" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "obligationId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "channel" "Channel" NOT NULL,
    "clientId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payerPhone" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "monimeRef" TEXT,
    "pricingConfigId" UUID NOT NULL,
    "monimeFee" BIGINT NOT NULL,
    "platformFee" BIGINT NOT NULL,
    "netAmount" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "verifyCode" TEXT NOT NULL,
    "paymentId" UUID NOT NULL,
    "payerId" UUID NOT NULL,
    "obligationId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptCounter" (
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ReceiptCounter_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "OutboxMessage" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MockMonimeRecord" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MockMonimeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeeType_code_key" ON "FeeType"("code");

-- CreateIndex
CREATE INDEX "Fee_status_idx" ON "Fee"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Fee_feeTypeId_period_key" ON "Fee"("feeTypeId", "period");

-- CreateIndex
CREATE INDEX "RateRule_feeId_idx" ON "RateRule"("feeId");

-- CreateIndex
CREATE UNIQUE INDEX "InstalmentRule_feeId_programCode_key" ON "InstalmentRule"("feeId", "programCode");

-- CreateIndex
CREATE INDEX "EligibilityRule_feeId_idx" ON "EligibilityRule"("feeId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingConfig_channel_effectiveFrom_key" ON "PricingConfig"("channel", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Payer_kind_ref_key" ON "Payer"("kind", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "Obligation_payerId_feeId_key" ON "Obligation"("payerId", "feeId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_paymentId_key" ON "LedgerEntry"("paymentId");

-- CreateIndex
CREATE INDEX "LedgerEntry_obligationId_idx" ON "LedgerEntry"("obligationId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_monimeRef_key" ON "Payment"("monimeRef");

-- CreateIndex
CREATE INDEX "Payment_obligationId_status_idx" ON "Payment"("obligationId", "status");

-- CreateIndex
CREATE INDEX "Payment_status_expiresAt_idx" ON "Payment"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_clientId_idempotencyKey_key" ON "Payment"("clientId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_number_key" ON "Receipt"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_verifyCode_key" ON "Receipt"("verifyCode");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_paymentId_key" ON "Receipt"("paymentId");

-- CreateIndex
CREATE INDEX "Receipt_payerId_idx" ON "Receipt"("payerId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxMessage_dedupeKey_key" ON "OutboxMessage"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxMessage_status_nextAttemptAt_idx" ON "OutboxMessage"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "Fee" ADD CONSTRAINT "Fee_feeTypeId_fkey" FOREIGN KEY ("feeTypeId") REFERENCES "FeeType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateRule" ADD CONSTRAINT "RateRule_feeId_fkey" FOREIGN KEY ("feeId") REFERENCES "Fee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstalmentRule" ADD CONSTRAINT "InstalmentRule_feeId_fkey" FOREIGN KEY ("feeId") REFERENCES "Fee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EligibilityRule" ADD CONSTRAINT "EligibilityRule_feeId_fkey" FOREIGN KEY ("feeId") REFERENCES "Fee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_feeId_fkey" FOREIGN KEY ("feeId") REFERENCES "Fee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "Obligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "Obligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_pricingConfigId_fkey" FOREIGN KEY ("pricingConfigId") REFERENCES "PricingConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "Obligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────── Hand-written guarantees (not expressible in Prisma schema) ─────────────

-- Ledger is append-only.
CREATE OR REPLACE FUNCTION ledger_entry_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LedgerEntry is append-only (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entry_append_only
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_block_mutation();

-- Ledger sign conventions.
ALTER TABLE "LedgerEntry" ADD CONSTRAINT ledger_entry_sign CHECK (
  ("type" = 'CHARGE'  AND amount > 0) OR
  ("type" = 'PAYMENT' AND amount < 0) OR
  ("type" = 'REFUND'  AND amount > 0) OR
  ("type" = 'ADJUSTMENT' AND amount <> 0)
);
ALTER TABLE "LedgerEntry" ADD CONSTRAINT ledger_entry_payment_has_payment_id
  CHECK ("type" <> 'PAYMENT' OR "paymentId" IS NOT NULL);

-- Money sanity.
ALTER TABLE "Payment" ADD CONSTRAINT payment_amount_positive CHECK (amount > 0);
ALTER TABLE "Payment" ADD CONSTRAINT payment_split_consistent CHECK (
  "monimeFee" >= 0 AND "platformFee" >= 0 AND "netAmount" = amount - "monimeFee" - "platformFee"
);
ALTER TABLE "Obligation" ADD CONSTRAINT obligation_amount_positive CHECK (amount > 0);
ALTER TABLE "RateRule" ADD CONSTRAINT rate_rule_amount_positive CHECK (amount > 0);
ALTER TABLE "InstalmentRule" ADD CONSTRAINT instalment_rule_positive CHECK ("minInstalment" > 0);
ALTER TABLE "Receipt" ADD CONSTRAINT receipt_amount_positive CHECK (amount > 0);
ALTER TABLE "PricingConfig" ADD CONSTRAINT pricing_config_non_negative CHECK (
  "totalRateBps" >= 0 AND "monimeRateBps" >= 0 AND "monimeFlat" >= 0
);
