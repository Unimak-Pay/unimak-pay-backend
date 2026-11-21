# Portal events: contract and plan

Status: **built** (2026-11-21); the status lists in A4 still need confirming with the portal team. Part A is the
contract for the portal team. Part B is how the UNIMAK Pay backend implements it.

The university portal stays the source of truth for students and applicants. It tells us when a record is created or
changes, so we hold a complete, current roster. That lets us bill everyone as soon as a fee is active, show "who hasn't
paid" by department and level, and keep USSD and the dot working when the portal is down. Lookups read our store first
and only call the portal for someone we've never heard of.

---

## Part A: Contract (for the portal team)

### A1. Endpoint

```
POST https://unimak-pay-backend.vercel.app/v1/portal/events
Content-Type: application/json
X-Portal-Timestamp: 1795262400
X-Portal-Signature: v1=5f2b…(64 hex chars)
```

Every call carries a **batch of 1–500 events**. A single change is a batch of one.

### A2. Signing

- `X-Portal-Timestamp`: the current time in unix seconds. We reject requests more than **300 seconds** from our clock.
- `X-Portal-Signature`: `v1=` followed by the lowercase hex of `HMAC-SHA256(secret, "<X-Portal-Timestamp>.<raw request body>")`.
  Sign the exact bytes you send.
- The secret is at least 32 random characters. We exchange it out of band, never by email or chat.
- **Rotation:** we accept the current and the previous secret at the same time, so either side can switch without
  downtime.

Node example:

```js
const ts = Math.floor(Date.now() / 1000).toString();
const body = JSON.stringify({ events });
const sig = 'v1=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
```

### A3. Body

```json
{
  "events": [
    {
      "id": "evt_01JD7R2K9V8Q3M",
      "type": "student.upserted",
      "occurredAt": "2026-11-21T09:15:02Z",
      "data": { "...": "the full current record, see A4" }
    }
  ]
}
```

| Field | Rules |
|---|---|
| `id` | Unique per event, 1–100 characters (`A-Z a-z 0-9 _ - . :`). **Reuse the same id when you retry**: that's how we avoid applying an event twice. |
| `type` | `applicant.upserted` or `student.upserted`. |
| `occurredAt` | ISO 8601 time of the change in the portal. |
| `data` | The **full current record**, not just the fields that changed. |

**Why full records instead of separate "created", "updated" and "status changed" events:** each event is enough by
itself. A missed or out-of-order event fixes itself on the next one, and the backfill and yearly level changes use the
same message.

### A4. Records

**Applicant** (`applicant.upserted`):

```json
{
  "applicationRef": "APP-2026-0001",
  "fullName": "Aminata Kamara",
  "phone": "+23276100001",
  "programCode": "BSC-CS",
  "department": "COMPUTER-SCI",
  "intake": "2026-SEP",
  "residency": "LOCAL",
  "status": "APPLIED",
  "updatedAt": "2026-11-21T09:15:02.123Z"
}
```

**Student** (`student.upserted`):

```json
{
  "studentId": "UNI-2026-0001",
  "applicationRef": "APP-2026-0001",
  "fullName": "Abdul Koroma",
  "phone": "+23276200001",
  "programCode": "BSC-CS",
  "department": "COMPUTER-SCI",
  "level": 1,
  "finalYear": false,
  "residency": "LOCAL",
  "intake": "2026-SEP",
  "enrolmentStatus": "ACTIVE",
  "updatedAt": "2026-11-21T09:15:02.123Z"
}
```

| Field | Rules |
|---|---|
| `applicationRef` / `studentId` | The portal's identifier. It never changes once issued. |
| `applicationRef` (on a student) | The application this student came from, or `null`. It links the applicant's payments to the student. |
| `fullName` | As on the portal record. |
| `phone` | International format, `+232…`. |
| `department` | The portal's department code. We accept codes we don't know yet and flag them for an admin to place in a faculty, so never hold an event back because of the department. |
| `level` | 1–10. |
| `residency` | `LOCAL` or `INTERNATIONAL`. |
| `status` (applicant) | `APPLIED`, `ADMITTED`, `REJECTED` or `WITHDRAWN`. **To confirm** against the portal's own list. |
| `enrolmentStatus` (student) | `ACTIVE`, `SUSPENDED`, `WITHDRAWN` or `GRADUATED`. **To confirm** against the portal's own list. |
| `updatedAt` | When the portal record last changed, with milliseconds. It must increase on every change. We use it to ignore older versions that arrive late. |

### A5. Responses

**200** means the batch was received. Each event has its own result, in the order sent:

```json
{
  "results": [
    { "id": "evt_01JD7R2K9V8Q3M", "result": "APPLIED" },
    { "id": "evt_01JD7R2K9V8Q3N", "result": "DUPLICATE" },
    { "id": "evt_01JD7R2K9V8Q3P", "result": "STALE" },
    { "id": "evt_01JD7R2K9V8Q3Q", "result": "REJECTED", "error": { "code": "VALIDATION", "message": "level must be 1-10" } }
  ]
}
```

| Result | Meaning | What the portal does |
|---|---|---|
| `APPLIED` | Stored. | Nothing. |
| `DUPLICATE` | We already have this event `id`. | Nothing. |
| `STALE` | We hold a newer version of this record (by `updatedAt`). | Nothing. |
| `REJECTED` | The record is invalid. | Fix it and send it again as a **new** event `id`. Don't retry unchanged. |

Errors for the whole request:

| Status | Cause | Retry? |
|---|---|---|
| 400 | The body isn't valid JSON or isn't `{ events: [...] }`, holds 0 or more than 500 events, or an event `id` is missing, malformed or repeated within the batch. | No, fix the request. |
| 503 | We haven't set up the shared secret yet. | Yes, later. |
| 401 | Missing or bad signature, or a timestamp outside 300 seconds. | No, check the secret and clock. |
| 413 | Body over 1 MB (500 typical records are about 250 KB). | No, send smaller batches. |
| 429, 5xx, timeout (we answer within 30 s) | Our side. | **Yes**, the same batch with the same event ids. |

**Retries:** after 1 min, 5 min, 30 min, 2 h and 12 h, then alert someone on the portal side. Retrying is always safe:
duplicates are ignored and older versions are skipped. Sending in order isn't required.

### A6. When to send

| Moment | Event |
|---|---|
| Someone applies | `applicant.upserted` |
| An application is admitted or rejected, or its details change | `applicant.upserted` |
| A student is registered | `student.upserted`, with `applicationRef` set |
| Department transfer, level change, residency, phone or name change | `student.upserted` |
| Suspension, withdrawal, graduation, reinstatement | `student.upserted` with the new `enrolmentStatus` |
| **Start of the academic year**, when levels move up | `student.upserted` for every student whose level changed, in batches |

### A7. Backfill (once, before go-live)

Send **every current applicant and student** through the same endpoint, in batches of 500, as `*.upserted` events. Use
ids such as `backfill-2026-11-<ref>` so a re-run is ignored. A thousand students takes 2 calls.

### A8. Checking we agree (optional, recommended each term)

`GET /v1/portal/summary`, signed the same way with an empty body. It returns our counts so the portal can compare them
with its own and resend any department or level that differs:

```json
{
  "asOf": "2026-11-21T10:00:00Z",
  "applicants": [ { "department": "COMPUTER-SCI", "status": "APPLIED", "count": 41 } ],
  "students": [ { "department": "COMPUTER-SCI", "level": 1, "enrolmentStatus": "ACTIVE", "count": 212 } ],
  "lastEventAt": "2026-11-21T09:15:02Z"
}
```

### A9. Testing

We give the portal team a staging URL and a test secret. In staging they can send anything; nothing is billed for real.

---

## Part B: Our implementation plan

### B1. What the backend does with an event

1. **Verify** the signature and timestamp, and validate the batch shape. Reject the whole request with 400 or 401
   otherwise.
2. For each event, in its own transaction:
   - Record it in a `PortalEvent` table by `id`. If the id is already there, return `DUPLICATE`.
   - Validate the record. If it's invalid, return `REJECTED` with the reason; the event is kept for debugging.
   - If we hold a version of that record with an equal or newer `updatedAt`, return `STALE`.
   - Otherwise upsert the payer record and its `portalUpdatedAt`, and link the student to their application.
   - Register an unknown department as needs-review, as happens today.
   - **Create missing obligations** for active fees, using the same rules as lookups. Students who aren't `ACTIVE` get
     no new obligations.
3. A student who becomes `SUSPENDED`, `WITHDRAWN` or `GRADUATED` keeps their charges. Their open obligations appear in
   a **Needs review** list on the dashboard; nothing is deleted or written off automatically.
4. A department or level change affects **new** obligations at once. Existing untouched ones move only when an admin
   runs **re-price** on the fee. We don't re-price automatically, so a student's bill never changes without an admin
   seeing it.

### B2. Lookups (USSD, dot, channel API)

- **Found in our store:** use it, with no portal call.
- **Not found:** fetch it from the portal as today, store it and create its obligations. The portal is still the source
  of truth for anyone we've never heard of.
- **Found but not updated for 30 days:** refresh it from the portal before answering (once a month per student at
  most). If the portal is down or no longer has the record, answer from the store.
- If the portal is down, someone we already hold can still pay. Someone we've never seen gets the same "try again later"
  answer as today.

### B3. Steps (one commit each, with tests)

1. **Schema.**
   - The payer record gains `enrolmentStatus`, `applicationRef` (link), `portalUpdatedAt` and `lastSyncedAt`.
   - New `PortalEvent` table: id, type, received time, result, error and the raw record. Events are kept 90 days, then
     purged by the existing cron.
2. **Endpoint.**
   - `POST /v1/portal/events`, with the signature guard and two-secret rotation.
   - New env variables: `PORTAL_EVENTS_SECRET`, `PORTAL_EVENTS_SECRET_PREVIOUS`.
   - Batch validation, per-event results, idempotency and the stale check.
3. **Obligations on event.** Reuse the lazy-lookup planner, skipping students who aren't `ACTIVE`.
4. **Store-first lookups** with the 30-day background refresh.
5. **Admin.**
   - A read-only event log (`portal.read`), with filters for type, result and ref.
   - The "Needs review" list of non-active students with open obligations.
   - The time of the last event, on the dashboard.
6. **`GET /v1/portal/summary`** for the termly check.
7. **Docs, OpenAPI, a dev command** to send signed test events, and a dashboard prompt.

**Analytics** (the department × level grid, overdue list, student list and student detail) come next, as a separate
plan, once the roster is complete.

### B4. Decisions (owner, 2026-11-21)

1. Status lists as in A4, still to be confirmed with the portal team.
2. **Applicants** get their obligations (e.g. the application fee) as soon as the event arrives.
3. A **suspended, withdrawn or graduated** student gets no new charges; what they already owe stays payable and is
   listed for review.
4. Raw events are kept **90 days**, then purged by the cleanup cron (`/cron/expire-payments`).

### B5. Where it lives

| Piece | Where |
|---|---|
| Endpoint, signature guard, summary | `src/modules/portal-api/` |
| Applying events | `src/modules/payers/application/apply-portal-events.use-case.ts`, parser in `payers/domain/portal-event.ts` |
| Obligations (events and lookups) | `src/modules/payers/application/obligation-sync.ts` |
| Store-first lookups | `src/modules/payers/application/lookup-payer.use-case.ts` |
| Admin: event log, needs review | `GET /v1/admin/portal-events` (`portal.read`), `GET /v1/admin/payers/needs-review` (`payers.read`) |
| Local testing | `pnpm portal:event POST /v1/portal/events @batch.json` (signs with `PORTAL_EVENTS_SECRET`) |
