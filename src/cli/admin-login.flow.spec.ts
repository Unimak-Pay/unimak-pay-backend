import { adminLogin, LoginError, type LoginIo } from './admin-login.flow';

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const AAL1 = jwt({ aal: 'aal1' });
const AAL2 = jwt({ aal: 'aal2' });

type Route = (body: Record<string, unknown> | undefined, headers: Record<string, string>) => { status?: number; json: unknown };

/** A tiny fake of Supabase Auth + our /v1/admin/me, recording calls. */
function fake(routes: Record<string, Route>) {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}${new URL(url).search}`;
    calls.push(key);
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ msg: `no route ${key}` }), { status: 404 });
    const r = route(init?.body ? JSON.parse(String(init.body)) : undefined, (init?.headers ?? {}) as Record<string, string>);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

function io(answers: string[]): LoginIo & { said: string[] } {
  const said: string[] = [];
  return {
    said,
    ask: async () => answers.shift() ?? '',
    askSecret: async () => 'pw',
    say: (l) => said.push(l),
  };
}

const base = { supabaseUrl: 'https://proj.supabase.co/', supabaseKey: 'pk', apiUrl: 'https://api.test', email: 'Admin@Unimak.test' };
const signIn: Route = (body, h) => {
  expect(h.apikey).toBe('pk');
  expect(body).toEqual({ email: 'admin@unimak.test', password: 'pw' });
  return { json: { access_token: AAL1, refresh_token: 'r1' } };
};
const me: Route = (_b, h) => {
  expect(h.authorization).toBe(`Bearer ${AAL2}`);
  return { json: { email: 'admin@unimak.test', role: 'SUPER_ADMIN', permissions: ['fees.read'] } };
};

describe('adminLogin', () => {
  it('first sign-in: enrols TOTP (dropping a stale unverified factor), verifies, checks /v1/admin/me', async () => {
    const { f, calls } = fake({
      'POST /auth/v1/token?grant_type=password': signIn,
      'GET /auth/v1/user': () => ({ json: { factors: [{ id: 'old', factor_type: 'totp', status: 'unverified' }] } }),
      'DELETE /auth/v1/factors/old': () => ({ json: {} }),
      'POST /auth/v1/factors': (b) => {
        expect(b).toMatchObject({ factor_type: 'totp' });
        return { json: { id: 'fac-1', totp: { secret: 'SECRET', uri: 'otpauth://totp/x', qr_code: 'data:image/svg+xml;utf-8,<svg/>' } } };
      },
      'POST /auth/v1/factors/fac-1/challenge': () => ({ json: { id: 'ch-1' } }),
      'POST /auth/v1/factors/fac-1/verify': (b) => (b?.code === '123456'
        ? { json: { access_token: AAL2, refresh_token: 'r2', expires_at: 1_800_000_000 } }
        : { status: 422, json: { error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' } }),
      'GET /v1/admin/me': me,
    });
    const shown: string[] = [];
    let cleaned = false;
    const user = io(['12 34 5', '000000', '123456']);
    user.showQr = async (svg) => { shown.push(svg); return () => { cleaned = true; }; };

    const r = await adminLogin({ ...base, fetch: f }, user);
    expect(r).toMatchObject({ accessToken: AAL2, refreshToken: 'r2', expiresAt: 1_800_000_000, aal: 'aal2', admin: { role: 'SUPER_ADMIN' } });
    expect(user.said).toEqual(expect.arrayContaining(['  secret: SECRET', '  The code is 6 digits.']));
    expect(user.said.some((l) => /Invalid TOTP code entered.*try again/.test(l))).toBe(true);
    expect(shown).toEqual(['data:image/svg+xml;utf-8,<svg/>']);
    expect(cleaned).toBe(true);
    expect(calls.filter((c) => c.endsWith('/challenge'))).toHaveLength(2); // one per real attempt
  });

  it('later sign-ins use the verified factor', async () => {
    const { f, calls } = fake({
      'POST /auth/v1/token?grant_type=password': signIn,
      'GET /auth/v1/user': () => ({ json: { factors: [{ id: 'fac-1', factor_type: 'totp', status: 'verified' }] } }),
      'POST /auth/v1/factors/fac-1/challenge': () => ({ json: { id: 'ch-1' } }),
      'POST /auth/v1/factors/fac-1/verify': () => ({ json: { access_token: AAL2, refresh_token: 'r2' } }),
      'GET /v1/admin/me': me,
    });
    const r = await adminLogin({ ...base, fetch: f }, io(['654321']));
    expect(r.aal).toBe('aal2');
    expect(calls).not.toContain('POST /auth/v1/factors');
  });

  it('explains Supabase and API errors', async () => {
    const bad = fake({ 'POST /auth/v1/token?grant_type=password': () => ({ status: 400, json: { error_code: 'invalid_credentials', msg: 'Invalid login credentials' } }) });
    await expect(adminLogin({ ...base, fetch: bad.f }, io([]))).rejects.toThrow(
      new LoginError('Supabase 400 invalid_credentials: Invalid login credentials (wrong password, or no Supabase user with this email (Authentication → Users))'),
    );

    const notAdmin = fake({
      'POST /auth/v1/token?grant_type=password': signIn,
      'GET /auth/v1/user': () => ({ json: { factors: [{ id: 'fac-1', factor_type: 'totp', status: 'verified' }] } }),
      'POST /auth/v1/factors/fac-1/challenge': () => ({ json: { id: 'ch-1' } }),
      'POST /auth/v1/factors/fac-1/verify': () => ({ json: { access_token: AAL2, refresh_token: 'r2' } }),
      'GET /v1/admin/me': () => ({ status: 403, json: { error: { code: 'FORBIDDEN', message: 'Not an active UNIMAK admin' } } }),
    });
    await expect(adminLogin({ ...base, fetch: notAdmin.f }, io(['654321']))).rejects.toThrow(/refused the token: 403 FORBIDDEN Not an active UNIMAK admin/);
  });
});
