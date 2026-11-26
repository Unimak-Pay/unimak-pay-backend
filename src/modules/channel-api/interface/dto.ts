import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

const toDigitString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;

/** Amounts are minor units (1 SLE = 100) as a digit string, e.g. "150000" = SLE 1,500.00. */
const AMOUNT = /^[1-9]\d{0,17}$/;

export class CreatePaymentDto {
  @IsUUID()
  obligationId!: string;

  @Transform(toDigitString)
  @Matches(AMOUNT, { message: 'amount must be a positive integer of minor units' })
  amount!: string;

  @Matches(/^\+?\d{8,15}$/, { message: 'payerPhone must be digits, optionally starting with +' })
  payerPhone!: string;

  @IsIn(['USSD', 'DOTS'])
  channel!: 'USSD' | 'DOTS';

  @IsString()
  @Length(8, 100)
  idempotencyKey!: string;
}

export class QuoteDto {
  @IsUUID()
  obligationId!: string;

  @Transform(toDigitString)
  @Matches(AMOUNT, { message: 'amount must be a positive integer of minor units' })
  amount!: string;

  @IsIn(['USSD', 'DOTS'])
  channel!: 'USSD' | 'DOTS';
}

/** Public dot API: the channel is always DOTS. */
export class DotAmountDto {
  @IsUUID()
  obligationId!: string;

  @Transform(toDigitString)
  @Matches(AMOUNT, { message: 'amount must be a positive integer of minor units' })
  amount!: string;
}

/** `Idempotency-Key` header of POST /v1/dot/payments. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,100}$/;

/** POST /v1/dot/payments: the amount body plus optional pay-request and display fields (dot 0.2.3+). */
export class DotPaymentDto extends DotAmountDto {
  /** the pay request this payment goes towards (from the sponsor link) */
  @IsOptional() @IsString() @Length(1, 20)
  payRequestCode?: string;

  /** first name of whoever is paying; display only */
  @IsOptional() @IsString() @Length(1, 40)
  paidByName?: string;

  /** true when the student saved on that phone is paying for themselves; display only */
  @IsOptional() @IsBoolean()
  payingForSelf?: boolean;
}

export class CreatePayRequestDto {
  @IsIn(['student', 'applicant'])
  kind!: 'student' | 'applicant';

  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: 'ref is not valid' })
  ref!: string;

  @IsUUID()
  obligationId!: string;

  /** minor units, or null for "whatever you can" */
  @IsOptional()
  @Transform(toDigitString)
  @Matches(AMOUNT, { message: 'amount must be a positive integer of minor units, or null' })
  amount?: string | null;

  @IsString() @Length(1, 400)
  message!: string;

  @IsOptional() @IsString() @Length(0, 100)
  recipientName?: string | null;
}
