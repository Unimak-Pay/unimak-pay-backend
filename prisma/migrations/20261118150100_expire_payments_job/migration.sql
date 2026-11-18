-- Open payments past expiresAt (Monime never called our webhook) are marked
-- EXPIRED every 5 minutes by pg_cron inside the database, so it runs whatever
-- the hosting plan allows for HTTP crons. A webhook that arrives later is still
-- applied (late settlement), so a real payment is never lost.
--
-- Only where pg_cron is available (Supabase); a no-op on plain Postgres, where
-- the /cron/expire-payments endpoint and the nightly job do the same.
DO $outer$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not available; skipping the expire-payments job';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule(
    'unimak-expire-payments',
    '*/5 * * * *',
    $job$UPDATE public."Payment"
         SET status = 'EXPIRED', "failureReason" = 'expired', "updatedAt" = now()
         WHERE status IN ('INITIATED', 'PENDING') AND "expiresAt" <= now()$job$
  );
EXCEPTION WHEN insufficient_privilege OR feature_not_supported OR object_not_in_prerequisite_state THEN
  RAISE WARNING 'Could not schedule the expire-payments job (%); rely on /cron/expire-payments', SQLERRM;
END $outer$;
