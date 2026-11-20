-- Minimum instalments can be set per student level within a department (null = every level).
ALTER TABLE "InstalmentRule" ADD COLUMN "level" INTEGER;

DROP INDEX "InstalmentRule_feeId_department_key";
CREATE INDEX "InstalmentRule_feeId_department_idx" ON "InstalmentRule"("feeId", "department");
