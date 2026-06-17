# API Reference — @vllnt/convex-metering

**Compatibility:** `convex@^1.41.0`

Construct the client with the mounted component and optional config:

```ts
import { Metering } from "@vllnt/convex-metering";

const metering = new Metering(components.metering, {
  defaultScope: "global", // namespace applied when a call omits `scope`
  defaultPeriod: "all", // period bucket applied when a call omits `period`
});
```

All methods take the host `ctx` (a query or mutation context) as the first argument.

**Periods are host-owned.** A `period` is an opaque string you choose (`"2026-06"`, `"2026-W24"`).
The component never parses dates, so the calendar and timezone are entirely yours.

**Precision.** `sum` accumulates in IEEE-754 floats. For money-exact metering, record **integer
minor-units** (bytes not GB, mills not dollars) and scale in the host.

**Time is server-sourced.** Timestamps are read from the server clock; no method accepts a caller one.

## Mutations

### `defineMeter(ctx, key, opts?) → { created }`

`opts`: `{ aggregation?: "sum" | "max" | "last"; unit?: string; scope?: string }` (defaults `sum`, `""`).

Create or update a meter. `unit` may change freely. `aggregation` is **locked once any usage exists**
(`AGGREGATION_LOCKED`) — switching it would leave the rollup computed under two rules; define a new
meter key instead.

### `record(ctx, meter, subjectRef, quantity, opts?) → RecordOutcome`

`opts`: `{ period?; idempotencyKey?; actorRef?; scope? }`.

Record a usage event and advance the rollup. `{ recorded: true; value; count }`, or
`{ recorded: false; reason: "duplicate" }` when the `idempotencyKey` was already seen. The dedup is
tracked in a dedicated `seen` ledger that **survives `pruneRecords`**, so a redelivered event never
double-counts even after raw records are pruned. `actorRef` is stored on the record for the audit trail.

**Throws** `INVALID_QUANTITY` (negative/non-finite), `METER_NOT_FOUND`, `IDEMPOTENCY_NOT_SUPPORTED`
(an `idempotencyKey` on a non-`sum` gauge), `PERIOD_CLOSED` (the period was frozen).

### `recordWithLimit(ctx, meter, subjectRef, quantity, limit, opts?) → LimitOutcome`

Atomic check-and-record: records only if it would not push the period over `limit`, in one
serializable mutation (no read-then-write race). Returns the recorded outcome, `duplicate`, or
`{ recorded: false; reason: "limit_exceeded"; value; limit }`.

### `adjust(ctx, meter, subjectRef, delta, opts?) → RecordOutcome`

`opts`: `{ period?; idempotencyKey?; actorRef?; scope? }`. **`sum` meters only.**

Post a signed correction (`delta` may be negative — a refund/credit/void). Appends a reversing record
and re-folds; the rollup stays equal to the sum of records and never goes negative. Idempotent.

**Throws** `INVALID_QUANTITY` (non-finite `delta`), `METER_NOT_FOUND`, `ADJUST_REQUIRES_SUM`,
`PERIOD_CLOSED`, `ADJUST_BELOW_ZERO` (the correction would make the rollup negative).

### `closePeriod(ctx, meter, subjectRef, opts?) → boolean`

`opts`: `{ period?; scope? }`. Freeze a `(meter, subject, period)` so its billed value is immutable —
later `record`/`adjust`/`recordWithLimit` into it throw `PERIOD_CLOSED`. Returns `false` if no usage
exists for it. `usage()` then reports `closed: true`.

### `reset(ctx, meter, subjectRef, opts?) → number`

`opts`: `{ period?; scope?; batch? }` (`batch` default `200`). Clear a subject's usage for one
`(meter, period)` — deletes the rollup and raw records in bounded, self-rescheduling batches; returns
the records removed this pass (0 once drained). Idempotency keys in `seen` are kept, so a late replay
stays deduped rather than re-counting.

### `eraseSubject(ctx, subjectRef, opts?) → number`

`opts`: `{ scope?; batch? }`. Erase a subject across **every meter and period** (records + rollups),
bounded + self-rescheduling. The GDPR right-to-erasure primitive. `seen` (idempotency keys, no subject
PII) is left intact.

### `pruneRecords(ctx, before, batch?) → number` · `pruneSeen(ctx, before, batch?) → number`

`before` required (absolute ms). `pruneRecords` deletes raw records older than `before`; `pruneSeen`
deletes idempotency keys older than `before` — set its cutoff **older than your longest retry /
redelivery window** (pruning a key re-opens its replay). Rollups are never touched. Both bounded +
self-rescheduling; return the count removed in the first pass.

## Queries

### `getMeter(ctx, key, scope?) → MeterDefinition | null` · `listMeters(ctx, scope?) → MeterDefinition[]`

The meter definition, or every meter in the scope (the discovery surface).

### `usage(ctx, meter, subjectRef, opts?) → { value, count, closed } | null`

`opts`: `{ period?; scope? }`. A subject's rolled-up usage for one period (`closed` once frozen), or
`null`. The O(1) read for billing / limit checks.

### `listUsage(ctx, meter, subjectRef, scope?) → { period, value, count, closed }[]`

Every period's rollup for a subject on a meter.

### `listSubjectUsage(ctx, subjectRef, scope?) → { meter, period, value, count, closed }[]`

Every meter+period rollup for a subject across the scope — invoice line items in one read.

### `verify(ctx, meter, subjectRef, opts?) → { rollupValue, rollupCount, recomputedValue, recordsRemaining, consistent }`

`opts`: `{ period?; scope? }`. Reconcile the rollup against the surviving records by re-folding them
under the meter's aggregation. `consistent` is `rollupValue === recomputedValue`; trust it only when
`recordsRemaining > 0` (pruned history can't be fully recomputed). The billing-audit guardrail.

## Error codes

| Code | Thrown by | When |
|------|-----------|------|
| `INVALID_QUANTITY` | `record` / `recordWithLimit` / `adjust` | `quantity` negative/non-finite, or `delta` non-finite. |
| `METER_NOT_FOUND` | `record` / `recordWithLimit` / `adjust` / `verify` | No meter defined for `(scope, meter)`. |
| `IDEMPOTENCY_NOT_SUPPORTED` | `record` / `recordWithLimit` | An `idempotencyKey` on a non-`sum` (gauge) meter. |
| `PERIOD_CLOSED` | `record` / `recordWithLimit` / `adjust` | The period was frozen by `closePeriod`. |
| `AGGREGATION_LOCKED` | `defineMeter` | An aggregation change after usage exists. |
| `ADJUST_REQUIRES_SUM` | `adjust` | A non-`sum` meter. |
| `ADJUST_BELOW_ZERO` | `adjust` | The correction would make the rollup negative. |
