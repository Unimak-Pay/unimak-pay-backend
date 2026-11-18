-- Short payment ref for status checks, Monime order number, and the payer
-- number becomes "unknown until we know it" (no more portal-phone default).
ALTER TABLE "Payment" ADD COLUMN "monimeOrderNumber" TEXT,
ADD COLUMN "paymentRef" TEXT,
ALTER COLUMN "payerPhone" DROP NOT NULL;

-- Backfill: a unique 8-digit ref per existing payment.
DO $$
DECLARE r record; ref text;
BEGIN
  FOR r IN SELECT id FROM "Payment" WHERE "paymentRef" IS NULL LOOP
    LOOP
      ref := (10000000 + floor(random() * 90000000))::bigint::text;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "Payment" WHERE "paymentRef" = ref);
    END LOOP;
    UPDATE "Payment" SET "paymentRef" = ref WHERE id = r.id;
  END LOOP;
END $$;
ALTER TABLE "Payment" ALTER COLUMN "paymentRef" SET NOT NULL;

-- Backfill from completed-payment webhooks already received: order number, and
-- for USSD-flow payments the number Monime reported (masked) instead of the
-- portal phone we had assumed.
UPDATE "Payment" p
SET "monimeOrderNumber" = w.payload->'data'->>'orderNumber'
FROM "WebhookEvent" w
WHERE w.type = 'payment.processing_completed'
  AND w.payload->'data'->>'id' = p."monimePaymentId"
  AND w.payload->'data'->>'orderNumber' IS NOT NULL;

UPDATE "Payment" p
SET "payerPhone" = w.payload->'data'->'channel'->>'phoneNumber'
FROM "WebhookEvent" w
WHERE p."collectionMethod" = 'USSD_FLOW'
  AND w.type = 'payment.processing_completed'
  AND w.payload->'data'->>'id' = p."monimePaymentId"
  AND w.payload->'data'->'channel'->>'phoneNumber' IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_paymentRef_key" ON "Payment"("paymentRef");
-- CreateIndex
CREATE INDEX "Payment_monimeOrderNumber_idx" ON "Payment"("monimeOrderNumber");
