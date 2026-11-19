/**
 * Asks the identity provider (Supabase Auth) to email a person an invitation
 * to create their sign-in. Never throws: the AdminUser row is the source of
 * truth for access, and an invite email can be re-sent.
 */
export const AUTH_INVITER = Symbol('AUTH_INVITER');

export type InviteOutcome =
  /** Supabase created the user (or re-used an unconfirmed one) and sent the invite email. */
  | { status: 'SENT' }
  /** The email already has a confirmed Supabase account; they just sign in with it. */
  | { status: 'ALREADY_REGISTERED'; message: string }
  /** No SUPABASE_SERVICE_ROLE_KEY: nothing sent, the person must get an account another way. */
  | { status: 'NOT_CONFIGURED'; message: string }
  /** Supabase refused or was unreachable (e.g. email rate limit, SMTP not set up). */
  | { status: 'FAILED'; message: string };

export interface AuthInviter {
  invite(email: string): Promise<InviteOutcome>;
}
