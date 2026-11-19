import { Logger } from '@nestjs/common';
import type { AuthInviter, InviteOutcome } from '../application/auth-inviter.port';

const TIMEOUT_MS = 10_000;

export interface SupabaseInviterConfig {
  /** https://<ref>.supabase.co */
  url: string;
  /** service_role (legacy JWT) or secret (sb_secret_…) key — server only. */
  serviceKey: string;
  /** Page of the admin dashboard where the invitee sets a password (must be in Supabase's Redirect URLs). */
  redirectTo?: string;
}

/**
 * POST /auth/v1/invite — what supabase-js `auth.admin.inviteUserByEmail` calls.
 * Supabase sends its "Invite user" email template through the project's SMTP.
 */
export class SupabaseAuthInviter implements AuthInviter {
  private readonly logger = new Logger(SupabaseAuthInviter.name);

  constructor(
    private readonly cfg: SupabaseInviterConfig,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  async invite(email: string): Promise<InviteOutcome> {
    const url = new URL('auth/v1/invite', this.cfg.url.endsWith('/') ? this.cfg.url : `${this.cfg.url}/`);
    if (this.cfg.redirectTo) url.searchParams.set('redirect_to', this.cfg.redirectTo);
    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), {
        method: 'POST',
        headers: { apikey: this.cfg.serviceKey, Authorization: `Bearer ${this.cfg.serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(`Supabase invite unreachable: ${(err as Error).message}`);
      return { status: 'FAILED', message: 'Could not reach Supabase Auth; try re-sending the invitation' };
    }
    if (res.ok) return { status: 'SENT' };

    const body = (await res.json().catch(() => ({}))) as { error_code?: string; code?: string | number; msg?: string; message?: string; error_description?: string };
    const code = body.error_code ?? (typeof body.code === 'string' ? body.code : undefined);
    const msg = body.msg ?? body.message ?? body.error_description ?? `HTTP ${res.status}`;
    if (code === 'email_exists' || code === 'user_already_exists' || /already been registered/i.test(msg)) {
      return { status: 'ALREADY_REGISTERED', message: 'This email already has a sign-in; they can sign in (or use "Forgot password")' };
    }
    this.logger.warn(`Supabase invite failed: ${res.status} ${code ?? ''} ${msg}`);
    if (res.status === 401 || res.status === 403) return { status: 'FAILED', message: 'Supabase rejected the service role key (SUPABASE_SERVICE_ROLE_KEY)' };
    if (res.status === 429 || code === 'over_email_send_rate_limit') {
      return { status: 'FAILED', message: 'Supabase email rate limit reached; set up custom SMTP or re-send later' };
    }
    return { status: 'FAILED', message: `Supabase: ${msg}` };
  }
}

/** No service role key: invitations are rows only (the person signs up / uses OAuth). */
export class DisabledAuthInviter implements AuthInviter {
  async invite(): Promise<InviteOutcome> {
    return { status: 'NOT_CONFIGURED', message: 'SUPABASE_SERVICE_ROLE_KEY is not set, so no invite email was sent' };
  }
}
