/**
 * Supabase Auth sign-in for admins, without the dashboard: password → aal1,
 * then TOTP (enrolling it the first time) → aal2, then GET /v1/admin/me to
 * bind the invitation and confirm the role. I/O is injected so it can be tested.
 */

export interface LoginIo {
  /** visible prompt */
  ask(question: string): Promise<string>;
  /** hidden prompt (passwords) */
  askSecret(question: string): Promise<string>;
  /** progress / instructions (stderr) */
  say(line: string): void;
  /** the TOTP QR code (SVG data URL) for first-time enrolment; returns a cleanup */
  showQr?(svgDataUrl: string): Promise<(() => void) | void>;
}

export interface LoginConfig {
  supabaseUrl: string;
  /** publishable / anon key */
  supabaseKey: string;
  /** our API, for /v1/admin/me (optional) */
  apiUrl?: string;
  email?: string;
  fetch?: typeof fetch;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  aal: string;
  admin: { email?: string; role?: string; permissions?: string[] } | null;
}

interface Session { access_token: string; refresh_token: string; expires_at?: number }
interface Factor { id: string; factor_type: string; status: 'verified' | 'unverified'; friendly_name?: string }

export class LoginError extends Error {}

const TOTP_CODE = /^\d{6}$/;
const MAX_CODE_TRIES = 3;

export async function adminLogin(cfg: LoginConfig, io: LoginIo): Promise<LoginResult> {
  const f = cfg.fetch ?? fetch;
  const sb = cfg.supabaseUrl.replace(/\/+$/, '');
  const auth = async <T>(path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<T> => {
    const res = await f(`${sb}/auth/v1${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: {
        apikey: cfg.supabaseKey,
        'content-type': 'application/json',
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    const json = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    if (!res.ok) throw new LoginError(supabaseMessage(res.status, json));
    return json as T;
  };

  const email = (cfg.email ?? (await io.ask('Email: '))).trim().toLowerCase();
  if (!email.includes('@')) throw new LoginError('Enter the email your admin invitation was sent to');
  const password = await io.askSecret('Password: ');
  if (!password) throw new LoginError('Password is required');

  let session = await auth<Session>('/token?grant_type=password', { body: { email, password } });
  io.say('✓ Password accepted');

  // TOTP: use the verified factor, or enrol one (dropping half-finished ones, whose secret can't be shown again).
  const user = await auth<{ factors?: Factor[] }>('/user', { token: session.access_token });
  const totp = (user.factors ?? []).filter((x) => x.factor_type === 'totp');
  let factor = totp.find((x) => x.status === 'verified');
  let cleanup: (() => void) | void = undefined;
  if (!factor) {
    for (const stale of totp) await auth(`/factors/${stale.id}`, { method: 'DELETE', token: session.access_token });
    const enrolled = await auth<{ id: string; totp: { secret: string; uri: string; qr_code: string } }>('/factors', {
      token: session.access_token,
      body: { factor_type: 'totp', friendly_name: `unimak-admin-${Date.now()}` },
    });
    io.say('');
    io.say('Set up two-factor authentication (first sign-in only).');
    io.say('Add this account to an authenticator app (Google Authenticator, Authy, 1Password…):');
    io.say(`  secret: ${enrolled.totp.secret}`);
    io.say(`  or the link: ${enrolled.totp.uri}`);
    cleanup = await io.showQr?.(enrolled.totp.qr_code);
    io.say('');
    factor = { id: enrolled.id, factor_type: 'totp', status: 'unverified' };
  }

  try {
    for (let attempt = 1; ; attempt++) {
      const code = (await io.ask('6-digit code from your authenticator app: ')).replace(/\s+/g, '');
      if (!TOTP_CODE.test(code)) {
        io.say('  The code is 6 digits.');
        if (attempt >= MAX_CODE_TRIES) throw new LoginError('No valid code entered');
        continue;
      }
      const challenge = await auth<{ id: string }>(`/factors/${factor.id}/challenge`, { token: session.access_token, body: {} });
      try {
        session = await auth<Session>(`/factors/${factor.id}/verify`, { token: session.access_token, body: { challenge_id: challenge.id, code } });
        break;
      } catch (err) {
        if (!(err instanceof LoginError) || attempt >= MAX_CODE_TRIES) throw err;
        io.say(`  ${err.message} — try again (wait for the next code if it just changed).`);
      }
    }
  } finally {
    if (cleanup) cleanup();
  }
  const aal = jwtClaim(session.access_token, 'aal') ?? 'aal1';
  io.say(`✓ Two-factor verified (${aal})`);

  let admin: LoginResult['admin'] = null;
  if (cfg.apiUrl) {
    const res = await f(`${cfg.apiUrl.replace(/\/+$/, '')}/v1/admin/me`, { headers: { authorization: `Bearer ${session.access_token}` } });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const e = (body['error'] ?? {}) as { code?: string; message?: string };
      throw new LoginError(`Signed in to Supabase, but the UNIMAK API refused the token: ${res.status} ${e.code ?? ''} ${e.message ?? ''}`.trim());
    }
    admin = body as LoginResult['admin'];
    io.say(`✓ UNIMAK admin: ${admin?.email} (${admin?.role}, ${admin?.permissions?.length ?? 0} permissions)`);
  }

  return { accessToken: session.access_token, refreshToken: session.refresh_token, expiresAt: session.expires_at ?? null, aal, admin };
}

function supabaseMessage(status: number, j: Record<string, unknown>): string {
  const code = (j['error_code'] ?? j['error']) as string | undefined;
  const msg = (j['msg'] ?? j['error_description'] ?? j['message']) as string | undefined;
  const hint: Record<string, string> = {
    invalid_credentials: 'wrong password, or no Supabase user with this email (Authentication → Users)',
    email_not_confirmed: 'confirm the user in Supabase (Authentication → Users), or recreate it with "Auto Confirm User"',
    mfa_totp_enroll_not_enabled: 'enable TOTP under Authentication → Multi-Factor',
    mfa_verification_failed: 'wrong or expired code',
  };
  return [`Supabase ${status}${code ? ` ${code}` : ''}: ${msg ?? 'request failed'}`, code && hint[code] ? `(${hint[code]})` : ''].filter(Boolean).join(' ');
}

function jwtClaim(token: string, claim: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof payload[claim] === 'string' ? (payload[claim] as string) : undefined;
  } catch {
    return undefined;
  }
}
