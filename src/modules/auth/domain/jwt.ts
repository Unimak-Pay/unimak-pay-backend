import { createHmac, type KeyObject, timingSafeEqual, verify } from 'node:crypto';

/**
 * Minimal JWS (compact) verification for Supabase Auth access tokens, using
 * node:crypto only. Supports ES256 / RS256 (asymmetric signing keys via JWKS)
 * and HS256 (legacy shared JWT secret, only when a secret is configured).
 * The key type must match the algorithm, so a token can't pick a weaker one.
 */
export type JwtAlg = 'ES256' | 'RS256' | 'HS256';

export interface JwtClaims {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  email?: string;
  role?: string;
  aal?: string;
  is_anonymous?: boolean;
  session_id?: string;
  [k: string]: unknown;
}

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

export interface VerifyJwtOptions {
  /** asymmetric key for a kid (from JWKS); null if unknown */
  resolveKey: (kid: string | undefined, alg: JwtAlg) => Promise<KeyObject | null>;
  /** legacy HS256 secret; HS256 tokens are rejected without it */
  hsSecret?: string | null;
  issuer?: string | null;
  audience: string;
  now?: Date;
  leewaySeconds?: number;
}

const MAX_TOKEN_LENGTH = 8192;

export async function verifyJwt(token: string, opts: VerifyJwtOptions): Promise<JwtClaims> {
  if (token.length > MAX_TOKEN_LENGTH) throw new JwtError('Token too long');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new JwtError('Malformed token');
  const [h, p, s] = parts as [string, string, string];

  const header = parseJson<{ alg?: string; kid?: string; typ?: string; crit?: unknown }>(h, 'header');
  if (header.crit !== undefined) throw new JwtError('Unsupported crit header');
  const alg = header.alg;
  if (alg !== 'ES256' && alg !== 'RS256' && alg !== 'HS256') throw new JwtError(`Algorithm ${String(alg)} not allowed`);

  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, 'base64url');

  if (alg === 'HS256') {
    if (!opts.hsSecret) throw new JwtError('HS256 tokens are not accepted');
    const expected = createHmac('sha256', opts.hsSecret).update(data).digest();
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) throw new JwtError('Bad signature');
  } else {
    const key = await opts.resolveKey(header.kid, alg);
    if (!key) throw new JwtError('Unknown signing key');
    if (alg === 'ES256') {
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new JwtError('Key does not match ES256');
      }
      if (sig.length !== 64 || !verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)) throw new JwtError('Bad signature');
    } else {
      if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
        throw new JwtError('Key does not match RS256');
      }
      if (!verify('sha256', data, key, sig)) throw new JwtError('Bad signature');
    }
  }

  const claims = parseJson<JwtClaims>(p, 'payload');
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const leeway = opts.leewaySeconds ?? 30;
  if (typeof claims.exp !== 'number') throw new JwtError('Missing exp');
  if (claims.exp <= now - leeway) throw new JwtError('Token expired');
  if (typeof claims.nbf === 'number' && claims.nbf > now + leeway) throw new JwtError('Token not yet valid');
  if (typeof claims.iat === 'number' && claims.iat > now + leeway) throw new JwtError('Token issued in the future');
  if (opts.issuer && claims.iss !== opts.issuer) throw new JwtError('Wrong issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.audience)) throw new JwtError('Wrong audience');
  return claims;
}

function parseJson<T>(segment: string, what: string): T {
  try {
    const v = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as T;
  } catch {
    throw new JwtError(`Malformed ${what}`);
  }
}
