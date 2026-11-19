/**
 * pnpm admin:login [--email you@unimak.edu.sl] [--json]
 *
 * Signs an admin in with Supabase Auth (password + authenticator code; enrols
 * the authenticator on first sign-in) and prints an access token for the admin
 * API. Prompts go to stderr, only the token goes to stdout:
 *
 *   TOKEN=$(pnpm -s admin:login)
 *   curl -H "authorization: Bearer $TOKEN" $API/v1/admin/me
 *
 * Needs SUPABASE_URL and SUPABASE_ANON_KEY (the publishable key from Project
 * Settings → API Keys; safe to keep in .env). API_URL (or PUBLIC_BASE_URL) is
 * where /v1/admin/me is checked. --json prints access + refresh token and expiry.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { adminLogin, LoginError, type LoginIo } from './admin-login.flow';

const { values: a } = parseArgs({ options: { email: { type: 'string' }, json: { type: 'boolean', default: false } } });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
const apiUrl = process.env.API_URL ?? process.env.PUBLIC_BASE_URL;

const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });

/** Reads a line without echoing it (falls back to a plain prompt when stdin isn't a TTY). */
function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) return rl.question(question);
  return new Promise((resolve) => {
    const out = rl as unknown as { _writeToOutput?: (s: string) => void };
    const original = out._writeToOutput;
    process.stderr.write(question);
    out._writeToOutput = (s: string) => {
      if (s.includes('\n') || s.includes('\r')) process.stderr.write('\n'); // echo nothing but the newline
    };
    void rl.question('').then((answer) => {
      out._writeToOutput = original;
      resolve(answer);
    });
  });
}

const io: LoginIo = {
  ask: (q) => rl.question(q),
  askSecret,
  say: (line) => process.stderr.write(`${line}\n`),
  async showQr(dataUrl) {
    // data:image/svg+xml;utf-8,<svg…> — written to a private temp file, removed after verification.
    const svg = decodeURIComponent(dataUrl.replace(/^data:image\/svg\+xml;[^,]*,/, ''));
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unimak-totp-'));
    const file = path.join(dir, 'qr.svg');
    writeFileSync(file, svg, { mode: 0o600 });
    process.stderr.write(`  or scan the QR code: open ${file}\n    (deleted when you're done)\n`);
    return () => rmSync(dir, { recursive: true, force: true });
  },
};

async function main(): Promise<void> {
  if (!supabaseUrl || !supabaseKey) {
    throw new LoginError(
      'Set SUPABASE_URL and SUPABASE_ANON_KEY (publishable key: Supabase → Project Settings → API Keys), e.g. in .env.production.local',
    );
  }
  const r = await adminLogin({ supabaseUrl, supabaseKey, apiUrl, email: a.email }, io);
  const expires = r.expiresAt ? new Date(r.expiresAt * 1000).toLocaleTimeString() : 'in about an hour';
  process.stderr.write(`\nAccess token below (valid until ${expires}). Use: authorization: Bearer <token>\n`);
  process.stdout.write(a.json ? `${JSON.stringify({ accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: r.expiresAt })}\n` : `${r.accessToken}\n`);
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`\n✗ ${err instanceof LoginError ? err.message : (err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
