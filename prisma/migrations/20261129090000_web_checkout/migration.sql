-- Sponsors pay a pay request in a browser through Monime's hosted checkout.
ALTER TYPE "Channel" ADD VALUE 'WEB';
ALTER TYPE "CollectionMethod" ADD VALUE 'CHECKOUT_SESSION';

ALTER TABLE "Payment" ADD COLUMN "checkoutSessionId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "checkoutUrl" TEXT;
CREATE UNIQUE INDEX "Payment_checkoutSessionId_key" ON "Payment"("checkoutSessionId");
