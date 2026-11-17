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

  @IsString()
  @MinLength(16)
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

  /** Monime financial account that receives the platform commission. */
  @IsString()
  PLATFORM_MONIME_ACCOUNT!: string;

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
