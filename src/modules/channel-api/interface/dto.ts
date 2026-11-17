import { Transform } from 'class-transformer';
import { IsIn, IsString, IsUUID, Length, Matches } from 'class-validator';

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
