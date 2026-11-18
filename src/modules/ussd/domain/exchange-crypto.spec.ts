import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { decryptExchange, decryptReply, encryptAsMonime, encryptReply, ExchangeCryptoError } from './exchange-crypto';
import { toInternationalMsisdn } from '../../../shared/domain/phone';

const current = generateKeyPairSync('rsa', { modulusLength: 2048 });
const previous = generateKeyPairSync('rsa', { modulusLength: 2048 });
const request = { global: { sessionId: 's-1', subscriberId: 'x' }, currentPage: 'start', flowData: {} };

describe('USSD exchange crypto (RSA-OAEP-SHA256 + AES-128-GCM)', () => {
  it('round-trips a Monime request and our encrypted reply', () => {
    const { body, aesKey } = encryptAsMonime(request, current.publicKey);
    const d = decryptExchange(body, [current.privateKey]);
    expect(d.request).toEqual(request);
    expect(d.keyIndex).toBe(0);
    const reply = encryptReply({ action: 'stop', message: 'Bye' }, d.aesKey);
    expect(reply).toMatch(/^[A-Za-z0-9+/]+=*$/); // single-line base64
    expect(decryptReply(reply, aesKey)).toEqual({ action: 'stop', message: 'Bye' });
  });

  it('uses the reply blob layout [len=12][iv][ciphertext][tag] with a fresh IV', () => {
    const key = randomBytes(16);
    const a = Buffer.from(encryptReply({ a: 1 }, key), 'base64');
    const b = Buffer.from(encryptReply({ a: 1 }, key), 'base64');
    expect(a[0]).toBe(12);
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
  });

  it('accepts the previous key during rotation', () => {
    const { body } = encryptAsMonime(request, previous.publicKey);
    expect(decryptExchange(body, [current.privateKey, previous.privateKey]).keyIndex).toBe(1);
    expect(() => decryptExchange(body, [current.privateKey])).toThrow(/unwrap/);
  });

  it('rejects tampering, plaintext and malformed blobs', () => {
    const { body } = encryptAsMonime(request, current.publicKey);
    const blob = Buffer.from(body.encryptedExchangeData, 'base64');
    blob[20] = blob[20]! ^ 0xff;
    expect(() => decryptExchange({ ...body, encryptedExchangeData: blob.toString('base64') }, [current.privateKey])).toThrow('Payload authentication failed');
    expect(() => decryptExchange(request, [current.privateKey])).toThrow(ExchangeCryptoError);
    expect(() => decryptExchange({ ...body, encryptedExchangeData: Buffer.from([12, 1, 2]).toString('base64') }, [current.privateKey])).toThrow('Malformed');
  });
});

describe('MSISDN normalisation', () => {
  it('normalises Sierra Leone numbers to +232…', () => {
    expect(toInternationalMsisdn('23276123456')).toBe('+23276123456');
    expect(toInternationalMsisdn('076123456')).toBe('+23276123456');
    expect(toInternationalMsisdn('+23276123456')).toBe('+23276123456');
    expect(toInternationalMsisdn('+23276****56')).toBeNull();
  });
});
