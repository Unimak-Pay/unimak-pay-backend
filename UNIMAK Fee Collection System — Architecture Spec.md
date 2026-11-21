# UNIMAK Fee Collection System — Architecture Spec

Nov 10, 2026 · @Mohamed James

## Overview

One NestJS backend owns every UNIMAK fee rule, balance and receipt. The admin portal, the Monime USSD flow and the Dash Dots mini-app are thin clients on top of its API. The UNIMAK portal stays the system of record for applicants and students. This system stays the system of record for money.

**Seed fees** (the admin can add more later without code changes):

| Fee | Who owes it | Instalments | Amount varies by |
| --- | --- | --- | --- |
| Application fee | New-intake applicants (application ref). Mandatory before admission, paid once whatever the outcome | No | Intake, possibly program |
| Matriculation fee | Newly admitted students, once | No | Intake, residency |
| Tuition (yearly) | Enrolled students, per academic year | Yes, with a minimum per payment that varies by program | Program × level × residency |
| Departmental fee | Students of a department, per year | Admin's choice per fee | Department, level |
| Graduation fee | Final-year students, once | Admin's choice | Residency |

**Channels:** admin portal (Vite + React), USSD (runs on Monime's USSD platform), Dash Dots (runs inside Monime's Dash app). USSD and Dots only call the public channel API.

**Money:** every amount is in SLE. Monime converts card payments to SLE before they reach us, so there is no currency field. Each service (fee type) settles into its own Monime financial account. UNIMAK absorbs a 2.5% transaction fee, deducted from what it receives; payers pay only the fee amount. How the 2.5% splits between Monime and the platform depends on the channel (see Payment lifecycle).

**Out of scope:** academic clearance and exam eligibility. Management handles those by hand, using the exported reports.

## Architecture

The backend is a single NestJS app, deployed as one Vercel function, built hexagonally: one module per domain, with ports for the portal, Monime and SMS. It can be split into services later without touching the domain code.

&#91;embedded content: system architecture · 3 channels, 1 backend, 3 dependencies\]

The USSD flow and Dots run on Monime's infrastructure and reach the backend only through the signed channel API. The portal remains the record for people; the backend's Postgres is the record for money.

| Module | Owns |
| --- | --- |
| Catalog | Fee types, fees, rate rules, eligibility |
| Payers | Portal lookups, snapshots, lazy obligation creation |
| Ledger | Obligations, entries, balances, adjustments |
| Payments | Quote, initiate, holds, Monime client, webhook settlement, expiry |
| Receipts | Numbering, verification codes, PDF, SMS template |
| Outbox | Portal notify, SMS, retries, cron sweeps |
| Integrations | Adapters: `PortalClient`, `MonimeClient`, `SmsSender` behind interfaces |

## Domain model

The core idea: a **fee** says what is charged and to whom, a **rate rule** says how much, and an **obligation** is one payer owing one fee. Every movement of money is a **ledger entry** against an obligation, and balances are always derived from the ledger.

**Fee catalog**

- `FeeType`: a code (`APP`, `MATRIC`, `TUITION`, `DEPT`, `GRAD`, or custom), a name, a payer kind (applicant or student), a recurrence (once, or per academic year) and its own Monime settlement account, so every service settles separately.
- `Fee`: one fee type in one academic year or intake. It holds whether instalments are allowed, a default minimum instalment, the due date and a status (draft, active, closed).
- `RateRule`: matches on any of program, department, level, residency (local or international) and intake, then gives an amount. The most specific match wins, and ties are rejected when the admin saves. Example: Tuition 2026/27, BSc Nursing, Year 2, International = SLE X.
- `EligibilityRule`: who owes the fee, e.g. new intake 2026, level = final year, department = Mass Comm. It uses the same attributes as rate rules.

**Minimum instalment per department, optionally per level** (owner decisions, 2026-11-20). An `InstalmentRule` (fee × department × optional level → minimum amount) overrides the fee's default minimum. A student's own level rule wins over the department's all-levels rule; applicants (no level) get the all-levels rule. Only users with the `instalments.manage` permission can change it, and every change is written to the audit log.

**Application fee rule.** The application fee is payable once per application ref, before admission, and it stands whatever the admission outcome. Once it's paid, every channel shows it as Paid and refuses a second payment. Our notify call is what tells the portal it can process the application.

**Roster from portal events** (owner decision, 2026-11-21; contract in `docs/portal-events.md`). The portal pushes every student and applicant change to `POST /v1/portal/events`; we store the record and create its obligations at once, so billing and "who hasn't paid" cover everyone, not only those who have looked themselves up. Lookups read our store first and only ask the portal about someone we've never seen (or a record not refreshed for 30 days). Students the portal marks SUSPENDED, WITHDRAWN or GRADUATED get no new charges; what they owe stays payable and is listed for review.

**Obligations, created lazily** (still the fallback for anyone the events missed). When a payer is looked up on any channel, the backend:

1. Fetches the student or applicant from the portal API (cached for 10 minutes).
2. Finds every active fee whose eligibility matches them.
3. Creates any missing obligation, copying in the amount from the best-matching rate rule, keyed on (payer, fee).

Editing a rate rule doesn't change obligations already created. **Re-pricing** (owner decision, 2026-11-20) moves them: an admin with `fees.manage` previews and applies it per fee. Only untouched obligations move (OPEN, no payment or refund, no payment in progress); each change is an ADJUSTMENT ledger entry for the difference plus the new amount on the obligation, audited as `fee.reprice`. The rest are listed with a reason for a person to decide.

The admin can also pre-generate obligations for a cohort through the portal's cohort batch endpoint, so dashboards show who hasn't paid yet.

**Ledger.** Each `LedgerEntry` is a charge (+), a payment (−), an adjustment (±: waiver, scholarship, correction) or a refund (+). For any obligation, balance = sum of entries. Status comes from the balance: unpaid, partial, paid or overpaid. Entries are never edited; a mistake is fixed with a reversing entry.

**Payment.** One attempt through Monime. Statuses: `initiated → pending → completed | failed | expired`. Only a completed payment writes a ledger entry. While a payment is pending, its amount counts as a hold, so the payable amount is balance minus holds.

**Receipt.** Issued once per completed payment. The number looks like `UNIMAK-2026-000123`, and each receipt has a public verification code with a URL and QR.

**Payer snapshot.** A cached copy of the portal record (ID, name, program, department, level, residency, phone), updated on every lookup. It keeps reports working when the portal is down.

## Database schema

This is a Prisma starting point on Supabase Postgres. Money is stored as `BigInt` in the smallest SLE unit, and every write path is idempotent through unique keys.

```prisma
// All money: BigInt, smallest SLE unit. SLE only (Monime converts card payments).
enum PayerKind { APPLICANT STUDENT }
enum Residency { LOCAL INTERNATIONAL }
enum Recurrence { ONCE PER_YEAR }
enum FeeStatus { DRAFT ACTIVE CLOSED }
enum EntryKind { CHARGE PAYMENT ADJUSTMENT REFUND }
enum PaymentStatus { INITIATED PENDING COMPLETED FAILED EXPIRED }
enum Channel { USSD DOTS ADMIN }
enum OutboxStatus { PENDING SENT FAILED DEAD }

model FeeType {
  id                String     @id @default(uuid())
  code              String     @unique          // APP, MATRIC, TUITION, DEPT, GRAD, ...
  name              String
  payerKind         PayerKind
  recurrence        Recurrence
  settlementAccount String     // Monime financial account, one per service
  fees              Fee[]
}

model Fee {
  id                   String     @id @default(uuid())
  feeTypeId            String
  academicYear         String?    // "2026/27"
  intake               String?    // "2026-SEP" (application / matric)
  name                 String
  allowInstalments     Boolean    @default(false)
  defaultMinInstalment BigInt?
  dueDate              DateTime?
  status               FeeStatus  @default(DRAFT)
  feeType              FeeType    @relation(fields: [feeTypeId], references: [id])
  rateRules            RateRule[]
  instalmentRules      InstalmentRule[]
  eligibility          EligibilityRule[]
  obligations          Obligation[]
  @@unique([feeTypeId, academicYear, intake])
}

model RateRule {
  id          String     @id @default(uuid())
  feeId       String
  programCode String?
  department  String?
  level       Int?
  residency   Residency?
  intake      String?
  amount      BigInt
  specificity Int        // count of non-null matchers, computed on save
  fee         Fee        @relation(fields: [feeId], references: [id])
}

model InstalmentRule {
  id          String   @id @default(uuid())
  feeId       String
  programCode String
  minAmount   BigInt
  updatedBy   String   // admin user id (instalments.manage)
  updatedAt   DateTime @updatedAt
  fee         Fee      @relation(fields: [feeId], references: [id])
  @@unique([feeId, programCode])
}

model EligibilityRule {
  id          String     @id @default(uuid())
  feeId       String
  programCode String?
  department  String?
  level       Int?
  finalYear   Boolean?
  residency   Residency?
  intake      String?
  fee         Fee        @relation(fields: [feeId], references: [id])
}

model Payer {
  id          String     @id @default(uuid())
  kind        PayerKind
  externalRef String     // student id or application ref from the portal
  fullName    String
  programCode String?
  department  String?
  level       Int?
  finalYear   Boolean?
  residency   Residency?
  intake      String?
  phone       String?
  syncedAt    DateTime
  obligations Obligation[]
  @@unique([kind, externalRef])
}

model Obligation {
  id          String        @id @default(uuid())
  payerId     String
  feeId       String
  amount      BigInt        // snapshot at creation
  rateRuleId  String?
  createdAt   DateTime      @default(now())
  payer       Payer         @relation(fields: [payerId], references: [id])
  fee         Fee           @relation(fields: [feeId], references: [id])
  entries     LedgerEntry[]
  payments    Payment[]
  @@unique([payerId, feeId])
}

model LedgerEntry {
  id           String     @id @default(uuid())
  obligationId String
  kind         EntryKind
  amount       BigInt     // signed: + increases balance, - reduces
  paymentId    String?    @unique
  reason       String?
  actorId      String?    // admin user for adjustments
  createdAt    DateTime   @default(now())
  obligation   Obligation @relation(fields: [obligationId], references: [id])
}

model Payment {
  id              String        @id @default(uuid())
  obligationId    String
  amount          BigInt        // amount credited to the obligation
  status          PaymentStatus @default(INITIATED)
  channel         Channel
  payerPhone      String
  monimeRef       String?       @unique   // Monime payment / payment-code id
  settlementAcct  String        // copied from FeeType at initiate
  pricingId       String?       // PricingConfig in force at settlement
  monimeFee       BigInt?       // USSD 1%, Dots SLE 0.50 flat
  platformFee     BigInt?       // 2.5% total − monimeFee, never below 0
  netAmount       BigInt?       // what the service account receives
  commissionRef   String?       @unique   // Monime split / transfer id for the platform commission
  idempotencyKey  String        @unique
  expiresAt       DateTime
  completedAt     DateTime?
  obligation      Obligation    @relation(fields: [obligationId], references: [id])
  receipt         Receipt?
}

model PricingConfig {
  id             String   @id @default(uuid())
  channel        Channel  // USSD or DOTS
  totalFeeBps    Int      // 250 = 2.5%, deducted from UNIMAK
  monimeFeeBps   Int?     // USSD: 100 = 1%
  monimeFlatFee  BigInt?  // DOTS: 50 = SLE 0.50 in minor units
  // platform fee is derived: total fee − Monime fee
  bearer         String   @default("UNIVERSITY") // payer is charged nothing
  platformAccount String  // platform's Monime account that receives the commission
  effectiveFrom  DateTime
}

model Receipt {
  id         String   @id @default(uuid())
  number     String   @unique   // UNIMAK-2026-000123
  verifyCode String   @unique   // short public code for URL / QR
  paymentId  String   @unique
  issuedAt   DateTime @default(now())
  payment    Payment  @relation(fields: [paymentId], references: [id])
}

model WebhookEvent {
  id         String   @id          // Monime event id = dedupe key
  type       String
  payload    Json
  receivedAt DateTime @default(now())
  processed  Boolean  @default(false)
}

model OutboxMessage {
  id          String       @id @default(uuid())
  topic       String       // portal.application_paid, sms.receipt, monime.commission_transfer, ...
  payload     Json
  status      OutboxStatus @default(PENDING)
  attempts    Int          @default(0)
  nextAttempt DateTime     @default(now())
  lastError   String?
}

model AdminUser { id String @id @default(uuid()) email String @unique role String permissions String[] departments String[] }
model AuditLog  { id String @id @default(uuid()) actorId String action String entity String entityId String before Json? after Json? at DateTime @default(now()) }
```

The `@@unique([payerId, feeId])` on `Obligation` is what makes lazy creation safe under concurrent lookups: use `upsert`, or insert and catch the unique violation.

## Payment lifecycle

The Monime webhook is the only thing that marks a payment completed. Channel sessions only start payments; they never confirm them.

1. **Quote.** The channel sends payer + fee. The backend returns the balance, the holds, the payable amount and the minimum instalment.
2. **Initiate.** In one transaction: `SELECT … FOR UPDATE` on the obligation row, check that the program's minimum instalment ≤ amount ≤ balance − holds, insert a `Payment` (status `INITIATED`, `expiresAt` = now + 15 min, `idempotencyKey` from the channel), then call Monime to collect (a USSD push or payment code to `payerPhone`) and store `monimeRef`. The status becomes `PENDING`.
3. **Webhook.** `POST /webhooks/monime`: verify the signature, then insert a `WebhookEvent` keyed by the event id (a duplicate returns 200 and does nothing), then process.
4. **Settle.** In one transaction: payment → `COMPLETED`, insert a `LedgerEntry(PAYMENT, −amount, paymentId)` (unique on paymentId, so it is never applied twice), issue the `Receipt`, and write outbox messages (`sms.receipt`, plus `portal.application_paid` for application fees).
5. **Fail or expire.** A failed webhook, or the expiry sweep, sets `FAILED` / `EXPIRED`, which releases the hold.
6. **Notify the portal.** The outbox worker POSTs to the portal with an idempotency key (the payment id). It retries with backoff (1 min, 5 min, 30 min, 2 h, 12 h), and after 6 attempts moves the message to `DEAD`, which shows on the admin dashboard.
7. **Reconcile.** A nightly job lists the day's Monime transactions and compares them with completed payments. A mismatch, such as a missed webhook, is either auto-settled through the same step 4 or flagged.

**Transaction fees on every payment.** UNIMAK always gives up 2.5% of each payment, and the payer is charged nothing extra. The split depends on the channel the payment came through:

| Channel | Monime takes | Platform takes | UNIMAK receives on SLE 1,000 |
| --- | --- | --- | --- |
| USSD | 1% (SLE 10) | 1.5% (SLE 15) | SLE 975 |
| Dash Dots | SLE 0.50 flat | 2.5% − SLE 0.50 (SLE 24.50) | SLE 975 |

At settlement, the payment stores Monime's fee, the platform fee and the net amount, using the channel's `PricingConfig` in force at that moment. Rules:

- Calculate in minor units. Compute the 2.5% total first, then the platform fee = total − Monime fee, so the three figures always add up exactly.
- Round the 2.5% total half-up to the nearest minor unit.
- On Dots, a payment under SLE 20 makes 2.5% smaller than the SLE 0.50 flat fee. The platform fee is then 0, and UNIMAK bears Monime's SLE 0.50. Minimum instalments make this rare.
- The rates are stored per channel with an effective date, so a change to the rates is a config change, not a code change. Old payments keep the rates that applied when they were paid.

**Commission split.** The platform commission is split off at payment time into the platform's own Monime account, so it never sits in a UNIMAK account.

- Preferred: split at collection, if Monime's collection API supports multiple destinations. The net amount goes to the service's account, the commission to the platform account.
- Fallback: in the same settlement transaction, write an outbox message `monime.commission_transfer`. The worker then moves the commission from the service account to the platform account, using the payment id as the idempotency key.
- Either way, the Monime reference is stored on the payment (`commissionRef`). Nightly reconciliation checks that every completed payment has its commission transfer, and that the amounts match the stored breakdown.
- A refund reverses the commission too, by transferring it back from the platform account, unless agreed otherwise.

**Overpayment** can only happen through a race outside our control, such as a manual Monime transfer. It is recorded as status `overpaid` and resolved by an admin refund or by carrying it forward as a credit adjustment.

## API contracts

There are three API surfaces, each with its own auth. USSD and Dots share the channel API, so both behave identically.

**Channel API** (`/v1/channel`, server-to-server from Monime infrastructure, API key + HMAC signature, `X-Channel: ussd|dots`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/payers/{kind}/{ref}` | Look up a student or applicant, with a masked name and program line. Creates obligations lazily. |
| GET | `/payers/{kind}/{ref}/obligations` | Fees owed: amount, paid, balance, holds, payable, min instalment, due date |
| POST | `/payments` | Start a payment: `{obligationId, amount, payerPhone, idempotencyKey}` → `{paymentId, status, expiresAt}` |
| GET | `/payments/{id}` | Poll status (Dots shows a live state) |
| GET | `/payers/{kind}/{ref}/receipts?limit=` | Receipt history |
| POST | `/receipts/{number}/resend` | Re-send the receipt SMS to the payer's phone |

Dots-only: `GET/POST/DELETE /v1/channel/dots/saved-payers`, keyed by the Dash user id that Monime passes in. This is how a parent keeps several children's IDs saved.

**Public** (no auth, rate-limited)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/r/{verifyCode}` | Receipt verification page (HTML), for the QR |
| POST | `/webhooks/monime` | Monime payment events, signature-verified |

**Admin API** (`/v1/admin`, Supabase Auth JWT + role guard)

- Fees: CRUD for fee types, fees, rate rules and eligibility rules, plus `POST /fees/{id}/preview?ref=` to see what a given student would owe.
- Payers: search, view a full ledger, `POST /payers/{id}/adjustments` (waiver, scholarship, correction; a reason is required).
- Payments: list and filter, export CSV, `POST /payments/{id}/refund`.
- Cohorts: `POST /fees/{id}/generate`, which pre-creates obligations from the portal's cohort batch endpoint.
- Reports: collections by fee, faculty, department, day or channel; outstanding balances; aged receivables.
- Ops: outbox (view, retry dead messages), reconciliation results, audit log.

**Portal integration** (the portal's API, called by us)

- `GET {portal}/applicants/{applicationRef}` and `GET {portal}/students/{studentId}`. They must return program, department, level, residency and phone, and ideally a final-year flag and intake.
- `POST {portal}/payments/notify` with `{applicationRef|studentId, feeCode, amount, receiptNumber, paidAt, idempotencyKey}`.

* `GET {portal}/cohorts/students?intake=&program=&level=&page=`: the dedicated batch endpoint. It returns the same fields as a single lookup, paginated, and is used for cohort obligation generation and "who hasn't paid" reports.

## USSD flow

Four screens at most to start a payment, numeric input only, with each response under 2 seconds. The flow runs on Monime's USSD platform and calls the channel API at the marked steps.

```text
*XXX# → UNIMAK Payments
1. Pay a fee
   → 1. Student ID   2. Application No.
   → Enter ID ................................ [GET /payers]
   → "Aminata K. – BSc Nursing Yr 2. 1 Yes  2 No"
   → Fee list, e.g.                           [GET /obligations]
        1. Tuition 26/27  bal SLE 4,500
        2. Dept fee       bal SLE 300
   → if instalments: "Enter amount (min 500, max 4,500)"
     else: "Pay SLE 300? 1 Yes 2 No"
   → "You'll get a prompt to approve SLE 1,000."  [POST /payments]
     session ends; Monime collection prompt follows
   → SMS receipt when the webhook settles
2. Check balance
   → ID type → ID → list of fees with balances (session ends)
3. Resend last receipt
   → ID type → ID → "Receipt UNIMAK-2026-000123 sent by SMS"
0. Help → finance office phone number
```

- Paying for someone else works by default. The masked name confirms the right student, and the receipt SMS goes both to the paying phone and to the phone on the portal record.
- Wrong ID: allow 2 retries, then end the session with a short message.
- If the portal API is slow, use the payer snapshot when it is newer than 24 h, so the menu keeps working.
- Idempotency key = USSD session id + step, so a repeated submit doesn't create a second payment.

## Dash Dots mini-app

Dots does everything USSD does, plus saved students, visible progress and a receipt wallet. It uses the same channel API.

| Screen | What it shows | Key actions |
| --- | --- | --- |
| Home | Saved students as cards (name, program, total outstanding), and a banner for the nearest due date | Add student, open a student |
| Add student | Toggle between Student ID and Application No., then the masked-name confirmation | Save with a nickname ("Aminata") |
| Student | One card per fee, each with a progress ring (paid / amount), balance, due date and a badge (Paid, Partial, Unpaid) | Pay, view history |
| Pay | Amount chips (minimum, half, full balance) plus custom entry, validated against min and payable | Confirm with Dash wallet / Monime |
| Status | Live state (pending → completed), polling `/payments/{id}` every 3 s for up to 2 min | Done, view receipt |
| Receipts | A list per student; each receipt shows the number, fee, amount, date and QR | Share, download PDF |

**Look and feel:** UNIMAK colours over Dash's base components, and big numbers for the balance. When a fee reaches 100%, the ring fills and a short confetti burst plays. There are no empty states; a student with nothing due sees "All clear for 2026/27".

**Reminders** (phase 3): Dash push notifications 14 days and 3 days before a due date, for saved students with a balance.

## Admin portal

The admin portal is a Vite + React app on Vercel, signed in through Supabase Auth, with every action checked by role on the backend.

| Module | What it does |
| --- | --- |
| Dashboard | Collected today, this week and this year; split by fee, faculty, department and channel; outstanding total; failed outbox count |
| Fee setup | Fee types and their Monime settlement accounts, fees per year or intake, a rate-rule grid (program × level × residency), eligibility, minimum instalment per program; preview what a given student would owe |
| Payers | Search by ID or name; full ledger per obligation; receipts; adjustments with a required reason |
| Payments | A filterable list (fee, status, channel, date); CSV and Excel export; refunds |
| Reconciliation | Nightly Monime comparison results; settle or flag each mismatch |
| Reports | Outstanding by cohort, aged balances, department collections, graduation-fee payers (for the manual clearance process), transaction fees by channel (Monime vs platform commission) |
| Settings | Admin users, roles and permissions, transaction-fee rates, portal API credentials, SMS templates, audit log |

| Role | Can |
| --- | --- |
| Super admin | Everything, including users and settings |
| Bursar | Fee setup, adjustments, refunds, all reports |
| Finance officer | View payers and payments, resend receipts, export |
| Head of department | Read-only, limited to their department's fees and students |
| Auditor | Read-only everywhere, including the audit log |

**Payer analytics** (owner decisions, 2026-11-21; `docs/analytics.md`). Billed, collected and outstanding are computed live from obligations and the ledger, by department × level, down to the student list and one student's detail. Overdue = outstanding on a fee past its due date. Inactive students are left out of totals unless asked for (they're in Needs review). Lists and the CSV mask phones; only the detail page shows the full number. The CSV needs `payments.export` and is audited. Heads of department and deans only ever see their departments.

Roles are bundles of permissions, and a single permission can be granted on its own. For example, `instalments.manage` (set the minimum instalment per program) can go to a program's finance contact without giving them full fee setup.

## Running on Vercel

Vercel works if the backend is designed around two things: there are no long-running workers, and USSD has a tight time budget. Five rules cover it.

1. **One function, warm app.** Run NestJS through its Express adapter as a single serverless entry, and keep the bootstrapped app in a module-level variable so warm invocations reuse it. Keep the bundle small (no heavy SDKs on the channel path). Turn on Vercel's Fluid compute if your plan has it, to cut cold starts.
2. **Same region for everything.** Put the Vercel function region and the Supabase project in the same region, preferably the one closest to Monime's infrastructure. Every USSD hop crosses that link.
3. **Prisma through the pooler.** Point `DATABASE_URL` at Supabase's transaction pooler (port 6543, `?pgbouncer=true&connection_limit=1`), and use `DIRECT_URL` for migrations. Without the pooler, serverless bursts exhaust Postgres connections.
4. **Background work = outbox + cron.** After a webhook commits, try sending its outbox messages inline (best effort). A cron endpoint then sweeps whatever is left. Scheduled routes, all protected by a `CRON_SECRET`:
   - `/cron/outbox`, every minute: portal notifications and SMS retries
   - `/cron/expire-payments`, every 5 minutes: release stale holds
   - `/cron/reconcile`, nightly: compare with Monime Vercel Cron needs the Pro plan for per-minute schedules, and Hobby doesn't allow commercial use anyway. Supabase `pg_cron` + `pg_net` calling the same routes is a fallback.
5. **USSD time budget.** Portal calls on the USSD path get a 1.5 s timeout, then fall back to the snapshot. The Monime collection call is the last step before the session ends. Anything slow (SMS, portal notify) goes to the outbox, never inline.

Supabase is used for Postgres, Auth (admin users only) and Storage (receipt PDFs). Row Level Security stays on with no public policies: only the backend, using the service role, touches the data.

## Security, audit and edge cases

**Security**

- Channel API: an API key per channel plus an HMAC-signed body with a timestamp (±5 min). Reject anything unsigned.
- Webhooks: verify Monime's signature and dedupe on the event id.
- Lookups are rate-limited to stop people enumerating student IDs. Names shown (owner decisions, 2026-11-20): USSD shows first name + surname initial (`Aminata K.`); the dot lookup shows the full name with the phone masked; the channel API and payment status lookups return masked names (`A*** K***`).
- Admin: Supabase Auth with 2FA required for bursar and super admin. Every write produces an `AuditLog` row with before and after values.
- Ledger entries are append-only: no updates or deletes at the database level (revoke `UPDATE` and `DELETE` on the table).

**Edge cases**

| Case | Handling |
| --- | --- |
| USSD session drops after initiate | The payment stays `PENDING`; the webhook settles it and the SMS confirms it |
| Two people pay the same balance at once | Row lock + holds: the second is told the payable amount is smaller, or is refused |
| Webhook never arrives | Expiry sweep, then nightly reconciliation finds and settles it |
| Fee price changed mid-year | Existing obligations keep their snapshot amount; the admin applies a difference as an adjustment if management wants that |
| Student changes program or level | The next lookup refreshes the snapshot; new obligations use new rates; old ones are left as they are |
| No matching rate rule | The obligation isn't created; the payer is told to contact finance; the case shows in a dashboard alert |
| Portal API down | Use the snapshot if it is under 24 h old; otherwise the channel says "try again later" |
| Portal notify keeps failing | Retries with backoff → `DEAD` → dashboard alert with a manual retry |
| Refund | Admin initiates a Monime payout; a `REFUND` entry reopens the balance; audited |

## Build phases and open questions

Start with the application fee over USSD. It's the smallest end-to-end slice (one fee, no instalments, applicants only), and it exercises the portal integration both ways.

1. **Phase 0, foundations:** NestJS modules (catalog, payers, billing, payments, receipts, outbox, integrations), Prisma schema, Supabase, Vercel deploy, portal client, Monime client, webhook handler.
2. **Phase 1, application fee via USSD:** applicant lookup, quote, initiate, webhook settle, SMS receipt, portal notify. Minimal admin: payments list plus fee setup for application fees.
3. **Phase 2, all fees and instalments:** rate rules, eligibility, lazy obligations, holds, matriculation, tuition, departmental and graduation fees on USSD. Full fee setup UI, payer ledger, adjustments.
4. **Phase 3, Dash Dots:** saved students, progress cards, receipts wallet, live status, reminders.
5. **Phase 4, finance operations:** reconciliation, reports and exports, refunds, the receipt verification page, role scoping for heads of department.

**Open questions**

- [ ] USSD short code (to be decided later) and the Dash Dots listing.
