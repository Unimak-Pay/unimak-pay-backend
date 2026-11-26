# Payment lifecycle

Status: **built** (2026-11-28, owner decisions). Payments no longer expire after 15 minutes.

```
              payment.processing_started            payment.processing_completed
  PENDING  ─────────────────────────────▶  PROCESSING  ─────────────────────────────▶  COMPLETED
 (awaiting                                (holds the                                 (ledger entry,
  payment)  ◀── no completion in 24 h ───  amount)                                     receipt)
     │
     ├── deleted after PENDING_PAYMENT_RETENTION_DAYS (7) if nobody paid
     └── deleted when another payment for the same fee completes
```

| Status | Set by | Holds the amount? |
|---|---|---|
| `INITIATED` | creating a USSD payment code at Monime (moments) | no |
| `PENDING` | a new payment, "awaiting payment". Never expires. | **no**: an abandoned one never blocks a fee |
| `PROCESSING` | Monime's `payment.processing_started`, matched on our reference like completion | **yes**, for 24 h |
| `COMPLETED` | Monime's `payment.processing_completed` only (webhook or nightly reconciliation) | n/a: it's paid |
| `FAILED` | Monime rejected the payment code at creation | no |
| `EXPIRED` | payments made before 2026-11-28 only | no |

## Rules

- **No expiry.** `expiresAt` on a payment now means "deleted after", if still unpaid (created + 7 days). The field keeps its
  name so published clients keep working.
- **Holds.** Only PROCESSING holds the amount, so a second payment can't push the fee past its balance while money is
  moving. Two PENDING payments for the full balance can both be started; if both are then paid, the second completion
  is still accepted (Monime has the money) and the webhook notes *Overpaid by …* for a refund, as before.
- **No failure event from Monime.** A PROCESSING payment with no completion within 24 hours stops holding at once, and
  the cleanup puts it back to PENDING. If Monime did collect, the nightly reconciliation still completes it.
- **Late or out-of-order events.** `processing_started` after completion changes nothing. Completion without
  `processing_started` first is applied. A processing amount that differs from ours is flagged UNMATCHED.
- **Deletion** (permanent, audited as `payment.delete_awaiting` with what the payment was):
  - the cleanup (`/cron/expire-payments`, and the nightly `/cron/reconcile`) deletes PENDING/INITIATED payments
    created more than `PENDING_PAYMENT_RETENTION_DAYS` ago;
  - when a payment for a fee completes, that fee's other PENDING/INITIATED payments are deleted in the same
    transaction. A PROCESSING one is never deleted.
  - Only payments with no ledger entry and no receipt can be deleted.
- **Paid after deletion.** If Monime later reports money for a deleted payment (an old ref or code), the event is
  UNMATCHED with a note naming the payment ref and obligation, so it shows in reconciliation for a person to apply or
  refund. It is never ignored.
- **USSD payment codes.** Monime handles their lifetime; an expired or cancelled code at Monime leaves our payment as
  it is. "Check with Monime" (`POST /v1/admin/payments/{id}/reconcile`) only reports.
- The `pg_cron` job that expired payments every 5 minutes is unscheduled by migration `20261128090000_payment_processing`.
