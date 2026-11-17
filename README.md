# UNIMAK fee collection — backend

System of record for money at the University of Makeni: fees, obligations, ledger,
payments and receipts. Payments are collected through **Monime** (USSD and the Dash
"Dots" mini-app, which call our **channel API**). Applicants and students come from
the university portal (mocked with JSON fixtures for now).

NestJS 12 · TypeScript (strict) · Prisma 6 · Postgres (Supabase) · one Vercel function · pnpm

---

## Run locally

Prerequisites: Node ≥ 22, pnpm, Docker.

```bash
pnpm install
cp .env.example .env          # then set MONIME_WEBHOOK_SECRET etc.
pnpm db:up                    # Postgres 16 on localhost:54329
pnpm db:deploy                # apply migrations
pnpm db:seed                  # fee types, 2026/27 fees, rate rules, pricing (idempotent)
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
| `MONIME_MODE` | `MockMonimeClient` records collections/transfers in `MockMonimeRecord` | `HttpMonimeClient` → `MONIME_BASE_URL` |

Mock portal:

- `fixtures/portal/applicants.json` — 5 applicants (APPLIED / ADMITTED / REJECTED, one international)
- `fixtures/portal/students.json` — 10 students, programs BSC-CS, BSC-IT (COMPUTING) and BSC-NUR (HEALTH), levels 1–4, two final-year
- `fixtures/portal/notifications.log.json` — every `notifyPayment` is appended here (gitignored)
- `PORTAL_MOCK_LATENCY_MS` adds artificial latency
- unknown refs → `PortalError NOT_FOUND` (same shape as the HTTP client's 404); refs starting with `ERR-` → `UNAVAILABLE`

SMS goes to the console (`[SMS] → +232…`) in every mode for now.

`HttpMonimeClient` uses the confirmed Monime transport (Bearer token,
`Monime-Space-Id`, `Monime-Version: caph.2025-08-23`, `Idempotency-Key`, `{ success, result }`
envelope, retries). The **collection** and **account-to-account transfer** endpoints
are not confirmed yet: search for `TODO(monime)`.

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

# 4. Check the result
pnpm channel GET /v1/channel/payments/<paymentId>
pnpm channel GET /v1/channel/payers/applicant/APP-2026-0001/receipts
open "http://localhost:3100/r/<verifyCode>"           # link is in the SMS log line
cat fixtures/portal/notifications.log.json            # portal.application_paid
```

`completed` builds a realistic `payment.processing_completed` event, signs it with
`MONIME_WEBHOOK_SECRET` and runs it through the same receiver as `POST /webhooks/monime`.
Monime sends no payment-failed webhook, so `failed`/`expired` mark the mock collection
and close our payment through reconciliation (`getPayment` polling).

## API

### Channel API — `/v1/channel` (USSD, Dots)

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
| POST | `/payments` | `{obligationId, amount, payerPhone, channel, idempotencyKey}` → `{paymentId, status, expiresAt}` |
| GET | `/payments/:id` | only payments created by the calling client |
| GET | `/payers/:kind/:ref/receipts` | |
| POST | `/receipts/:number/resend` | re-sends to the phone on record |

Money is always a string of SLE minor units (`"150000"` = SLE 1,500.00); responses also
include a `display` string. Errors: `{ "error": { "code", "message", "details" } }`.

### Monime webhook — `POST /webhooks/monime`

```
Monime-Signature: t=<timestamp>,v1=<base64(HMAC-SHA256(MONIME_WEBHOOK_SECRET, "<t>_" + raw body))>
```

Envelope `{ apiVersion, event: { id, name, timestamp }, object, data }`. Handled:
`payment.processing_completed` (matched by our payment id in `reference` / `metadata.paymentId`,
then the owner / Monime ids). Other events are stored and acknowledged as `IGNORED`.

Every delivery goes through an inbox keyed by `event.id` (`WebhookEvent`): redeliveries
return `DUPLICATE`; amount/currency mismatches or a second payment for a settled one are
acknowledged with 200 as `UNMATCHED` (+ note) for reconciliation; unexpected errors are
recorded as `FAILED` and return 5xx so Monime retries. `MONIME_WEBHOOK_TOLERANCE_SECONDS`
optionally rejects old timestamps (off by default: redeliveries may keep the original `t`).

### Public — `GET /r/:verifyCode`

Minimal HTML receipt check (masked name, amount, fee, date). `noindex`, `no-store`.

### Cron — `GET /cron/outbox`, `GET /cron/expire-payments`

`Authorization: Bearer $CRON_SECRET` (what Vercel Cron sends).

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
    receipts/        numbering, verify codes, resend
    outbox/          writer, dispatcher, handlers (SMS, portal, commission)
    integrations/    PortalClient, MonimeClient, SmsSender ports + mock/http adapters
    channel-api/     /v1/channel controllers, HMAC guard, public receipt page
    webhooks/        Monime signature, envelope parsing, inbox, receiver
    cron/            outbox sweep, payment expiry
    dev/             /dev/monime/simulate-webhook (non-production only)
    admin-api/       stub (next phase)
```

Each module: `domain/` (pure), `application/` (use cases, ports), `infrastructure/`
(Prisma, HTTP), `interface/` (controllers, DTOs).

## Deploy (Vercel)

One function, `api/index.js`, loads the `tsc` output in `dist/` and caches the Nest app
across invocations. `vercel.json` rewrites every path to it and schedules both cron
routes every 5 minutes (sub-daily crons need a Pro plan).

Set on Vercel: `DATABASE_URL` (Supabase transaction pooler,
`?pgbouncer=true&connection_limit=1`), `DIRECT_URL` (direct, for migrations),
`NODE_ENV=production`, `PUBLIC_BASE_URL`, the Monime and portal settings,
`MONIME_WEBHOOK_SECRET`, `PLATFORM_MONIME_ACCOUNT`, `CHANNEL_CLIENTS`, `CRON_SECRET`.
Run `pnpm db:deploy` with `DIRECT_URL` before deploying a new migration.

Not yet verified on a real deployment: Prisma engine bundling under pnpm
(`includeFiles` in `vercel.json`) and that rewrites preserve the original path for cron routes.
