-- Pricing for the WEB channel (a separate migration: a new enum value can't be used
-- in the transaction that adds it). Monime's published local rate is 1.5%; UNIMAK's
-- total stays 2.5% as on the other channels. Change it like any other pricing row.
INSERT INTO "PricingConfig" ("id", "channel", "totalRateBps", "monimeRateBps", "monimeFlat", "effectiveFrom")
VALUES (gen_random_uuid(), 'WEB', 250, 150, 0, '2026-01-01T00:00:00Z')
ON CONFLICT ("channel", "effectiveFrom") DO NOTHING;
