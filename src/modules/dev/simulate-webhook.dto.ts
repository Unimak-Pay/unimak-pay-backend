import { IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

export class SimulateWebhookDto {
  @IsUUID()
  paymentId!: string;

  /** completed → signed payment.processing_completed webhook; failed/expired → Monime-side failure + reconciliation */
  @IsIn(['completed', 'failed', 'expired'])
  outcome!: 'completed' | 'failed' | 'expired';

  /** Override the collected amount (minor units) to test mismatches. */
  @IsOptional()
  @Matches(/^[1-9]\d{0,17}$/)
  amount?: string;

  /** Reuse an event id to test redelivery dedupe. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  eventId?: string;
}
