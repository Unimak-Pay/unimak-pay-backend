# Fee analytics: plan

Status: **proposed** (2026-11-21), waiting for the owner's OK. Follows `docs/portal-events.md`: once the portal backfill
has filled the roster, every student has their obligations, so "who owes what" can be answered from our own data.

## Goal

Answer, for bursary, deans and heads of department:

1. **How much is billed, collected and outstanding**, by department and level, for a fee or a whole period.
2. **Who hasn't paid**: unpaid, part-paid and overdue students, filterable and exportable.
3. **One student's full picture**: their record, every obligation with its balance, ledger, payments and receipts.

## Definitions

| Term | Meaning |
|---|---|
| Billed | Sum of CHARGE and ADJUSTMENT ledger entries (what the student owes after re-pricing). |
| Collected | Minus the sum of PAYMENT entries, net of REFUNDs. |
| Balance | `SUM(ledger)`, as everywhere else. Outstanding = sum of positive balances. |
| Paid / Part-paid / Unpaid | Balance 0 / some payment and balance > 0 / no payment. |
| Overdue | Balance > 0 and the fee's `dueDate` is in the past. A fee without a due date is never overdue. |
| Population | Students by default. Non-active students (suspended, withdrawn, graduated) are excluded unless `includeInactive=true`; they already show in Needs review. Applicants get their own small section. |

Everything is computed live with SQL aggregates over Obligation and LedgerEntry: a few thousand students is a few
milliseconds, so no summary tables or nightly jobs. If that ever changes, a materialised view can sit behind the same
endpoints.

## Endpoints (all department-scoped for heads of department and deans)

### 1. `GET /v1/admin/reports/outstanding` (`reports.read`)

Filters: `feeId` or `feeType` + `period`, `faculty`, `department`, `includeInactive`.

```json
{
  "asOf": "2026-11-21T10:00:00Z",
  "filters": { "feeId": "…", "departments": null },
  "totals": { "students": 1240, "billed": "…", "collected": "…", "outstanding": "…",
              "paid": 610, "partPaid": 380, "unpaid": 250, "overdue": 190, "overdueAmount": "…" },
  "grid": [
    { "department": "COMPUTER-SCI", "departmentName": "Computer Science", "facultyCode": "FAC-PURE-SCI",
      "level": 1, "students": 212, "billed": "…", "collected": "…", "outstanding": "…",
      "paid": 90, "partPaid": 70, "unpaid": 52, "overdue": 40, "collectionRate": 0.62 }
  ],
  "byFee": [ { "feeId": "…", "feeName": "Tuition 2026/27", "dueDate": "…", "billed": "…", "collected": "…", "outstanding": "…" } ],
  "applicants": { "byStatus": [ { "status": "APPLIED", "count": 41, "paid": 30, "outstanding": "…" } ] },
  "roster": { "students": 1240, "withoutObligations": 3, "lastPortalEventAt": "…" }
}
```

`roster.withoutObligations` flags active students no active fee matched (usually a missing rate rule), so gaps are
visible rather than silently counted as "nothing owed".

### 2. `GET /v1/admin/payers` (`payers.read`)

The student list behind every cell of the grid. Filters: `kind`, `department`, `faculty`, `level`, `enrolmentStatus`,
`feeId`, `standing` (`PAID`, `PART_PAID`, `UNPAID`, `OVERDUE`), `q` (ref or name contains), `sort`
(`balance` | `name` | `ref`), cursor paging.

Each row: id, ref, kind, full name, department, level, enrolment status, billed, collected, balance, overdue flag,
last payment date.

### 3. `GET /v1/admin/payers/export.csv` (`payments.export`)

The same filters as the list, streamed as CSV for follow-up calls and letters. Audited like the payments export.

### 4. `GET /v1/admin/payers/:id` (`payers.read`)

The record (with `applicationRef` linking to the applicant), each obligation with fee, amount, rate rule, minimum
instalment, balance and ledger entries, payments (status, channel, amount, dates), receipts, and the last 20 portal
events for that ref. A department-scoped admin gets 404 for a payer outside their departments.

## Decisions needed

1. **Phone numbers in admin views.** Recommend: full phone in the detail view only (bursary needs to call), masked in
   lists and the CSV. Alternative: masked everywhere for heads of department and deans.
2. **CSV export permission.** Recommend reusing `payments.export` (bursar and super admin) rather than adding a new one.
3. **Inactive students in totals.** Recommend excluded by default with the `includeInactive` switch.
4. **Applicants** in the same report as a separate section (recommended), or a separate endpoint.

## Steps (one commit each, with tests)

1. **Domain**: `standing()` (paid, part-paid, unpaid, overdue) and the totals reducer, with unit tests.
2. **Outstanding report** endpoint, scoped, with e2e tests on a seeded department × level spread.
3. **Payer list** with filters, sort and cursor paging.
4. **CSV export**, audited.
5. **Payer detail**.
6. **OpenAPI, contract test, README, architecture spec and a dashboard prompt** (grid heat map that drills into the
   list, then the detail page).

No schema change and no new dependency. One index is worth adding: `Payer(department, level)` for the grid and list
filters.
