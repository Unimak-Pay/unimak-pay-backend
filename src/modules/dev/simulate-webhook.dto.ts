import { IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

/** Exactly one of paymentId / transferId / payoutId (our ids). */
export class SimulateWebhookDto {
  @IsOptional()
  @IsUUID()
  paymentId?: string;

  @IsOptional()
  @IsUUID()
  transferId?: string;

  @IsOptional()
  @IsUUID()
  payoutId?: string;

  /**
   * payment:  completed → payment.processing_completed; failed/expired → payment code
   *           cancelled/expired in the mock + reconciliation (no webhook)
   * transfer: completed | failed → internal_transfer.*
   * payout:   completed | failed → payout.*
   */
  @IsIn(['completed', 'failed', 'expired'])
  outcome!: 'completed' | 'failed' | 'expired';

  /** Override the reported amount (minor units) to test mismatches. */
  @IsOptional()
  @Matches(/^[1-9]\d{0,17}$/)
  amount?: string;

  /** The number that paid (reported masked, like Monime does); default the payment's. */
  @IsOptional()
  @Matches(/^\+\d{8,15}$/)
  payerPhone?: string;

  /** Extra payment metadata, e.g. { payer_phone } as a USSD flow would send it. */
  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;

  /** false: Monime records the payment but the webhook never arrives (test reconciliation). */
  @IsOptional()
  @IsBoolean()
  deliver?: boolean;

  /** Reuse an event id to test redelivery dedupe. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  eventId?: string;
}
