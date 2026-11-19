import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const ADAPTER_MODES = ['mock', 'http'] as const;

export class EnvSchema {
  @IsIn(NODE_ENVS)
  NODE_ENV: (typeof NODE_ENVS)[number] = 'development';

  @Type(() => Number)
  @IsInt()
  PORT = 3000;

  @IsString()
  DATABASE_URL!: string;

  @IsString()
  @IsOptional()
  DIRECT_URL?: string;

  /** Base URL used to build public receipt links (`/r/:verifyCode`). */
  @IsUrl({ require_tld: false })
  PUBLIC_BASE_URL = 'http://localhost:3000';

  // ---- Portal ----
  @IsIn(ADAPTER_MODES)
  PORTAL_MODE: (typeof ADAPTER_MODES)[number] = 'mock';

  @IsUrl({ require_tld: false })
  @IsOptional()
  PORTAL_BASE_URL?: string;

  @IsString()
  @IsOptional()
  PORTAL_API_KEY?: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  PORTAL_MOCK_LATENCY_MS = 0;

  @IsString()
  PORTAL_FIXTURES_DIR = 'fixtures/portal';

  // ---- Monime ----
  @IsIn(ADAPTER_MODES)
  MONIME_MODE: (typeof ADAPTER_MODES)[number] = 'mock';

  /** Includes the API version path. */
  @IsUrl({ require_tld: false })
  MONIME_BASE_URL = 'https://api.monime.io/v1';

  @IsString()
  @IsOptional()
  MONIME_ACCESS_TOKEN?: string;

  @IsString()
  MONIME_API_VERSION = 'caph.2025-08-23';

  @IsString()
  @IsOptional()
  MONIME_SPACE_ID?: string;

  /** HS256 secret shared with Monime (Monime requires 32–256 chars). */
  @IsString()
  @MinLength(32)
  MONIME_WEBHOOK_SECRET!: string;

  /**
   * Reject webhook signatures whose t= is further than this from now. Unset by
   * default: Monime redeliveries may carry the original timestamp, and replays
   * are harmless anyway (deduped by event id).
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  MONIME_WEBHOOK_TOLERANCE_SECONDS?: number;

  /**
   * Fallback commission destination (fac-…) if no PLATFORM account has been
   * provisioned (pnpm monime:provision creates one).
   */
  @IsString()
  @IsOptional()
  PLATFORM_MONIME_ACCOUNT?: string;

  // ---- Admin auth (Supabase Auth) ----
  /** e.g. https://<ref>.supabase.co — JWKS + issuer come from here */
  @IsUrl({ require_tld: false })
  @IsOptional()
  SUPABASE_URL?: string;

  /** Legacy HS256 JWT secret; only needed if the project still signs with it. */
  @IsString()
  @MinLength(32)
  @IsOptional()
  SUPABASE_JWT_SECRET?: string;

  /**
   * Server-only key (service_role, or sb_secret_…) for the Supabase Auth admin API:
   * POST /v1/admin/users then makes Supabase email the invitee. Never expose it to a browser.
   */
  @IsString()
  @MinLength(20)
  @IsOptional()
  SUPABASE_SERVICE_ROLE_KEY?: string;

  /** Dashboard page invite links open (where the invitee sets a password); must be in Supabase → Auth → Redirect URLs. Default: the Site URL. */
  @IsUrl({ require_tld: false, require_protocol: true })
  @IsOptional()
  ADMIN_INVITE_REDIRECT_URL?: string;

  /** Static JWKS JSON ({"keys":[...]}) instead of fetching — tests / offline. */
  @IsString()
  @IsOptional()
  AUTH_JWKS_JSON?: string;

  /** Overrides the expected issuer (default `${SUPABASE_URL}/auth/v1`). */
  @IsString()
  @IsOptional()
  AUTH_JWT_ISSUER?: string;

  /** Require aal2 (2FA) for SUPER_ADMIN and BURSAR. */
  @Transform(({ value }) => value === undefined ? true : value === true || value === 'true')
  @IsBoolean()
  ADMIN_REQUIRE_MFA = true;

  // ---- Monime USSD flow exchange (RSA-OAEP + AES-128-GCM) ----
  /** PKCS#8 PEM (-----BEGIN PRIVATE KEY-----), RSA 2048; literal \n allowed. */
  @IsString()
  @IsOptional()
  USSD_RSA_PRIVATE_KEY?: string;

  /** Previous key, kept ≥ 30 min after rotating (live sessions). */
  @IsString()
  @IsOptional()
  USSD_RSA_PRIVATE_KEY_PREVIOUS?: string;

  /** Secret path segment: POST /v1/ussd/exchange/<token>. Monime requests aren't signed, keep it private. */
  @IsString()
  @MinLength(32)
  @IsOptional()
  USSD_EXCHANGE_PATH_TOKEN?: string;

  /** Dev only: accept unencrypted JSON (refused when NODE_ENV=production). */
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  USSD_ALLOW_PLAINTEXT = false;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  USSD_MAX_LOOKUPS_PER_15_MIN = 10;

  @IsString()
  USSD_HELP_MESSAGE = 'UNIMAK Finance Office: call +232 00 000 000 (Mon-Fri 9am-4pm).';

  // ---- Channel API / cron ----
  /** JSON array: [{"id":"ussd","apiKey":"...","secret":"..."}] */
  @IsString()
  CHANNEL_CLIENTS!: string;

  @IsString()
  @MinLength(16)
  CRON_SECRET!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  PAYMENT_EXPIRY_MINUTES = 15;

  /** Try dispatching outbox messages right after commit (disable in some tests). */
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  OUTBOX_DISPATCH_INLINE = true;
}

export function validateEnv(raw: Record<string, unknown>): EnvSchema {
  const env = plainToInstance(EnvSchema, raw, { enableImplicitConversion: false });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    const msg = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('\n  ');
    throw new Error(`Invalid environment:\n  ${msg}`);
  }
  if (env.NODE_ENV === 'production' && env.USSD_ALLOW_PLAINTEXT) {
    throw new Error('Invalid environment:\n  USSD_ALLOW_PLAINTEXT must not be enabled in production');
  }
  if (env.PORTAL_MODE === 'http' && !env.PORTAL_BASE_URL) {
    throw new Error('Invalid environment:\n  PORTAL_BASE_URL is required when PORTAL_MODE=http');
  }
  if (env.MONIME_MODE === 'http' && (!env.MONIME_ACCESS_TOKEN || !env.MONIME_SPACE_ID)) {
    throw new Error(
      'Invalid environment:\n  MONIME_ACCESS_TOKEN and MONIME_SPACE_ID are required when MONIME_MODE=http',
    );
  }
  return env;
}
