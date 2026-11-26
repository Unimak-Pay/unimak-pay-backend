-- Payments no longer expire (docs/payment-lifecycle.md): PENDING waits for the payer,
-- PROCESSING comes from Monime's payment.processing_started.
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'PROCESSING' AFTER 'PENDING';
ALTER TABLE "Payment" ADD COLUMN "processingAt" TIMESTAMP(3);

-- The pg_cron job from 20261118150100_expire_payments_job marked open payments EXPIRED
-- every 5 minutes; nothing expires now, so remove it where it was scheduled.
DO $outer$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'unimak-expire-payments';
  END IF;
EXCEPTION WHEN insufficient_privilege OR undefined_table OR undefined_function THEN
  RAISE WARNING 'Could not unschedule unimak-expire-payments (%); remove it in the Supabase dashboard', SQLERRM;
END $outer$;
