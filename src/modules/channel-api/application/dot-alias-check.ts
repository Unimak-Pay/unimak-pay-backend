import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { AppConfig } from '../../../config/app-config';
import { DomainError } from '../../../shared/domain/errors';
import { FixedWindowLimiter } from '../../../shared/domain/rate-limiter';
import { aliasMatches, canonicalAlias, maskAlias } from '../../payers/domain/user-alias';

export const ALIAS_MISMATCH_MESSAGE =
  "This ID isn't linked to the Dash number you're using. Use the number the university has for you, or contact the finance office.";
export const ALIAS_REQUIRED_MESSAGE =
  'Sign in with Dash to see this. It checks that this ID belongs to the number you use with Dash.';

export interface AliasRequest {
  /** X-User-Alias as sent (may be missing) */
  alias: string | undefined;
  ip: string;
  res: Response;
}

interface PayerLike { kind: string; ref: string; phone: string | null; email?: string | null }

/**
 * X-User-Alias check for the dot (docs/dot-extras.md). It is a check, not a login:
 * the dot sets the header itself. Failed matches are limited per IP and per payer
 * ID (DOT_ALIAS_FAILURES_PER_HOUR) so it can't be used to guess numbers. The alias
 * is never returned and only ever logged masked.
 */
@Injectable()
export class DotAliasCheck {
  private readonly logger = new Logger(DotAliasCheck.name);
  private readonly byIp: FixedWindowLimiter;
  private readonly byPayer: FixedWindowLimiter;
  private readonly required: boolean;

  constructor(config: AppConfig) {
    const limit = config.get('DOT_ALIAS_FAILURES_PER_HOUR');
    this.byIp = new FixedWindowLimiter(limit, 3_600_000);
    this.byPayer = new FixedWindowLimiter(limit, 3_600_000);
    this.required = config.get('DOT_ALIAS_REQUIRED');
  }

  /**
   * The payer lookup: FULL record on a match, or with no header while published dots
   * don't send it (unless DOT_ALIAS_REQUIRED); otherwise SHORT (enough to pay). Over
   * the failure limit it answers SHORT without checking, so it never confirms a guess.
   */
  forLookup(r: AliasRequest, payer: PayerLike): 'FULL' | 'SHORT' {
    if (!r.alias?.trim()) return this.required ? 'SHORT' : 'FULL';
    if (this.limited(r.ip, payer)) return 'SHORT';
    return this.matches(r, payer) ? 'FULL' : 'SHORT';
  }

  /** History, a payer's pay requests, creating one, clearance: a match is required. */
  require(r: AliasRequest, payer: PayerLike): void {
    if (!r.alias?.trim()) throw new DomainError('ALIAS_REQUIRED', ALIAS_REQUIRED_MESSAGE);
    if (this.limited(r.ip, payer)) {
      const wait = Math.max(this.byIp.retryAfter(r.ip), this.byPayer.retryAfter(payerKey(payer)));
      r.res.setHeader('Retry-After', String(wait));
      throw new DomainError('RATE_LIMITED', 'Too many tries with a different number. Try again later.');
    }
    if (!this.matches(r, payer)) throw new DomainError('ALIAS_MISMATCH', ALIAS_MISMATCH_MESSAGE);
  }

  private limited(ip: string, payer: PayerLike): boolean {
    return this.byIp.exhausted(ip) || this.byPayer.exhausted(payerKey(payer));
  }

  private matches(r: AliasRequest, payer: PayerLike): boolean {
    const a = canonicalAlias(r.alias);
    if (a && aliasMatches(a, payer)) return true;
    this.byIp.hit(r.ip);
    this.byPayer.hit(payerKey(payer));
    this.logger.log(`X-User-Alias mismatch for ${payer.kind} ${payer.ref} (alias ${maskAlias(r.alias ?? '')})`);
    return false;
  }
}

const payerKey = (p: PayerLike) => `${p.kind}:${p.ref}`;
