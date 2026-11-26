-- Dot extras (docs/dot-extras.md): pay requests, who paid and how, exam clearance.
-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "monimeChannelType" TEXT,
ADD COLUMN     "paidByName" TEXT,
ADD COLUMN     "payRequestId" UUID,
ADD COLUMN     "payingForSelf" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PayRequest" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "payerId" UUID NOT NULL,
    "obligationId" UUID NOT NULL,
    "amount" BIGINT,
    "message" TEXT NOT NULL,
    "recipientName" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClearancePolicy" (
    "id" TEXT NOT NULL DEFAULT 'current',
    "examName" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "feeTypeCodes" TEXT[],
    "includeOverdue" BOOLEAN NOT NULL DEFAULT true,
    "placeholder" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClearancePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClearancePass" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "payerId" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClearancePass_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayRequest_code_key" ON "PayRequest"("code");

-- CreateIndex
CREATE INDEX "PayRequest_payerId_createdAt_idx" ON "PayRequest"("payerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PayRequest_payerId_idempotencyKey_key" ON "PayRequest"("payerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ClearancePass_code_key" ON "ClearancePass"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ClearancePass_payerId_period_key" ON "ClearancePass"("payerId", "period");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_payRequestId_fkey" FOREIGN KEY ("payRequestId") REFERENCES "PayRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRequest" ADD CONSTRAINT "PayRequest_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRequest" ADD CONSTRAINT "PayRequest_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "Obligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClearancePass" ADD CONSTRAINT "ClearancePass_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Payment_payRequestId_idx" ON "Payment"("payRequestId");

-- Same as every other table: only the backend's own role reads these (Supabase Data API off).
ALTER TABLE "PayRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClearancePolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClearancePass" ENABLE ROW LEVEL SECURITY;

-- PLACEHOLDER clearance rule, not the university's: the finance office replaces it
-- (PUT /v1/admin/clearance-policy). placeholder = true until they do.
INSERT INTO "ClearancePolicy" ("id", "examName", "period", "feeTypeCodes", "includeOverdue", "placeholder", "updatedBy", "updatedAt")
VALUES ('current', 'First semester exams', '2026/27', ARRAY['TUITION'], true, true, 'system:migration', CURRENT_TIMESTAMP);
