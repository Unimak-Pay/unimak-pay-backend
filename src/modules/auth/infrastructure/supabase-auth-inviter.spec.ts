import { SupabaseAuthInviter } from './supabase-auth-inviter';

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const cfg = { url: 'https://ref.supabase.co', serviceKey: 'service-key-for-tests', redirectTo: 'https://admin.unimak.test/auth/accept-invite' };

describe('SupabaseAuthInviter', () => {
  it('POSTs /auth/v1/invite with the service key and the redirect', async () => {
    const f = fakeFetch(200, { id: 'u-1', email: 'a@unimak.test' });
    expect(await new SupabaseAuthInviter(cfg, f.fn).invite('a@unimak.test')).toEqual({ status: 'SENT' });
    const c = f.calls[0]!;
    expect(c.url).toBe('https://ref.supabase.co/auth/v1/invite?redirect_to=https%3A%2F%2Fadmin.unimak.test%2Fauth%2Faccept-invite');
    expect(c.init.method).toBe('POST');
    expect(c.init.headers).toMatchObject({ apikey: 'service-key-for-tests', Authorization: 'Bearer service-key-for-tests' });
    expect(JSON.parse(String(c.init.body))).toEqual({ email: 'a@unimak.test' });
  });

  it('omits redirect_to when not configured (Supabase uses the Site URL)', async () => {
    const f = fakeFetch(200, {});
    await new SupabaseAuthInviter({ ...cfg, url: 'https://ref.supabase.co/', redirectTo: undefined }, f.fn).invite('a@unimak.test');
    expect(f.calls[0]!.url).toBe('https://ref.supabase.co/auth/v1/invite');
  });

  it('maps an existing confirmed account to ALREADY_REGISTERED', async () => {
    const f = fakeFetch(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
    expect((await new SupabaseAuthInviter(cfg, f.fn).invite('a@unimak.test')).status).toBe('ALREADY_REGISTERED');
  });

  it('reports rate limits, bad keys and outages as FAILED without throwing', async () => {
    const rate = await new SupabaseAuthInviter(cfg, fakeFetch(429, { error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' }).fn).invite('a@unimak.test');
    expect(rate).toEqual({ status: 'FAILED', message: expect.stringMatching(/rate limit.*SMTP/) });
    const key = await new SupabaseAuthInviter(cfg, fakeFetch(401, { message: 'Invalid API key' }).fn).invite('a@unimak.test');
    expect(key).toEqual({ status: 'FAILED', message: expect.stringMatching(/SUPABASE_SERVICE_ROLE_KEY/) });
    const down = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    expect((await new SupabaseAuthInviter(cfg, down).invite('a@unimak.test')).status).toBe('FAILED');
  });
});
