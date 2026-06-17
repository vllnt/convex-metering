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

All methods take the host `ctx` (a query or mutation context) as the first argument. Meter keys,
quantities, units, and `subjectRef` are concrete typed values — there is no opaque payload.

**Periods are host-owned.** A `period` is an opaque string you choose (`"2026-06"`, `"2026-W24"`,
`"all"`). The component never parses dates, so the calendar and timezone are entirely yours.

**Time is server-sourced.** `recordedAt` and rollup timestamps are read from the server clock inside
each handler; no method accepts a caller-supplied timestamp.

## Mutations

### `defineMeter(ctx, key, opts?) → { created: boolean }`

`opts`: `{ aggregation?: "sum" | "max" | "last"; unit?: string; scope?: string }` (defaults:
`aggregation = "sum"`, `unit = ""`).

Create or update a meter, keyed by `(scope, key)`. `aggregation` fixes how successive quantities fold
into a period value: `sum` accumulates, `max` keeps the peak, `last` overwrites (a gauge). `unit` is
a display label. Returns `{ created: true }` on insert, `{ created: false }` on update.

### `record(ctx, meter, subjectRef, quantity, opts?) → RecordOutcome`

`opts`: `{ period?: string; idempotencyKey?: string; scope?: string }` (`period` defaults to the
client `defaultPeriod`).

Record a usage event and advance the rollup for `(scope, meter, subjectRef, period)`:

- `{ recorded: true; value; count }` — the event was written; `value` is the new aggregate for the
  period, `count` the number of events.
- `{ recorded: false; reason: "duplicate" }` — an event with the same `idempotencyKey` was already
  recorded; nothing changed. A retried `record` is a safe no-op.

Without an `idempotencyKey` every call is a distinct event.

**Validation** — throws `ConvexError({ code: "INVALID_QUANTITY" })` when `quantity` is negative or
non-finite, and `ConvexError({ code: "METER_NOT_FOUND" })` when no meter is defined for
`(scope, meter)`. Define the meter first.

### `reset(ctx, meter, subjectRef, opts?) → boolean`

`opts`: `{ period?: string; scope?: string }`.

Clear a subject's usage for one `(meter, period)` — deletes the rollup and every raw record behind
it. Returns `true` when a rollup existed, `false` otherwise. Other periods are untouched.

### `pruneRecords(ctx, before, batch?) → number`

`before` is required (absolute ms); `batch` defaults to `200`.

Delete up to `batch` raw records whose `recordedAt < before`, oldest first via the `by_recorded`
index, and return the count removed in the first pass. **Rollups — the billable truth — are never
touched.** `before` is required by design so a caller cannot wipe everything by passing "now"; the
host owns its retention window. If a full batch was removed the sweep self-reschedules through the
component scheduler until the tail is clean. Idempotent.

## Queries

### `getMeter(ctx, key, scope?) → MeterDefinition | null`

The meter definition (`key`, `scope`, `aggregation`, `unit`, `createdAt`), or `null` if none exists.

### `usage(ctx, meter, subjectRef, opts?) → { value, count } | null`

`opts`: `{ period?: string; scope?: string }`.

A subject's rolled-up usage for one period: `value` is the aggregate (sum, max, or last per the
meter), `count` the number of events. `null` when nothing has been recorded. This is the O(1) read
for billing and limit checks.

### `listUsage(ctx, meter, subjectRef, scope?) → { period, value, count }[]`

Every period's rollup for a subject on a meter. Returns `[]` when the subject has no recorded usage.

## Error codes

| Code | Thrown by | When |
|------|-----------|------|
| `INVALID_QUANTITY` | `record` | `quantity` is negative or non-finite. |
| `METER_NOT_FOUND` | `record` | No meter is defined for `(scope, meter)` — call `defineMeter` first. |
