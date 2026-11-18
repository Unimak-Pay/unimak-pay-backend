import { createPublicKey, type KeyObject } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import type { JwtAlg } from '../domain/jwt';

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  [k: string]: unknown;
}

const CACHE_MS = 10 * 60_000;
const MIN_REFETCH_MS = 30_000;
const FETCH_TIMEOUT_MS = 3_000;

/**
 * Supabase Auth signing keys: ${SUPABASE_URL}/auth/v1/.well-known/jwks.json,
 * cached 10 min; an unknown kid triggers a refetch (at most every 30 s) so key
 * rotation works. AUTH_JWKS_JSON replaces the fetch (tests / offline).
 */
@Injectable()
export class JwksKeyResolver {
  private readonly logger = new Logger(JwksKeyResolver.name);
  private keys = new Map<string, { key: KeyObject; alg?: string }>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly config: AppConfig) {
    const inline = config.get('AUTH_JWKS_JSON');
    if (inline) {
      this.load(JSON.parse(inline) as { keys: Jwk[] });
      this.fetchedAt = Number.POSITIVE_INFINITY;
    }
  }

  get configured(): boolean {
    return Boolean(this.config.get('AUTH_JWKS_JSON') || this.config.get('SUPABASE_URL'));
  }

  async resolve(kid: string | undefined, alg: JwtAlg): Promise<KeyObject | null> {
    if (!kid) return null;
    if (!this.keys.has(kid) || Date.now() - this.fetchedAt > CACHE_MS) {
      if (Date.now() - this.fetchedAt > MIN_REFETCH_MS || this.keys.size === 0) await this.refresh();
    }
    const entry = this.keys.get(kid);
    if (!entry) return null;
    if (entry.alg && entry.alg !== alg) return null;
    return entry.key;
  }

  private refresh(): Promise<void> {
    const base = this.config.get('SUPABASE_URL');
    if (!base || this.fetchedAt === Number.POSITIVE_INFINITY) return Promise.resolve();
    this.inflight ??= (async () => {
      try {
        const res = await fetch(`${base.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.load((await res.json()) as { keys: Jwk[] });
        this.fetchedAt = Date.now();
      } catch (err) {
        this.logger.error(`JWKS fetch failed: ${(err as Error).message}`);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private load(jwks: { keys: Jwk[] }): void {
    const next = new Map<string, { key: KeyObject; alg?: string }>();
    for (const jwk of jwks.keys ?? []) {
      if (!jwk.kid || (jwk.use && jwk.use !== 'sig') || (jwk.kty !== 'EC' && jwk.kty !== 'RSA')) continue;
      try {
        next.set(jwk.kid, { key: createPublicKey({ key: jwk as never, format: 'jwk' }), alg: jwk.alg });
      } catch (err) {
        this.logger.warn(`Skipping JWK ${jwk.kid}: ${(err as Error).message}`);
      }
    }
    this.keys = next;
  }
}
