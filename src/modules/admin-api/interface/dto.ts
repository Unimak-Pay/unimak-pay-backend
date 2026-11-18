import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { PERMISSIONS } from '../../auth/domain/permissions';

const ROLES = ['SUPER_ADMIN', 'BURSAR', 'FINANCE_OFFICER', 'HEAD_OF_DEPARTMENT', 'AUDITOR'] as const;
const toDigits = ({ value }: { value: unknown }): unknown => (typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value);

export class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit = 50;

  @IsOptional() @IsUUID()
  cursor?: string;
}

export class PaymentsQuery extends PageQuery {
  @IsOptional() @IsIn(['INITIATED', 'PENDING', 'COMPLETED', 'FAILED', 'EXPIRED'])
  status?: 'INITIATED' | 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';

  @IsOptional() @IsIn(['USSD', 'DOTS'])
  channel?: 'USSD' | 'DOTS';

  @IsOptional() @IsString() @Length(1, 20)
  feeType?: string;

  /** payer ref (student id / application ref) */
  @IsOptional() @IsString() @Length(1, 64)
  payerRef?: string;

  @IsOptional() @IsISO8601()
  from?: string;

  @IsOptional() @IsISO8601()
  to?: string;
}

export class StatusQuery extends PageQuery {
  @IsOptional() @IsString() @Length(1, 20)
  status?: string;
}

export class AuditQuery extends PageQuery {
  @IsOptional() @IsString() @Length(1, 50) entity?: string;
  @IsOptional() @IsString() @Length(1, 100) entityId?: string;
  @IsOptional() @IsString() @Length(1, 100) actorId?: string;
}

export class CreateAdminUserDto {
  @IsEmail() @Length(3, 254)
  email!: string;

  @IsOptional() @IsString() @Length(1, 100)
  name?: string;

  @IsIn(ROLES)
  role!: (typeof ROLES)[number];

  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsIn(PERMISSIONS, { each: true })
  extraPermissions?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @Length(1, 50, { each: true })
  departments?: string[];
}

export class UpdateAdminUserDto {
  @IsOptional() @IsString() @Length(1, 100)
  name?: string;

  @IsOptional() @IsIn(ROLES)
  role?: (typeof ROLES)[number];

  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsIn(PERMISSIONS, { each: true })
  extraPermissions?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @Length(1, 50, { each: true })
  departments?: string[];

  @IsOptional() @IsBoolean()
  active?: boolean;
}

export class CreatePayoutDto {
  /** account reference (unimak-fee-tuition) or Monime id (fac-…) */
  @IsString() @Length(1, 64)
  account!: string;

  /** minor units, e.g. "150000" = SLE 1,500.00 */
  @Transform(toDigits) @Matches(/^[1-9]\d{0,17}$/)
  amount!: string;

  @IsString() @Matches(/^[a-z0-9]{2,20}$/)
  bankProviderId!: string;

  @Matches(/^\d{4,34}$/)
  accountNumber!: string;

  @IsOptional() @IsString() @Length(1, 100)
  accountName?: string;

  @IsOptional() @IsString() @Length(1, 100)
  narration?: string;

  @IsString() @Length(8, 64)
  idempotencyKey!: string;
}

export class ResolveEventDto {
  @IsString() @Length(3, 500)
  resolution!: string;
}
