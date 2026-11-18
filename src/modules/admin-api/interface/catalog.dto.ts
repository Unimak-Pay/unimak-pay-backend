import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, Length, Matches, Max, Min, ValidateIf } from 'class-validator';

const toDigits = ({ value }: { value: unknown }): unknown => (typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value);
/** minor units, e.g. "150000" = SLE 1,500.00 */
const AMOUNT = /^[1-9]\d{0,17}$/;

export class CreateFeeTypeDto {
  /** APP, MATRIC, TUITION, DEPT, GRAD or a custom code */
  @Matches(/^[A-Z][A-Z0-9_]{1,19}$/, { message: 'code must be 2–20 chars: A–Z, 0–9, _' })
  code!: string;

  @IsString() @Length(2, 100)
  name!: string;

  @IsIn(['APPLICANT', 'STUDENT'])
  payerKind!: 'APPLICANT' | 'STUDENT';

  @IsIn(['ONCE', 'PER_YEAR'])
  recurrence!: 'ONCE' | 'PER_YEAR';
}

export class UpdateFeeTypeDto {
  @IsString() @Length(2, 100)
  name!: string;
}

export class FeesQuery {
  @IsOptional() @IsString() @Length(1, 20)
  feeType?: string;

  @IsOptional() @IsIn(['DRAFT', 'ACTIVE', 'CLOSED'])
  status?: 'DRAFT' | 'ACTIVE' | 'CLOSED';
}

export class CreateFeeDto {
  @Matches(/^[0-9a-f-]{36}$/i)
  feeTypeId!: string;

  @IsString() @Length(2, 100)
  name!: string;

  /** "2026/27" (academic year) or "2026-SEP" (intake) */
  @Matches(/^[A-Za-z0-9/-]{4,20}$/)
  period!: string;

  @IsBoolean()
  allowInstalments!: boolean;

  @IsOptional() @Transform(toDigits) @Matches(AMOUNT)
  defaultMinInstalment?: string;

  @IsOptional() @IsISO8601({ strict: true })
  dueDate?: string;
}

export class UpdateFeeDto {
  @IsOptional() @IsString() @Length(2, 100)
  name?: string;

  @IsOptional() @IsBoolean()
  allowInstalments?: boolean;

  /** null clears it */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Transform(toDigits) @Matches(AMOUNT)
  defaultMinInstalment?: string | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsISO8601({ strict: true })
  dueDate?: string | null;

  @IsOptional() @IsIn(['DRAFT', 'ACTIVE', 'CLOSED'])
  status?: 'DRAFT' | 'ACTIVE' | 'CLOSED';
}

/** Matchers: omit (or null) = any. */
export class MatchersDto {
  @IsOptional() @IsString() @Length(1, 20) programCode?: string | null;
  @IsOptional() @IsString() @Length(1, 50) department?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10) level?: number | null;
  @IsOptional() @IsIn(['LOCAL', 'INTERNATIONAL']) residency?: 'LOCAL' | 'INTERNATIONAL' | null;
  @IsOptional() @Matches(/^[A-Za-z0-9-]{4,20}$/) intake?: string | null;
}

export class RateRuleDto extends MatchersDto {
  @Transform(toDigits) @Matches(AMOUNT)
  amount!: string;
}

export class EligibilityRuleDto extends MatchersDto {
  @IsOptional() @IsBoolean() finalYear?: boolean | null;
}

export class InstalmentRuleDto {
  @Transform(toDigits) @Matches(AMOUNT)
  minInstalment!: string;
}

export class PreviewQuery {
  @IsIn(['applicant', 'student'])
  kind!: 'applicant' | 'student';

  @Matches(/^[A-Za-z0-9_/-]{1,64}$/)
  ref!: string;
}
