-- CreateEnum
CREATE TYPE "CollectionMethod" AS ENUM ('PAYMENT_CODE', 'USSD_FLOW');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "collectionMethod" "CollectionMethod" NOT NULL DEFAULT 'PAYMENT_CODE';

