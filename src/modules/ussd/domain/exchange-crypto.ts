import { constants, createCipheriv, createDecipheriv, type KeyObject, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';

/**
 * Monime USSD flow exchange encryption (hybrid):
 *   encryptedAesKey       = RSA-OAEP(SHA-256 for OAEP and MGF1) of a 16-byte AES key
 *   encryptedExchangeData = [1 byte IV length = 12][IV][AES-128-GCM ciphertext][16-byte tag]
 * The reply is the same blob layout (fresh IV, same AES key), base64, text/plain.
 * Mirrors monimesl/ussd-flow-exchange-examples (nodejs/api/exchange.js).
 *
 * NOTE (Monime docs): requests are encrypted, not signed — decrypting proves
 * nothing about who sent it. Callers must not trust flowData.
 */
export class ExchangeCryptoError extends Error {}

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const AES_KEY_LENGTH = 16;
const MAX_BLOB = 64 * 1024;

export interface DecryptedExchange {
  aesKey: Buffer;
  request: unknown;
  /** index of the private key that worked (0 = current, 1 = previous) */
  keyIndex: number;
}

export function decryptExchange(body: unknown, privateKeys: readonly KeyObject[]): DecryptedExchange {
  const b = body as { encryptedAesKey?: unknown; encryptedExchangeData?: unknown } | null;
  if (!b || typeof b.encryptedAesKey !== 'string' || typeof b.encryptedExchangeData !== 'string') {
    throw new ExchangeCryptoError('Not an encrypted exchange request');
  }
  const wrappedKey = Buffer.from(b.encryptedAesKey, 'base64');
  const blob = Buffer.from(b.encryptedExchangeData, 'base64');
  if (blob.length > MAX_BLOB) throw new ExchangeCryptoError('Payload too large');

  // Key rotation: try the current key first, then the previous one.
  let aesKey: Buffer | null = null;
  let keyIndex = -1;
  for (const [i, key] of privateKeys.entries()) {
    try {
      aesKey = privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrappedKey);
      keyIndex = i;
      break;
    } catch {
      /* try next key */
    }
  }
  if (!aesKey) throw new ExchangeCryptoError('Could not unwrap the AES key with any configured private key');
  if (aesKey.length !== AES_KEY_LENGTH) throw new ExchangeCryptoError('AES key must be 16 bytes');

  const ivLength = blob[0];
  if (ivLength !== IV_LENGTH || blob.length < 1 + IV_LENGTH + TAG_LENGTH) throw new ExchangeCryptoError('Malformed encrypted payload');
  const iv = blob.subarray(1, 1 + IV_LENGTH);
  const tag = blob.subarray(blob.length - TAG_LENGTH);
  const ciphertext = blob.subarray(1 + IV_LENGTH, blob.length - TAG_LENGTH);

  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-128-gcm', aesKey, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new ExchangeCryptoError('Payload authentication failed');
  }
  try {
    return { aesKey, request: JSON.parse(plain.toString('utf8')) as unknown, keyIndex };
  } catch {
    throw new ExchangeCryptoError('Payload is not JSON');
  }
}

export function encryptReply(reply: unknown, aesKey: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-128-gcm', aesKey, iv, { authTagLength: TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(reply), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([IV_LENGTH]), iv, ciphertext, cipher.getAuthTag()]).toString('base64');
}

/** What Monime does on its side (used by tests and the dev tooling). */
export function encryptAsMonime(request: unknown, publicKey: KeyObject): { body: { encryptedAesKey: string; encryptedExchangeData: string }; aesKey: Buffer } {
  const aesKey = randomBytes(AES_KEY_LENGTH);
  const encryptedAesKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey).toString('base64');
  return { body: { encryptedAesKey, encryptedExchangeData: encryptReply(request, aesKey) }, aesKey };
}

export function decryptReply(base64: string, aesKey: Buffer): unknown {
  const blob = Buffer.from(base64, 'base64');
  const iv = blob.subarray(1, 1 + blob[0]!);
  const decipher = createDecipheriv('aes-128-gcm', aesKey, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(blob.subarray(blob.length - TAG_LENGTH));
  return JSON.parse(Buffer.concat([decipher.update(blob.subarray(1 + blob[0]!, blob.length - TAG_LENGTH)), decipher.final()]).toString('utf8'));
}
