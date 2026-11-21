-- Portal events (docs/portal-events.md): payer sync fields and the event log.

-- CreateEnum
CREATE TYPE "EnrolmentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'WITHDRAWN', 'GRADUATED');

-- CreateEnum
CREATE TYPE "PortalEventResult" AS ENUM ('APPLIED', 'STALE', 'REJECTED');

-- AlterTable
ALTER TABLE "Payer" ADD COLUMN     "applicationRef" TEXT,
ADD COLUMN     "enrolmentStatus" "EnrolmentStatus",
ADD COLUMN     "portalUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PortalEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ref" TEXT,
    "result" "PortalEventResult" NOT NULL,
    "error" TEXT,
    "data" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortalEvent_receivedAt_idx" ON "PortalEvent"("receivedAt");

-- CreateIndex
CREATE INDEX "PortalEvent_ref_idx" ON "PortalEvent"("ref");

-- Only the backend (service role) reads it; it holds names and phone numbers.
ALTER TABLE "PortalEvent" ENABLE ROW LEVEL SECURITY;
