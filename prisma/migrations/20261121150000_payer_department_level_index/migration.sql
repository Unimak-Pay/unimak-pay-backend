-- Analytics: department × level grid and payer list filters (docs/analytics.md)
CREATE INDEX "Payer_department_level_idx" ON "Payer"("department", "level");
