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

  @IsUrl({ require_tld: false })
  @IsOptional()
  MONIME_BASE_URL?: string;

  @IsString()
  @IsOptional()
  MONIME_API_KEY?: string;

  @IsString()
  @IsOptional()
  MONIME_SPACE_ID?: string;

  @IsString()
  @MinLength(16)
  MONIME_WEBHOOK_SECRET!: string;

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
  if (env.MONIME_MODE === 'http' && (!env.MONIME_BASE_URL || !env.MONIME_API_KEY)) {
    throw new Error(
      'Invalid environment:\n  MONIME_BASE_URL and MONIME_API_KEY are required when MONIME_MODE=http',
    );
  }
  return env;
}
