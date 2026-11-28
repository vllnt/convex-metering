# API Reference — @vllnt/convex-metering

**Compatibility:** `convex@^1.45.0`; React >=18 is optional. This file ships in
the npm package at `node_modules/@vllnt/convex-metering/docs/API.md` and matches
the installed version.

## Entry points

| Import                                              | Exports                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@vllnt/convex-metering`                            | `Metering` class; types `MeteringComponent`, `MeteringOptions`, `DefineMeterOptions`, `RecordOptions`, `RecordOutcome`, `LimitOutcome`, `MeterDefinition`, `Usage`, `UsageEntry`, `SubjectUsageEntry`, `VerifyResult`, `Aggregation` |
| `@vllnt/convex-metering/convex.config`              | the component definition for `app.use(...)`                                                                                                                             |
| `@vllnt/convex-metering/react`                      | `useUsage`, `useUsageList`, type `UsageView` (see [React hooks](#react-hooks))                                                                                           |
| `@vllnt/convex-metering/test`                       | `register(t, name = "metering")` for `convex-test` (see [Testing](#testing))                                                                                            |
| `@vllnt/convex-metering/_generated/component`       | type `ComponentApi` (Convex codegen)                                                                                                                                     |

Construct the client with the mounted component and optional config:

```ts
import { Metering } from "@vllnt/convex-metering";

const metering = new Metering(components.metering, {
  defaultScope: "global", // namespace applied when a call omits `scope`
  defaultPeriod: "all", // period bucket applied when a call omits `period`
});
```

All methods take the host `ctx` as the first argument: mutation methods need a
mutation or action `ctx` (`runMutation`); query methods take any `ctx` with
`runQuery`.

**Optional fields accept `undefined`.** Every optional option field (`period?`,
`scope?`, `actorRef?`, …) is typed `?: T | undefined`, so a host compiled with
`exactOptionalPropertyTypes` can pass its own optional args straight through;
an `undefined` field behaves as if it were omitted.

**Periods are host-owned.** A `period` is an opaque string you choose
(`"2026-06"`, `"2026-W24"`). The component never parses dates, so the calendar
and timezone are entirely yours.

**Precision.** `sum` accumulates in IEEE-754 floats. For money-exact metering,
record **integer minor-units** (bytes not GB, mills not dollars) and scale in
the host.

**Time is server-sourced.** Timestamps are read from the server clock; no method
accepts a caller one.

## Mutations

### `defineMeter(ctx, key, opts?) → { created }`

`opts`:
`{ aggregation?: "sum" | "max" | "last" | undefined; unit?: string | undefined; scope?: string | undefined }`
(defaults `sum`, `""`).

Create or update a meter. `unit` may change freely. `aggregation` is **locked
once any usage exists** (`AGGREGATION_LOCKED`) — switching it would leave the
rollup computed under two rules; define a new meter key instead.

**Throws** `INVALID_ARGUMENT` (an empty `scope` or `key`), `AGGREGATION_LOCKED`.

### `record(ctx, meter, subjectRef, quantity, opts?) → RecordOutcome`

`opts`: `{ period?; idempotencyKey?; actorRef?; scope? }`.

Record a usage event and advance the rollup. `{ recorded: true; value; count }`,
or `{ recorded: false; reason: "duplicate" }` when the `idempotencyKey` was
already seen. The dedup is tracked in a dedicated `seen` ledger that **survives
`pruneRecords`**, so a redelivered event never double-counts even after raw
records are pruned, while its key is retained. Keys are scoped to
`(scope, meter)`, not subject or period; use a unique key per logical event
across that meter. Omit the key and each call records again. `actorRef` is
stored on the record for the audit trail.

**Throws** `INVALID_QUANTITY` (negative/non-finite), `INVALID_ARGUMENT` (an empty
string argument), `QUANTITY_OVERFLOW`, `METER_NOT_FOUND`,
`IDEMPOTENCY_NOT_SUPPORTED` (an `idempotencyKey` on a non-`sum` gauge),
`PERIOD_CLOSED` (the period was frozen).

### `recordWithLimit(ctx, meter, subjectRef, quantity, limit, opts?) → LimitOutcome`

`opts`: `{ period?; idempotencyKey?; actorRef?; scope? }`.

Atomic check-and-record: records only if it would not push the period over
`limit`, in one serializable mutation (no read-then-write race). Returns the
recorded outcome, `duplicate`, or
`{ recorded: false; reason: "limit_exceeded"; value; limit }`. A duplicate key
returns `duplicate` before the limit is checked.

**Throws** `INVALID_QUANTITY`, `INVALID_LIMIT` (negative/non-finite `limit`),
`INVALID_ARGUMENT`, `METER_NOT_FOUND`, `IDEMPOTENCY_NOT_SUPPORTED`,
`PERIOD_CLOSED`.

### `adjust(ctx, meter, subjectRef, delta, opts?) → RecordOutcome`

`opts`: `{ period?; idempotencyKey?; actorRef?; scope? }`. **`sum` meters
only.**

Post a signed correction (`delta` may be negative — a refund/credit/void).
Appends a reversing record and applies the delta to the rollup, which never goes
negative. Pruning records does not change that rollup. Retry-deduplicated only
when an `idempotencyKey` is supplied and retained.

**Throws** `INVALID_QUANTITY` (non-finite `delta`), `INVALID_ARGUMENT`,
`QUANTITY_OVERFLOW`, `METER_NOT_FOUND`,
`ADJUST_REQUIRES_SUM`, `PERIOD_CLOSED`, `ADJUST_BELOW_ZERO` (the correction
would make the rollup negative).

### `closePeriod(ctx, meter, subjectRef, opts?) → boolean`

`opts`: `{ period?; scope? }`. Freeze a `(meter, subject, period)` so later
`record`/`adjust`/`recordWithLimit` into it throw `PERIOD_CLOSED`. `reset` and
`eraseSubject` do not check the freeze: they still delete a closed period.
Returns `false` if no usage exists for it. `usage()` then reports
`closed: true`. Closing an already-closed period is a no-op that returns
`true` and keeps the original freeze time.

### `reset(ctx, meter, subjectRef, opts?) → number`

`opts`: `{ period?; scope?; batch? }` (`batch` default `200`). Clear a subject's
usage for one `(meter, period)` — deletes the rollup and raw records in bounded,
self-rescheduling batches; returns the records removed this pass (0 once
drained). A pass that empties the period also deletes the rollup, so another
pass is scheduled only when the batch was full. A closed period is deleted
too. Idempotency keys in `seen` are kept, so a late replay stays deduped
rather than re-counting.

### `eraseSubject(ctx, subjectRef, opts?) → number`

`opts`: `{ scope?; batch? }`. Erase a subject across **every meter and period**
(records + rollups), bounded + self-rescheduling; returns the records and
rollups removed this pass, including closed periods. The GDPR right-to-erasure
primitive. `seen` (idempotency keys, no subject PII) is left intact.

### `pruneRecords(ctx, before, batch?) → number` · `pruneSeen(ctx, before, batch?) → number`

`before` required (absolute ms). `pruneRecords` deletes raw records older than
`before`; `pruneSeen` deletes idempotency keys older than `before` — set its
cutoff **older than your longest retry / redelivery window** (pruning a key
re-opens its replay). Rollups are never touched. Both bounded +
self-rescheduling; return the count removed in the first pass. Both span all
scopes in the mount: expose only to authorized administrators. All cleanup
methods use a default batch of 200 and require integers in 1–500
(`INVALID_BATCH`).

## Queries

### `getMeter(ctx, key, scope?) → MeterDefinition | null` · `listMeters(ctx, scope?) → MeterDefinition[]`

The meter definition, or every meter in the scope (the discovery surface).

### `usage(ctx, meter, subjectRef, opts?) → { value, count, closed } | null`

`opts`: `{ period?; scope? }`. A subject's rolled-up usage for one period
(`closed` once frozen), or `null`. The O(1) read for billing / limit checks.

### `listUsage(ctx, meter, subjectRef, scope?) → { period, value, count, closed }[]`

Every period's rollup for a subject on a meter.

### `listSubjectUsage(ctx, subjectRef, scope?) → { meter, period, value, count, closed }[]`

Every meter+period rollup for a subject across the scope — invoice line items in
one read.

### `verify(ctx, meter, subjectRef, opts?) → { rollupValue, rollupCount, recomputedValue, recordsRemaining, consistent }`

`opts`: `{ period?; scope? }`. Reconcile the rollup against the surviving
records by re-folding them under the meter's aggregation. `consistent` is
`rollupValue === recomputedValue`; it does not compare counts. Complete
reconciliation requires the full relevant record history: `recordsRemaining > 0`
alone does not rule out partial pruning. The query collects all matching records
and remains subject to Convex read limits.

**Throws** `METER_NOT_FOUND`.

## Error codes

Errors are thrown as `ConvexError` with `data: { code, message }`; branch on
`error instanceof ConvexError && error.data.code === "PERIOD_CLOSED"`.

| Code                        | Thrown by                                          | When                                                   |
| --------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| `INVALID_BATCH`             | Cleanup methods                                    | Batch is not an integer in 1–500.                      |
| `INVALID_QUANTITY`          | `record` / `recordWithLimit` / `adjust`            | `quantity` negative/non-finite, or `delta` non-finite. |
| `INVALID_LIMIT`             | `recordWithLimit`                                  | `limit` negative/non-finite.                           |
| `INVALID_BEFORE`            | `pruneRecords` / `pruneSeen`                       | `before` is not finite.                                |
| `INVALID_ARGUMENT`          | `defineMeter` / `record` / `recordWithLimit` / `adjust` | A string argument (`scope`, `key`, `meter`, `subjectRef`, `period`, `idempotencyKey`, `actorRef`) is empty. |
| `QUANTITY_OVERFLOW`         | `record` / `adjust`                                | The rollup would exceed the largest finite number.     |
| `METER_NOT_FOUND`           | `record` / `recordWithLimit` / `adjust` / `verify` | No meter defined for `(scope, meter)`.                 |
| `IDEMPOTENCY_NOT_SUPPORTED` | `record` / `recordWithLimit`                       | An `idempotencyKey` on a non-`sum` (gauge) meter.      |
| `PERIOD_CLOSED`             | `record` / `recordWithLimit` / `adjust`            | The period was frozen by `closePeriod`.                |
| `AGGREGATION_LOCKED`        | `defineMeter`                                      | An aggregation change after usage exists.              |
| `ADJUST_REQUIRES_SUM`       | `adjust`                                           | A non-`sum` meter.                                     |
| `ADJUST_BELOW_ZERO`         | `adjust`                                           | The correction would make the rollup negative.         |

## React hooks

`@vllnt/convex-metering/react` (optional peer `react` >=18). Each hook wraps
`useQuery` over a query reference **your app exports** (a host wrapper around
`usage` / `listUsage` with its own auth); the component never imports your `api`.

### `useUsage(usageRef, args, opts?) → UsageView`

`args`: `{ meter; subjectRef; period; scope? }`; `opts`: `{ limit? }`. Returns
`{ isLoading, value, count, closed }` (`value`/`count` are `0` and `closed` is
`false` while loading or when nothing is recorded). With a `limit` it also
returns `limit`, `remaining` (`max(0, limit - value)`), `fraction` (`0..1`;
`0` when `limit` is `0`) and `exceeded` (`value > limit`).

### `useUsageList(listUsageRef, args) → UsageEntry[] | undefined`

`args`: `{ meter; subjectRef; scope? }`. `undefined` while loading.

## Testing

`@vllnt/convex-metering/test` exports `register(t, name = "metering")`, which
mounts the component in a `convex-test` instance. `t` is the host app's own
`convexTest(hostSchema, modules)` instance, whatever its tables; pass `name` when
the host mounts the component under another name. It ships as TypeScript source
and needs `convex-test` and `vitest` (Vite's `import.meta.glob`) in the
consuming app.
