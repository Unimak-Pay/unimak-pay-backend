import { createHmac, timingSafeEqual } from 'node:crypto';

export const MONIME_SIGNATURE_HEADER = 'monime-signature';

export type SignatureCheck = { valid: true; timestamp: string } | { valid: false; reason: string };

/**
 * Monime-Signature: t=<timestamp>,v1=<signature>
 * signature = base64(HMAC-SHA256(secret, "<timestamp>_" + rawBody))
 * (same scheme as monime-put-n-put-api)
 */
export function verifyMonimeSignature(params: {
  rawBody: Buffer;
  header: string | undefined;
  secret: string;
  toleranceSeconds?: number;
  now?: Date;
}): SignatureCheck {
  const { rawBody, header, secret } = params;
  if (!header) return { valid: false, reason: 'Missing Monime-Signature header' };
  const parts = parseHeader(header);
  const timestamp = parts.get('t');
  const signature = parts.get('v1');
  if (!timestamp || !signature) return { valid: false, reason: 'Malformed Monime-Signature header' };

  const given = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(sign(rawBody, secret, timestamp), 'utf8');
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return { valid: false, reason: 'Invalid signature' };
  }
  if (params.toleranceSeconds !== undefined) {
    const seconds = toUnixSeconds(timestamp);
    const now = (params.now ?? new Date()).getTime() / 1000;
    if (seconds === null || Math.abs(now - seconds) > params.toleranceSeconds) {
      return { valid: false, reason: 'Signature timestamp outside tolerance' };
    }
  }
  return { valid: true, timestamp };
}

/** Header value for a body; used by the dev simulator and tests. */
export function signMonimePayload(rawBody: Buffer | string, secret: string, timestamp: string): string {
  return `t=${timestamp},v1=${sign(rawBody, secret, timestamp)}`;
}

function sign(rawBody: Buffer | string, secret: string, timestamp: string): string {
  return createHmac('sha256', secret).update(`${timestamp}_`, 'utf8').update(rawBody).digest('base64');
}

function parseHeader(header: string): Map<string, string> {
  const parts = new Map<string, string>();
  for (const segment of header.split(',')) {
    const i = segment.indexOf('=');
    if (i > 0) parts.set(segment.slice(0, i).trim(), segment.slice(i + 1).trim());
  }
  return parts;
}

/** Accepts seconds or milliseconds since the epoch. */
function toUnixSeconds(ts: string): number | null {
  const v = Number(ts);
  if (!Number.isFinite(v)) return null;
  return v > 1e12 ? v / 1000 : v;
}
