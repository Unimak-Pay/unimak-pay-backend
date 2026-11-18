import { createHmac, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { JwtError, verifyJwt } from './jwt';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOW = new Date('2026-11-18T10:00:00Z');
const now = Math.floor(NOW.getTime() / 1000);
const ISS = 'https://abc.supabase.co/auth/v1';
const claims = { sub: '11111111-1111-4111-8111-111111111111', iss: ISS, aud: 'authenticated', exp: now + 600, iat: now, role: 'authenticated', email: 'a@unimak.edu.sl' };

const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });

function es256(payload: object, kid = 'k1', key: KeyObject = ec.privateKey) {
  const head = b64({ alg: 'ES256', kid, typ: 'JWT' });
  const body = b64(payload);
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}
function rs256(payload: object) {
  const head = b64({ alg: 'RS256', kid: 'r1' });
  const body = b64(payload);
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), rsa.privateKey).toString('base64url')}`;
}
function hs256(payload: object, secret: string, alg = 'HS256') {
  const head = b64({ alg });
  const body = b64(payload);
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

const keys: Record<string, KeyObject> = { k1: ec.publicKey, r1: rsa.publicKey };
const opts = { resolveKey: async (kid?: string) => (kid ? keys[kid] ?? null : null), issuer: ISS, audience: 'authenticated', now: NOW };

describe('verifyJwt', () => {
  it('accepts valid ES256 and RS256 tokens', async () => {
    await expect(verifyJwt(es256(claims), opts)).resolves.toMatchObject({ email: 'a@unimak.edu.sl' });
    await expect(verifyJwt(rs256(claims), opts)).resolves.toMatchObject({ sub: claims.sub });
  });

  it('rejects tampered payloads and foreign keys', async () => {
    const t = es256(claims);
    const [h, , s] = t.split('.');
    await expect(verifyJwt(`${h}.${b64({ ...claims, email: 'evil@x' })}.${s}`, opts)).rejects.toThrow('Bad signature');
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await expect(verifyJwt(es256(claims, 'k1', other.privateKey), opts)).rejects.toThrow('Bad signature');
    await expect(verifyJwt(es256(claims, 'unknown'), opts)).rejects.toThrow('Unknown signing key');
  });

  it('rejects alg=none, HS256 without a secret, and alg/key confusion', async () => {
    await expect(verifyJwt(`${b64({ alg: 'none' })}.${b64(claims)}.x`, opts)).rejects.toThrow(/not allowed/);
    await expect(verifyJwt(hs256(claims, 'secret'), opts)).rejects.toThrow('HS256 tokens are not accepted');
    // RS256 header pointing at the EC key
    const head = b64({ alg: 'RS256', kid: 'k1' });
    await expect(verifyJwt(`${head}.${b64(claims)}.${Buffer.alloc(256).toString('base64url')}`, opts)).rejects.toThrow('Key does not match RS256');
  });

  it('accepts legacy HS256 only with the configured secret', async () => {
    const secret = 'legacy-jwt-secret-0123456789abcdef';
    await expect(verifyJwt(hs256(claims, secret), { ...opts, hsSecret: secret })).resolves.toBeTruthy();
    await expect(verifyJwt(hs256(claims, 'wrong'), { ...opts, hsSecret: secret })).rejects.toThrow('Bad signature');
  });

  it('checks exp, nbf, iss and aud', async () => {
    await expect(verifyJwt(es256({ ...claims, exp: now - 60 }), opts)).rejects.toThrow('Token expired');
    await expect(verifyJwt(es256({ ...claims, exp: now - 10 }), opts)).resolves.toBeTruthy(); // within leeway
    await expect(verifyJwt(es256({ ...claims, nbf: now + 120 }), opts)).rejects.toThrow('not yet valid');
    await expect(verifyJwt(es256({ ...claims, iss: 'https://evil/auth/v1' }), opts)).rejects.toThrow('Wrong issuer');
    await expect(verifyJwt(es256({ ...claims, aud: 'anon' }), opts)).rejects.toThrow('Wrong audience');
    await expect(verifyJwt(es256({ ...claims, exp: undefined }), opts)).rejects.toThrow('Missing exp');
  });

  it('rejects malformed input', async () => {
    await expect(verifyJwt('abc', opts)).rejects.toBeInstanceOf(JwtError);
    await expect(verifyJwt('a.b.c', opts)).rejects.toThrow(/Malformed/);
    await expect(verifyJwt('x'.repeat(9000), opts)).rejects.toThrow('Token too long');
  });
});
