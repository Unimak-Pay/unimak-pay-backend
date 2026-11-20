import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { PERMISSIONS } from '../../auth/domain/permissions';

const ROLES = ['SUPER_ADMIN', 'BURSAR', 'FINANCE_OFFICER', 'HEAD_OF_DEPARTMENT', 'DEAN', 'AUDITOR'] as const;
const toDigits = ({ value }: { value: unknown }): unknown => (typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value);

/** Sort: a field, `-field` for descending. Ties break on id, so cursors stay stable. */
export const SORTS = ['createdAt', '-createdAt', 'amount', '-amount'] as const;
export type Sort = (typeof SORTS)[number];

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

  /** our 8-digit payment ref, Monime's order number, or a Monime payment id (spm-…) */
  @IsOptional() @IsString() @Length(1, 64)
  ref?: string;

  @IsOptional() @IsISO8601()
  from?: string;

  @IsOptional() @IsISO8601()
  to?: string;

  /** Department.code */
  @IsOptional() @IsString() @Length(1, 40)
  department?: string;

  /** Faculty.code: its departments as they are now */
  @IsOptional() @IsString() @Length(1, 40)
  faculty?: string;

  @IsOptional() @IsIn(SORTS)
  sort?: Sort;
}

/** Same filters as the list, no paging. */
export class PaymentsExportQuery {
  @IsOptional() @IsIn(['INITIATED', 'PENDING', 'COMPLETED', 'FAILED', 'EXPIRED'])
  status?: 'INITIATED' | 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';

  @IsOptional() @IsIn(['USSD', 'DOTS'])
  channel?: 'USSD' | 'DOTS';

  @IsOptional() @IsString() @Length(1, 20)
  feeType?: string;

  @IsOptional() @IsString() @Length(1, 64)
  payerRef?: string;

  @IsOptional() @IsString() @Length(1, 64)
  ref?: string;

  @IsOptional() @IsISO8601()
  from?: string;

  @IsOptional() @IsISO8601()
  to?: string;

  /** Department.code */
  @IsOptional() @IsString() @Length(1, 40)
  department?: string;

  /** Faculty.code: its departments as they are now */
  @IsOptional() @IsString() @Length(1, 40)
  faculty?: string;
}

export class ReportsSummaryQueryDto {
  /** YYYY-MM-DD inclusive (Africa/Freetown = UTC); default 29 days before `to` */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  /** YYYY-MM-DD inclusive; default today */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @IsOptional() @IsString() @Length(1, 20)
  feeType?: string;

  @IsOptional() @IsIn(['USSD', 'DOTS'])
  channel?: 'USSD' | 'DOTS';

  /** Department.code */
  @IsOptional() @IsString() @Length(1, 40)
  department?: string;

  /** Faculty.code: its departments as they are now */
  @IsOptional() @IsString() @Length(1, 40)
  faculty?: string;
}

export class PayoutsQuery extends PageQuery {
  @IsOptional() @IsIn(['REQUESTED', 'SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED'])
  status?: 'REQUESTED' | 'SUBMITTED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

  @IsOptional() @IsIn(SORTS)
  sort?: Sort;
}

export class TransfersQuery extends PageQuery {
  @IsOptional() @IsIn(['PENDING', 'SUBMITTED', 'COMPLETED', 'FAILED'])
  status?: 'PENDING' | 'SUBMITTED' | 'COMPLETED' | 'FAILED';

  @IsOptional() @IsIn(SORTS)
  sort?: Sort;
}

export class OutboxQuery extends PageQuery {
  @IsOptional() @IsIn(['PENDING', 'SENT', 'DEAD'])
  status?: 'PENDING' | 'SENT' | 'DEAD';
}

export class RunsQuery extends PageQuery {
  @IsOptional() @IsIn(['RUNNING', 'COMPLETED', 'FAILED'])
  status?: 'RUNNING' | 'COMPLETED' | 'FAILED';
}

export class ItemsQuery extends PageQuery {
  @IsOptional() @IsIn(['OPEN', 'AUTO_RESOLVED', 'RESOLVED'])
  status?: 'OPEN' | 'AUTO_RESOLVED' | 'RESOLVED';

  @IsOptional() @IsUUID()
  runId?: string;

  @IsOptional() @IsString() @Length(1, 50)
  kind?: string;
}

/** Webhook event ids are Monime's (not UUIDs), so the cursor is any id. */
export class WebhookEventsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit = 50;

  @IsOptional() @IsString() @Length(1, 100)
  cursor?: string;

  @IsOptional() @IsIn(['RECEIVED', 'PROCESSED', 'IGNORED', 'UNMATCHED', 'FAILED'])
  status?: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'UNMATCHED' | 'FAILED';

  @IsOptional() @IsString() @Length(1, 100)
  type?: string;

  /** true: only events nobody has resolved yet */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean()
  unresolved?: boolean;
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

  /** DEAN: Faculty codes */
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @Length(1, 50, { each: true })
  faculties?: string[];
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

  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @Length(1, 50, { each: true })
  faculties?: string[];

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

export class RunReconciliationDto {
  /** UTC day to reconcile, YYYY-MM-DD (default: yesterday) */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;
}

export class ResolveEventDto {
  @IsString() @Length(3, 500)
  resolution!: string;
}

// ── Faculties & departments ─────────────────────────────────────────────────

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const optionalBool = ({ value }: { value: unknown }): unknown => (value === 'true' ? true : value === 'false' ? false : value);

export class CreateFacultyDto {
  /** Never changes; must match what the portal sends */
  @IsString() @Matches(CODE)
  code!: string;

  @IsString() @Length(1, 120)
  name!: string;
}

export class UpdateFacultyDto {
  @IsOptional() @IsString() @Length(1, 120)
  name?: string;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

export class CreateDepartmentDto {
  /** Never changes; must match the department code the portal sends */
  @IsString() @Matches(CODE)
  code!: string;

  @IsString() @Length(1, 120)
  name!: string;

  @IsString() @Length(1, 40)
  facultyCode!: string;
}

export class UpdateDepartmentDto {
  @IsOptional() @IsString() @Length(1, 120)
  name?: string;

  /** Moves it (and marks a department that needs review as reviewed) */
  @IsOptional() @IsString() @Length(1, 40)
  facultyCode?: string;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

export class DepartmentsQuery {
  @IsOptional() @IsString() @Length(1, 40)
  faculty?: string;

  @IsOptional() @Transform(optionalBool) @IsBoolean()
  needsReview?: boolean;

  @IsOptional() @Transform(optionalBool) @IsBoolean()
  active?: boolean;
}
