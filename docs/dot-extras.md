# Dot extras: payment history, receipts, pay requests, exam clearance

Status: **built** (2026-11-26). Owner decisions are in "Decisions" at the end; they override the plan text above where they differ. Contract: the dot repo's
`docs/backend-api-additions.md` and `lib/types.ts` ("Endpoints the backend is adding").

## Principles

- **Everything is derived from Payment rows that Monime confirmed.** History, receipts, a request's contributions and
  `paid`, and clearance all read `Payment.status = COMPLETED` (set only by `SettlePaymentService`, from the webhook or
  the reconcile check). Nothing is "added" on completion, so there is no second write path to get wrong, and nothing the
  dot sends can mark money as paid.
- Existing routes keep their behaviour. `POST /v1/dot/payments` gains optional fields only.
- All new routes sit on `DotController` (or a sibling under `v1/dot` with the same `DotRateLimitGuard`), so they share
  the per-IP limit, the `{ error: { code, message } }` shape and `Retry-After` on 429.
- No phone numbers anywhere in these responses.

## Schema (one migration)

```prisma
model PayRequest {
  id             String   @id @default(uuid()) @db.Uuid
  /// 7 chars from the receipt alphabet (no 0/O/1/I/L), unique
  code           String   @unique
  payerId        String   @db.Uuid
  obligationId   String   @db.Uuid
  /// null = "whatever you can"
  amount         BigInt?
  message        String   // ≤ 280
  recipientName  String?  // ≤ 60
  /// stored only for CANCELLED (no cancel route yet); the rest is derived
  cancelledAt    DateTime?
  openedAt       DateTime?
  idempotencyKey String   @unique
  /// hash of the create body, to detect a reused key with a different request
  requestHash    String
  createdAt      DateTime @default(now())
  expiresAt      DateTime
  payments       Payment[]
  @@index([payerId, createdAt])
}

model Payment {
  // …existing…
  /// the pay request this payment was made through (set at creation, from payRequestCode)
  payRequestId   String?  @db.Uuid
  /// first name the paying person gave (display only, never trusted for anything)
  paidByName     String?
  /// how Monime says it was paid, from the completed-payment webhook (see open question 4)
  monimeMethod   String?
}

model ClearancePolicy { … }   // shape depends on the rule (open question 1)
model ClearancePass {
  id        String   @id @default(uuid()) @db.Uuid
  /// 8 chars from the receipt alphabet, unique
  code      String   @unique
  payerId   String   @db.Uuid
  policyId  String   @db.Uuid
  issuedAt  DateTime @default(now())
  @@unique([payerId, policyId])
}
```

New env: `DOT_LINK` (default `https://dashit.to/d/k6X5mJ6TFSnLUm8KwUjqWu4Mcf5`), `ACADEMIC_YEAR_START_MONTH`
(default 9).

## Endpoints

### 1. `GET /v1/dot/payers/{kind}/{ref}/payments`

- The payer must already be in our store (or is looked up the same way as `GET /v1/dot/payers/…`); 404 otherwise.
- All payments on the payer's obligations, newest first: every COMPLETED, INITIATED and PENDING one (open payments past
  expiry read EXPIRED, as elsewhere), plus FAILED and EXPIRED ones created in the last 30 days.
- `totalPaid`: COMPLETED payments whose `completedAt` falls in the current academic year (1 September to 31 August,
  `ACADEMIC_YEAR_START_MONTH`). `academicYear` is that year as `2026/27`.
- `paidBy`: `{ name: paidByName, self }`, where `self` is true when the payment wasn't made through a pay request and
  either the dot said so or the paying number matches the payer's phone (open question 3).
- `method`: from `monimeMethod`; null when unknown. USSD payments made with a payment code are "Mobile money" if Monime
  doesn't say more.
- `receiptNumber`: only when COMPLETED.

### 2. `GET /v1/dot/payments/{paymentRef}/receipt`

- 404 unless the payment exists **and** is COMPLETED with a receipt.
- `payer`: kind, ref, full name, programme line (the same as the lookup already shows). `verifyUrl`:
  `${PUBLIC_BASE_URL}/r/{verifyCode}`, the existing page. Existing verify codes are 10 characters, which keeps the URL
  about 55 characters and easy to scan. I'd keep them rather than shorten codes for new receipts.
- `pdfUrl`: **null for now** (recommended). A PDF needs a PDF library, a new dependency. The dot already falls back to
  an image.

### 3. Pay requests

`POST /v1/dot/pay-requests` (`Idempotency-Key` header, same pattern and rules as payments):
- body as in the contract; `kind` + `ref` must be the obligation's payer (404 otherwise);
- `amount`: null, or ≥ 1 and ≤ the obligation's current `payable`, otherwise 422 `AMOUNT_EXCEEDS_PAYABLE`; a settled
  obligation → 409 `OBLIGATION_SETTLED`;
- `message` 1–280 characters, `recipientName` ≤ 60, both trimmed;
- `expiresAt`: 30 days, end of that day UTC (or the fee's due date if sooner? see below);
- same key and same body → the same request (201); same key, different body → 409 `IDEMPOTENCY_CONFLICT`;
- at most 20 open requests per payer (422 `VALIDATION`), so one ID can't be used to spam links.

`GET /v1/dot/pay-requests/{code}`: sets `openedAt` the first time (one conditional UPDATE), returns the PayRequest.
`GET /v1/dot/payers/{kind}/{ref}/pay-requests`: `{ requests }`, newest first.

PayRequest, as in the contract:
- `shareUrl` = `${DOT_LINK}/sponsor?request=…&kind=…&ref=…&fee=<obligationId>&amount=<minor units or empty>`, those
  five options only, URL-encoded;
- `requester` = kind, ref, **first name** and programme line only;
- `contributions` = its COMPLETED payments (paymentRef, `paidByName`, amount, `completedAt`);
- `status`, derived when read: CANCELLED if cancelled; PAID if `amount` is set and `paid ≥ amount`, or the obligation
  is paid off; EXPIRED if past `expiresAt`; PARTLY_PAID if anything was paid; otherwise OPEN.

**Where `payRequestCode` is recorded:** `POST /v1/dot/payments` takes optional `payRequestCode` (and `paidByName`, open
question 3). When present, the request must exist, be OPEN or PARTLY_PAID, not expired, and be for the same
obligation (otherwise 404 or 409 `INVALID_STATE`). Its id is written to `Payment.payRequestId` in the same transaction
that creates the payment. An idempotent replay must carry the same code. The payment counts towards the request only
once Monime completes it. The order's metadata gains `payRequestCode`, for Monime's dashboard.

### 4. `GET /v1/dot/payers/{kind}/{ref}/clearance`

- Evaluated live from the payer's obligations and the **current clearance policy**, which the finance office edits in
  the admin API (`PUT /v1/admin/clearance-policy`, a new permission `clearance.manage` for bursar and super admin;
  audited). The rule itself is open question 1.
- NOT_CLEARED: `outstanding` = what must be paid to be cleared; `blocking` = those obligations with their balances.
- CLEARED: a `ClearancePass` is created once per payer and policy (8-character code). `verifyUrl` =
  `${PUBLIC_BASE_URL}/c/{passCode}`.
- **`/c/{passCode}`**: a public HTML page like `/r/…`, `no-store`. It **re-evaluates the policy now** and shows a large
  "✓ Cleared for First semester exams 2026/27" or "✗ Not cleared", the full name, student ID, programme and the time
  checked. A screenshot of the pass therefore proves nothing once the status changes: the scan always shows the live
  answer. No phone, no amounts.
- Applicants: 404 (exams are for students).

## OpenAPI

- Tag "Dash dot": the 6 new routes, the two new optional fields on `POST /v1/dot/payments`, and the schemas
  PaymentHistory, PaymentRecord, DotReceipt, PayRequest, Clearance.
- Fix the dot's Payer schema: fullName, maskedPhone, programCode, programLine, department, departmentName, facultyCode,
  facultyName, level, finalYear, residency, intake, applicantStatus, stale (no maskedName).
- Admin: the clearance policy routes.

## Tests

- Unit: request status derivation, share URL building, academic-year window, clearance rule evaluation, code
  generators.
- e2e (`test/e2e/dot-extras.e2e-spec.ts`, own refs and fee type):
  - history: pending, completed via the simulated webhook, failed, expired older than 30 days left out, no phones in the
    body, `totalPaid` only for this academic year;
  - receipt: 404 while pending, 200 after the webhook, verifyUrl resolves to the existing page;
  - pay requests: create, idempotent replay, conflict, 422 above payable, open sets `openedAt` once, a payment with
    `payRequestCode` counts only after completion, PARTLY_PAID then PAID, wrong obligation rejected, expired request
    rejected;
  - payments without the new fields behave exactly as before (the existing dot tests stay unchanged);
  - clearance: NOT_CLEARED with blocking, CLEARED after paying, the `/c/` page shows "Not cleared" after the policy
    changes;
  - 429 with `Retry-After` on a new route.
- The contract test covers every new operation.

## Commits

1. Schema, migration, env.
2. Pay requests (create, read, list) and `payRequestCode` on payments.
3. History and receipt.
4. Clearance policy (admin), clearance endpoint, `/c/` page.
5. OpenAPI (with the Payer fix), README, architecture spec.

## Open questions

1. **Clearance rule.** What does the finance office count as cleared? (See the chat for the options.)
2. **History and receipts by ID alone.** See the recommendation in the chat.
3. **Where `paidBy.name` comes from.** Monime's webhook doesn't carry a name (we only read the masked number), so the
   dot has to send it. That needs an optional `paidByName` on `POST /v1/dot/payments`: a contract addition.
4. **`method`.** Which field of Monime's Payment object says how it was paid (for example under `channel`)? Today we
   only read `channel.phoneNumber`.

## Decisions (owner, 2026-11-26)

1. **X-User-Alias** (contract section 0): phones compared on the national number, emails case-insensitively against the
   payer's email (from the portal since 2026-11-27; until it sends one, an email alias can't match). A match is required for the full lookup, history, a payer's pay-request list,
   creating a request and clearance; mismatch → 403 `ALIAS_MISMATCH` with a student-facing message. Missing header:
   the lookup keeps today's behaviour unless `DOT_ALIAS_REQUIRED=true`; the new private routes answer 403
   `ALIAS_REQUIRED` (published dots don't call them). Without a match the lookup returns
   `{ kind, ref, shortName, limited: true, stale }` + obligations. Failed matches: `DOT_ALIAS_FAILURES_PER_HOUR` per IP
   and per ID; over it the lookup answers short without checking and private routes answer 429.
2. **Clearance rule:** still to come from the finance office. The stored rule says "every fee of the listed types in the
   period, plus any fee past its due date, must be zero balance"; seeded as `First semester exams`, `2026/27`,
   `[TUITION]`, overdue on, `placeholder: true`.
3. **History and request lists** ship with names, behind the alias match (Dash sign-in tokens can't be verified by a
   server).
4. **`paidByName`** (first word only, ≤ 40, display only) and **`payingForSelf`** (default false) on
   `POST /v1/dot/payments`. No phone matching.
5. **`method`** from Monime's Payment `channel.type`: momo → Mobile money, card → Card, bank → Bank, wallet → Wallet;
   otherwise null. Provider ids aren't mapped.
6. **Academic year** from the obligations' periods (latest `YYYY/YY`); `totalPaid` = COMPLETED payments on
   obligations in that period. Requests expire after 30 days or on the fee's due date, never less than 3 days.
