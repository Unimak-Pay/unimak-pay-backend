# UNIMAK fee collection — backend

System of record for money at the University of Makeni: fees, obligations, ledger,
payments and receipts. Payments are collected through **Monime** (USSD and the Dash
"Dots" mini-app, which call our **channel API**). Applicants and students come from
the university portal (mocked with JSON fixtures for now).

NestJS 11 · TypeScript (strict) · Prisma 6 · Postgres (Supabase) · one Vercel function · pnpm

---

## Run locally

Prerequisites: Node ≥ 22, pnpm, Docker.

```bash
pnpm install
cp .env.example .env          # then set MONIME_WEBHOOK_SECRET etc.
pnpm db:up                    # Postgres 16 on localhost:54329
pnpm db:deploy                # apply migrations
pnpm db:seed                  # fee types, 2026/27 fees, rate rules, pricing (idempotent)
pnpm monime:provision         # one Monime financial account per fee type + platform (idempotent)
pnpm start:local              # compiles with tsc, listens on PORT (3100 in .env.example)
```

`pnpm dev` does the same with `node --watch` on `dist/`; run `pnpm build:watch` in a
second terminal to recompile on change.

> **Why not tsx / ts-node --transpile-only?** Nest needs `emitDecoratorMetadata`,
> which esbuild-based tools don't emit. The app always runs from `tsc` output.

## Tests

```bash
pnpm test        # unit tests (domain: rate rules, fee split, holds, APP-once, receipts, outbox, webhook parsing)
pnpm test:e2e    # needs `pnpm db:up`
```

Each e2e run creates its own database `unimak_e2e_<timestamp>` on the local
container, applies migrations with `migrate deploy`, seeds it, and drops **only that
database** at the end (`E2E_KEEP_DB=1` keeps it for inspection). It refuses to run
against a non-local host unless `TEST_DATABASE_ADMIN_URL` is set explicitly.

## Mock vs real integrations

| Variable | `mock` | `http` |
|---|---|---|
| `PORTAL_MODE` | `MockPortalClient` reads `fixtures/portal/*.json` | `HttpPortalClient` → `PORTAL_BASE_URL` (1.5 s timeout) |
| `MONIME_MODE` | `MockMonimeClient` keeps payment codes, accounts, transfers and payouts in `MockMonimeRecord` | `HttpMonimeClient` → `MONIME_BASE_URL` |

Mock portal:

- `fixtures/portal/applicants.json` — 5 applicants (APPLIED / ADMITTED / REJECTED, one international)
- `fixtures/portal/students.json` — 10 students, programs BSC-CS, BSC-IT (COMPUTING) and BSC-NUR (HEALTH), levels 1–4, two final-year
- `fixtures/portal/notifications.log.json` — every `notifyPayment` is appended here (gitignored)
- `PORTAL_MOCK_LATENCY_MS` adds artificial latency
- unknown refs → `PortalError NOT_FOUND` (same shape as the HTTP client's 404); refs starting with `ERR-` → `UNAVAILABLE`

We send no SMS: Monime texts the payer itself when a payment completes (with its
order number).

`HttpMonimeClient` follows Monime's caph.2025-08-23 OpenAPI spec (Bearer token,
`Monime-Space-Id`, `Monime-Version`, `Idempotency-Key` ≤ 64 chars, `{ success, result }`
envelope, retries on network/429/5xx with the same key). Request bodies are pinned by
`http-monime.client.spec.ts`. One open question is marked `TODO(monime)`: the MSISDN
format for `authorizedPhoneNumber` on payment codes.

## Money flow in Monime

```
payer ──USSD payment code──▶ fee-type account (unimak-fee-app, -tuition, …)
                                   │  internal transfer (platform commission, per payment)
                                   ├──────────────────────────▶ platform account (unimak-platform)
                                   │  payout (manual, payouts.manage)
                                   └──────────────────────────▶ UNIMAK bank account
```

- **Financial accounts** (`pnpm monime:provision`): one per fee type plus the platform
  account, created with a unique Monime `reference` (`unimak-fee-<code>`,
  `unimak-platform`) so re-running never duplicates. A fee type can't be paid until its
  account exists.
- **Collections:** `POST /v1/payment-codes` (one-time, amount, duration = payment
  expiry, `reference` = our payment id, `authorizedPhoneNumber` = payer, into the fee
  type's account). `POST /v1/channel/payments` returns the `ussdCode` to dial.
- **Commission:** after settlement, the outbox calls `POST /v1/internal-transfers` from
  the fee-type account to the platform account (`Transfer` row, Idempotency-Key
  `commission-<paymentId>`); completed/failed by webhook.
- **Payouts** (`pnpm monime:payout`): withdraw to a bank (`GET /v1/banks` provider ids).
  Needs `payouts.manage`; checks Monime's available balance minus our own unsubmitted
  payouts under a row lock; `POST /v1/payouts` with Idempotency-Key = payout id;
  completed/failed by webhook (fees recorded).

### CLI

| Command | |
|---|---|
| `pnpm admin:create --email … --role SUPER_ADMIN` | invite an admin (bootstrap) |
| `pnpm ussd:flow https://<domain>` | render the USSD flow JSON for the Monime dashboard |
| `pnpm monime:provision` | create/link financial accounts (safe to re-run) |
| `pnpm monime:balances` | refresh and print available balances |
| `pnpm monime:banks [SL]` | bank provider ids for payouts |
| `pnpm monime:payout --account unimak-fee-tuition --amount 150000 --bank slb001 --account-number 0123456789 [--name …] [--narration …] [--key …] --confirm` | withdraw (dry run without `--confirm`; same `--key` never pays twice) |
| `pnpm monime:register-webhook https://<domain>/webhooks/monime` | subscribe our endpoint (HS256 with `MONIME_WEBHOOK_SECRET`) |

They read `.env` if present; point them at production by exporting the production
variables instead.

## Simulate a payment end to end

The channel API needs signed requests; `pnpm channel` signs them with the first client
in `CHANNEL_CLIENTS` (set `CHANNEL_CLIENT_ID=dots` to use another).

```bash
# 1. Look up a payer (creates their obligations lazily) and list obligations
pnpm channel GET /v1/channel/payers/applicant/APP-2026-0001
pnpm channel GET /v1/channel/payers/applicant/APP-2026-0001/obligations

# 2. Start a payment (amount in minor units: "15000" = SLE 150.00)
pnpm channel POST /v1/channel/payments \
  '{"obligationId":"<id>","amount":"15000","payerPhone":"+23276100001","channel":"USSD","idempotencyKey":"demo-1"}'

# 3. Complete it as Monime would (dev only — route absent when NODE_ENV=production)
curl -XPOST localhost:3100/dev/monime/simulate-webhook -H 'content-type: application/json' \
  -d '{"paymentId":"<paymentId>","outcome":"completed"}'
#    outcome: completed | failed | expired; optional "amount" (test mismatches), "eventId" (test redelivery)
#    also {"transferId": …} (commission transfer) and {"payoutId": …} with completed | failed

# 4. Check the result
pnpm channel GET /v1/channel/payments/<paymentId>
pnpm channel GET /v1/channel/payers/applicant/APP-2026-0001/receipts
pnpm channel GET /v1/channel/payments/status/<paymentRef>   # or Monime's order number
open "http://localhost:3100/r/<verifyCode>"           # Receipt.verifyCode
cat fixtures/portal/notifications.log.json            # portal.application_paid
```

The simulator moves the mock Monime object to its final state, builds the matching
event (`payment.processing_completed`, `internal_transfer.*`, `payout.*`), signs it
with `MONIME_WEBHOOK_SECRET` and runs it through the same receiver as
`POST /webhooks/monime`. For payments, `failed`/`expired` cancel/expire the mock payment
code and close our payment through reconciliation (we don't subscribe to
`payment_code.*`).

## API

There are four API surfaces, each with its own protection:

| Surface | Who calls it | Protection |
|---|---|---|
| `POST /v1/ussd/exchange/<token>` | Monime USSD flow (HTTPS domain) | RSA-OAEP + AES-128-GCM (our key pair), secret path token |
| `/v1/channel/*` | Dash Dots (and other server-to-server clients) | API key + HMAC over timestamp + body |
| `/v1/admin/*` | Admin portal | Supabase Auth access token + role/permission guard, 2FA for bursar & super admin |
| `/webhooks/monime`, `/r/:code` | Monime / anyone | Monime HMAC signature / public read-only |

### USSD flow exchange — `POST /v1/ussd/exchange/<USSD_EXCHANGE_PATH_TOKEN>`

Monime's USSD flow calls this on every page ([security docs](https://docs.monime.io/docs/products/ussd-flows/security)).
Request `{ encryptedAesKey, encryptedExchangeData }`: the AES-128 key is wrapped with
RSA-OAEP-SHA256 using **our** public key; the payload and our reply are AES-128-GCM
blobs `[1-byte IV len][12-byte IV][ciphertext][16-byte tag]`, reply as base64 `text/plain`,
HTTP 200 within 10 s.

Monime's docs state these requests **are not signed**: decrypting proves the sender has
our public key, not that it is Monime. So the endpoint also:

- lives behind a secret path token on our HTTPS domain (wrong token → 404);
- keeps the session state server-side (`UssdSession`); a page is only accepted when the
  session expects it, so `flowData` can't skip to "confirm payment";
- re-validates every input against our records (menu values, min/max amount);
- rate-limits ID lookups per subscriber (`USSD_MAX_LOOKUPS_PER_15_MIN`) and masks names.

The money itself is collected by Monime's `collect_payment` template, which the payer
authorises with their mobile-money PIN, so a forged request can at most create an
unpaid hold that expires after 15 minutes.

**Flow** (`ussd/unimak-flow.template.json`, modelled on Monime's own flows):

```
home ─┬─ pay ─────► id_type ─► enter_student_id | enter_application_ref ─► confirm_payer
      │                                     └─(not found)─► try_again (×2)
      │           ─► select_fee ─► [enter_amount ─(out of range)─► try_again]
      │           ─► confirm_payment ─► make_payment (collect_payment) ─► payment_started
      │                            └─ cancel ─► payment_cancelled
      ├─ balance ─► id_type ─► enter_… ─► stop("balances")
      ├─ status ──► enter_payment_ref ─► stop("Payment 12345678: PAID …")   (our ref or Monime order no.)
      └─ help ─► stop(USSD_HELP_MESSAGE)
```

Static menus and prompts live in the flow (prompts validate length on the handset);
every `on_done: exchange` page calls us. Student IDs and application refs may contain
letters. On *Confirm and pay* we record a PENDING `USSD_FLOW` payment (the hold;
idempotency key = session id + step) and navigate to `make_payment` with its
`template_data`:

| field | value |
|---|---|
| `amount` | major units, e.g. `"2500"` = SLE 2,500 (as in Monime's flows) |
| `payment_target_ref` | the fee account's UVAN (`TODO(monime)`: confirm) |
| `reference`, `metadata.payment_id` | our payment id (how the webhook is matched back) |
| `metadata.financial_account_id` | the fee type's Monime account |

The make_payment label shows our **payment ref** (8 digits) for status checks;
`payment_started` is static text (it is reached by `next`, so it gets no page data).

**The paying number.** Monime masks it everywhere (`channel.phoneNumber` =
`+23276****56`) and the USSD `subscriberId` is `uuidv5(msisdn, URL)`. So: at *Confirm
and pay* we check whether the dialling phone is the portal phone (hash match) and
record it if so; on completion we take, best first, a full number in the payment
metadata (`payer_phone` — authorised Dots payment codes carry it), an unmasked channel
number, our number if it fits Monime's mask, else Monime's masked number. Never the
portal phone unverified.

**Once a collection reaches Monime it always completes.** A payment that completes
after our 15-minute hold expired is still applied (late settlement); if the fee was
paid again meanwhile, the obligation goes negative and the webhook event is noted
*Overpaid by …* for a refund or credit.

**Setup**

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ussd_private.pem
openssl pkey -in ussd_private.pem -pubout -out ussd_public.pem     # paste into the flow's Security section
openssl rand -hex 32                                               # → USSD_EXCHANGE_PATH_TOKEN
# USSD_RSA_PRIVATE_KEY = contents of ussd_private.pem (literal \n is fine)
pnpm ussd:flow https://<domain> > unimak-flow.json                 # import into the Monime dashboard (contains the token: don't commit)
```

Rotation: put the new key in `USSD_RSA_PRIVATE_KEY`, the old one in
`USSD_RSA_PRIVATE_KEY_PREVIOUS`, save the new public key in the dashboard, remove the old
key after 30 minutes.

### Admin API — `/v1/admin` (admin portal)

`Authorization: Bearer <Supabase Auth access token>`. Sign-in — email + password, OAuth
providers and TOTP 2FA — happens in the admin portal with Supabase Auth; this backend
never handles passwords. It verifies the token (ES256/RS256 against the project's JWKS,
or legacy HS256 with `SUPABASE_JWT_SECRET`; issuer, audience `authenticated`, expiry) and
then requires an **active `AdminUser` with that email** (invite-only; bound to the
Supabase user id on first login).

| Role | Can (permission bundle) | 2FA |
|---|---|---|
| `SUPER_ADMIN` | everything, incl. users, payouts, account provisioning | required |
| `BURSAR` | fee setup, adjustments, refunds, reconciliation, transfer/outbox retries, reports | required |
| `FINANCE_OFFICER` | read payers/payments/accounts/payouts, export | — |
| `HEAD_OF_DEPARTMENT` | read-only, limited to their departments' payers and payments | — |
| `AUDITOR` | read-only everywhere, incl. the audit log | — |

Single permissions can be granted on their own (`extraPermissions`, e.g.
`instalments.manage`, or `payouts.manage` for a bursar). Nobody can grant permissions
they don't hold, and only super admins manage super admins. Every write is recorded in
`AuditLog` (before/after, append-only at the DB level).

| Method | Path | Permission |
|---|---|---|
| GET | `/me` | any admin |
| GET/POST/PATCH | `/users`, `/users/:id` | `users.manage` |
| GET | `/fee-types`, `/fees?feeType=&status=`, `/fees/:id` (with rules), `/fees/:id/preview?kind=&ref=` | `fees.read` |
| POST | `/fee-types` `{code, name, payerKind, recurrence}` — also creates the fee type's **Monime financial account**; `/fee-types/:id/account` retries it | `fees.manage` |
| PATCH | `/fee-types/:id` `{name}` | `fees.manage` |
| POST/PATCH | `/fees` `{feeTypeId, name, period, allowInstalments, defaultMinInstalment?, dueDate?}` (DRAFT), `/fees/:id` (status DRAFT→ACTIVE→CLOSED; ACTIVE needs a rate rule and the account) | `fees.manage` |
| POST/PUT/DELETE | `/fees/:id/rate-rules[/:ruleId]` `{programCode?, department?, level?, residency?, intake?, amount}` — ties rejected; deleting a tie-breaker refused | `fees.manage` |
| POST/DELETE | `/fees/:id/eligibility-rules[/:ruleId]` (same matchers + `finalYear?`) | `fees.manage` |
| PUT/DELETE | `/fees/:id/instalment-rules/:programCode` `{minInstalment}` | `instalments.manage` |
| GET | `/payments`, `/payments/:id` (filters: status, channel, feeType, payerRef, `ref` = payment ref / Monime order no. / spm-… id, from, to) | `payments.read` |
| POST | `/payments/:id/reconcile` | `payments.reconcile` |
| GET | `/financial-accounts`; POST `/financial-accounts/:id/refresh-balance` | `accounts.read` |
| POST | `/financial-accounts/provision` | `accounts.manage` |
| GET | `/banks`, `/payouts`, `/payouts/:id` | `payouts.read` |
| POST | `/payouts` `{account, amount, bankProviderId, accountNumber, accountName?, narration?, idempotencyKey}` | `payouts.manage` |
| GET | `/transfers`; POST `/transfers/:id/retry` | `transfers.read` / `transfers.retry` |
| GET | `/reconciliation` (open reconciliation items, last run, unmatched/failed webhook events, failed or stuck transfers and payouts, dead outbox, stale payments) | `reconciliation.read` |
| GET | `/reconciliation/runs`, `/reconciliation/runs/:id` | `reconciliation.read` |
| POST | `/reconciliation/runs` `{date?}`, `/reconciliation/items/:id/resolve` `{resolution}` | `reconciliation.manage` |
| POST | `/reconciliation/webhook-events/:id/resolve` `{resolution}`, `/…/replay` | `reconciliation.manage` |
| GET | `/outbox`; POST `/outbox/:id/retry` | `outbox.read` / `outbox.retry` |
| GET | `/audit-log` | `audit.read` |

Lists are cursor-paginated (`?limit=&cursor=` → `{ items, nextCursor }`); money is a
string of minor units. Errors: 401 `UNAUTHENTICATED`, 403 `FORBIDDEN` / `MFA_REQUIRED`.

Bootstrap the first admin: `pnpm admin:create --email you@unimak.edu.sl --role SUPER_ADMIN`,
then sign in to the portal with that email. In Supabase: disable public sign-ups (or rely
on the invite-only check), enable the email and OAuth providers you want, and enable TOTP MFA.

### Channel API — `/v1/channel` (Dash Dots)

Every request carries:

```
X-Api-Key:   <client apiKey>
X-Timestamp: <unix seconds, within ±5 min>
X-Signature: hex(HMAC-SHA256(secret, "<timestamp>.<raw body>"))   # empty body for GET
```

| Method | Path | |
|---|---|---|
| GET | `/payers/:kind/:ref` | `kind` = `applicant` \| `student`. Masked name, program line; creates missing obligations |
| GET | `/payers/:kind/:ref/obligations` | amount, paid, balance, holds, payable, minInstalment, dueDate, status |
| POST | `/quotes` | validate `{obligationId, amount, channel}` without creating anything |
| POST | `/payments` | `{obligationId, amount, payerPhone, channel, idempotencyKey}` → `{paymentId, paymentRef, status, expiresAt, ussdCode}` |
| GET | `/payments/:id` | only payments created by the calling client (incl. `paymentRef`, `monimeOrderNumber`) |
| GET | `/payments/status/:ref` | by our 8-digit `paymentRef` or Monime's order number (any channel; payer masked) |
| GET | `/payers/:kind/:ref/receipts` | |

Money is always a string of SLE minor units (`"150000"` = SLE 1,500.00); responses also
include a `display` string. Errors: `{ "error": { "code", "message", "details" } }`.

### Monime webhook — `POST /webhooks/monime`

```
Monime-Signature: t=<timestamp>,v1=<base64(HMAC-SHA256(MONIME_WEBHOOK_SECRET, "<t>_" + raw body))>
```

Envelope `{ apiVersion, event: { id, name, timestamp (unix s) }, object, data }`.

| Event | Effect |
|---|---|
| `payment.processing_completed` | settle the payment (matched by our id in `reference` / `metadata.paymentId`, then the payment code in `ownershipGraph.owner`) |
| `internal_transfer.completed` / `.failed` | commission `Transfer` → COMPLETED / FAILED (+ failure code) |
| `payout.completed` / `.failed` | `Payout` → COMPLETED (+ fees) / FAILED (+ failure code) |
| `financial_account.credited` / `.debited` | refresh the cached balance of our account. Not in the public docs; shape from Monime's internal `AccountCredited/AccountDebited` (`transactionId`, `transactionReference`, `amount`, `newBalance`, `creditTime`/`debitTime`); parsed leniently |

Anything else is stored and acknowledged as `IGNORED`. Register with
`pnpm monime:register-webhook` (subscribes all of the above).

Every delivery goes through an inbox keyed by `event.id` (`WebhookEvent`): redeliveries
return `DUPLICATE`; amount/currency mismatches or a second payment for a settled one are
acknowledged with 200 as `UNMATCHED` (+ note) for reconciliation; unexpected errors are
recorded as `FAILED` and return 5xx so Monime retries. `MONIME_WEBHOOK_TOLERANCE_SECONDS`
optionally rejects old timestamps (off by default: redeliveries may keep the original `t`).

### Public — `GET /r/:verifyCode`

Minimal HTML receipt check (masked name, amount, fee, date). `noindex`, `no-store`.

### Cron — `GET /cron/outbox`, `/cron/expire-payments`, `/cron/reconcile`

`Authorization: Bearer $CRON_SECRET` (what Vercel Cron sends). Outbox and expiry every
5 minutes, reconciliation nightly at 01:00 UTC; the nightly call also runs the expiry
and outbox sweeps (the fallback where only daily crons are allowed).

**Stale payments are cleared automatically.** An open payment past `expiresAt` (Monime
never called our webhook) becomes `EXPIRED`: every 5 minutes by a Supabase `pg_cron`
job (migration `expire_payments_job`; skipped on Postgres without pg_cron), by
`/cron/expire-payments`, and nightly. Holds stop counting at `expiresAt` anyway. If
the webhook arrives later the payment is still applied (late settlement).

## Nightly reconciliation

`/cron/reconcile` compares yesterday (UTC = Sierra Leone time) with Monime; admins can
run any past day (`POST /v1/admin/reconciliation/runs {date}`). Each run is a
`ReconciliationRun` with `ReconciliationItem`s:

| Check | Item | Status |
|---|---|---|
| Completed Monime payment into a fee account, ours not settled (missed webhook) | `MISSED_WEBHOOK_SETTLED` — settled through the normal settlement step | `AUTO_RESOLVED` |
| Completed Monime payment we can't match (or amount/currency/double payment) | `UNMATCHED_MONIME_PAYMENT` | `OPEN` |
| Our completed payment missing / not completed at Monime | `MISSING_AT_MONIME` | `OPEN` |
| Amounts differ | `AMOUNT_MISMATCH` | `OPEN` |
| Monime's fee ≠ our pricing | `MONIME_FEE_MISMATCH` | `OPEN` |
| Commission transfer missing, wrong amount or not completed | `COMMISSION_MISSING` / `_AMOUNT_MISMATCH` / `_NOT_COMPLETED` | `OPEN` |

Monime payments are listed per account with `GET /v1/payments?financialAccountId=`
(no date filter; the order is detected from the first page and a newest-first list
stops early — `TODO(monime)`: confirm ordering). Our payments the scan didn't see are
checked one by one with `GET /v1/payments/{id}`. Re-running a window doesn't duplicate
open items; admins resolve them with a note (audited).

## Domain rules (where to find them)

| Rule | Code |
|---|---|
| Money = `bigint` minor units, half-up basis points | `src/shared/domain/money.ts` |
| Most specific rate rule wins; ambiguous ties rejected on save | `catalog/domain/rate-rule.ts` |
| Eligibility (incl. finalYear); no rules = everyone of the payer kind | `catalog/domain/eligibility.ts` |
| Min instalment: program rule → fee default → full; capped at payable; `instalments.manage` | `catalog/domain/instalments.ts` |
| Lazy obligations; ONCE fee types (APP…) once per payer | `payers/domain/obligation-planner.ts` |
| balance = Σ ledger; holds = live INITIATED/PENDING; payable = balance − holds | `ledger/domain/position.ts` |
| Fee split: 2.5 % total first, platform = total − Monime, ≥ 0 | `payments/domain/fee-split.ts` |
| Accept payment: not settled, fee active, min ≤ amount ≤ payable | `payments/domain/payment-policy.ts` |
| Initiate under `SELECT … FOR UPDATE` on the obligation | `payments/application/initiate-payment.use-case.ts` |
| Settlement: ledger PAYMENT + receipt + outbox in one tx | `payments/application/settle-payment.service.ts` |
| Outbox backoff 1m, 5m, 30m, 2h, 12h → DEAD | `outbox/domain/retry.ts` |
| Payouts: `payouts.manage`, available − unsubmitted ≥ amount | `treasury/domain/payout-policy.ts` |

Ledger rows are append-only (DB trigger) with sign checks; the payment split is checked
by a DB constraint (`net = amount − monimeFee − platformFee`).

Transaction fees come from `PricingConfig` (per channel, `effectiveFrom`). Seeded:
USSD 2.5 % total / Monime 1 %; DOTS 2.5 % total / Monime SLE 0.50 flat. The payer never
pays extra; UNIMAK's settlement account receives `netAmount` and the platform commission
is moved by the `monime.commission_transfer` outbox message (idempotent on payment id).

## Layout

```
src/
  config/            validated env (class-validator)
  shared/            money, masking, errors, Prisma service, HMAC helpers
  modules/
    catalog/         fee types, fees, rate/eligibility/instalment rules, pricing
    payers/          portal lookup, payer snapshots, lazy obligations
    ledger/          append-only entries, positions
    payments/        quote, initiate, settle, expire, reconcile
    receipts/        numbering, verify codes
    outbox/          writer, dispatcher, handlers (portal, commission)
    integrations/    PortalClient, MonimeClient ports + mock/http adapters
    channel-api/     /v1/channel controllers, HMAC guard, public receipt page
    webhooks/        Monime signature, envelope parsing, inbox, receiver
    treasury/        financial accounts, commission transfers, payouts
    cron/            outbox sweep, payment expiry
    dev/             /dev/monime/simulate-webhook (non-production only)
    auth/            Supabase JWT verification, roles/permissions, admin guard
    audit/           append-only audit log
    admin-api/       /v1/admin controllers (users, payments, accounts, payouts, reconciliation)
    ussd/            Monime USSD flow exchange (crypto, state machine)
    reconciliation/  nightly comparison with Monime
```

Each module: `domain/` (pure), `application/` (use cases, ports), `infrastructure/`
(Prisma, HTTP), `interface/` (controllers, DTOs).

## Deploy (Vercel)

Project: `mohamed-ramseys-projects/unimak-pay-backend`. Pushes to `main` deploy to
production and other branches/PRs get previews once the GitHub repo is connected.

The build uses the **Build Output API**: `vercel.json` runs `node scripts/vercel-build.mjs`,
which compiles with `tsc` (Nest needs `emitDecoratorMetadata`), then assembles one
function in `.vercel/output/functions/index.func` — `dist/`, `fixtures/`, a flat
production-only `node_modules` (pnpm install with the hoisted linker, then everything
not reachable from our runtime dependencies is pruned, e.g. the Prisma CLI) and the
generated Prisma client with its `rhel-openssl-3.0.x` engine. Runtime: Node 24.
All paths route to that function; the Nest app is cached across invocations.

Crons come from `vercel-crons.json` (outbox and expiry every 5 min, reconciliation
01:00 UTC). The Hobby plan only allows daily crons: build with `VERCEL_CRONS=daily`
there (only reconciliation is kept). Payment expiry still runs every 5 minutes in
the database (`pg_cron`); the outbox is dispatched inline after each webhook, and
anything left over goes with the nightly run.

Check a build locally: `VERCEL_CRONS=daily node scripts/vercel-build.mjs` (keeps the
local Prisma engine; on Vercel only the Linux one is kept).

Set on Vercel: `DATABASE_URL` (Supabase transaction pooler,
`?pgbouncer=true&connection_limit=1`), `DIRECT_URL` (direct, for migrations),
`NODE_ENV=production`, `PUBLIC_BASE_URL`, the Monime and portal settings,
`MONIME_WEBHOOK_SECRET` (32–256 chars), `CHANNEL_CLIENTS`, `CRON_SECRET`,
`SUPABASE_URL` (admin auth), `USSD_RSA_PRIVATE_KEY` and `USSD_EXCHANGE_PATH_TOKEN`.
Run `pnpm db:deploy` with `DIRECT_URL` before deploying a new migration, then
`pnpm monime:provision` and `pnpm monime:register-webhook https://<domain>/webhooks/monime`
once per environment.
