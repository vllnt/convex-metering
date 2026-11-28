# API Reference — @vllnt/convex-metering

**Compatibility:** `convex@^1.45.0`; Node.js `>=20` (`engines.node`, the
minimum of `convex` 1.45; the installed `convex` may need newer: 1.51 needs
`>=22`); React
`>=18` is optional. This file ships in the npm package at
`node_modules/@vllnt/convex-metering/docs/API.md` and matches the installed
version.

## Entry points

| Import | Exports |
| --- | --- |
| `@vllnt/convex-metering` | The [`Metering`](#metering) class and the types [`MeteringComponent`](#meteringcomponent), [`MeteringOptions`](#meteringoptions), [`DefineMeterOptions`](#definemeteroptions), [`RecordOptions`](#recordoptions), [`RecordOutcome`](#recordoutcome), [`LimitOutcome`](#limitoutcome), [`MeterDefinition`](#meterdefinition), [`Usage`](#usage-type), [`UsageEntry`](#usageentry), [`SubjectUsageEntry`](#subjectusageentry), [`VerifyResult`](#verifyresult), [`Aggregation`](#aggregation). |
| `@vllnt/convex-metering/convex.config` | The component definition ([default export](#convexconfig)), passed to `app.use(...)`. |
| `@vllnt/convex-metering/react` | [`useUsage`](#useusage), [`useUsageList`](#useusagelist) and the type [`UsageView`](#usageview). |
| `@vllnt/convex-metering/test` | [`register`](#register), to mount the component in a `convex-test` instance. |
| `@vllnt/convex-metering/_generated/component` | The [`ComponentApi`](#componentapi) type (types only). |
| `@vllnt/convex-metering/convex.config.js`, `@vllnt/convex-metering/_generated/component.js` | Aliases of `./convex.config` and `./_generated/component` with a `.js` suffix, for imports that spell it out. |
| `@vllnt/convex-metering/package.json` | The package manifest, for tools that read the installed version. |

## Client

### `Metering`

`new Metering(component, options?)`

- `component`: [`MeteringComponent`](#meteringcomponent), the mount's function
  references: `components.metering`, or `components.<name>` for
  `app.use(metering, { name })`.
- `options`: [`MeteringOptions`](#meteringoptions). `defaultScope` (default
  `"global"`) is used when a call omits `scope`; `defaultPeriod` (default
  `"all"`) is used when a call omits `period`.

```ts
// convex/metering.ts
import { Metering } from "@vllnt/convex-metering";

import { components } from "./_generated/api.js";

export const metering = new Metering(components.metering, {
  defaultScope: "global",
  defaultPeriod: "all",
});
```

Every method takes the host `ctx` as its first argument and returns a
`Promise`. Mutation methods need a `ctx` with `runMutation` (a mutation or
action context); query methods need a `ctx` with `runQuery` (a query, mutation
or action context).

**Optional inputs accept `undefined`.** Every optional field of an options
object (`period?`, `idempotencyKey?`, `actorRef?`, `scope?`, `batch?`, and the
React hook `scope?` and `limit?`) is typed `?: T | undefined`, so a host
compiled with `exactOptionalPropertyTypes` can pass its own optional values
through. Optional positional parameters (`batch?` of `pruneRecords` and
`pruneSeen`; `scope?` of `getMeter`, `listMeters`, `listUsage` and
`listSubjectUsage`) are typed `?: T` and also accept `undefined`. An `undefined`
input behaves as if omitted.

**Periods are host-owned.** A `period` is an opaque string (`"2026-06"`,
`"2026-W24"`). The component never parses dates.

**Precision.** `sum` accumulates IEEE-754 doubles. For exact money, record
integer minor units (bytes, mills) and scale in the host.

**Time is server-sourced.** `createdAt`, record times and idempotency-key times
are read from the server clock; no method accepts a caller timestamp.

**Idempotency keys.** An `idempotencyKey` is stored in a `seen` table, separate
from the raw records, scoped to `(scope, meter)` (not to subject or period).
A repeated key returns `{ recorded: false, reason: "duplicate" }` and changes
nothing. Keys survive `reset`, `eraseSubject` and `pruneRecords`; only
`pruneSeen` removes them. Keys are accepted only on `sum` meters.

**String length cap.** `defineMeter`, `record`, `recordWithLimit` and `adjust`
reject a string argument longer than 256 UTF-16 code units (JavaScript
`.length`; an emoji outside the Basic Multilingual Plane counts as 2) with
`INVALID_ARGUMENT`. Queries and `closePeriod`, `reset`, `eraseSubject`,
`pruneRecords` and `pruneSeen` are not capped, so a row an older version stored
with a longer value stays readable and erasable, but recording, adjusting or
redefining (`defineMeter`) it throws.

### `defineMeter`

`defineMeter(ctx, key, opts?) → Promise<{ created: boolean }>` (mutation)

`opts`: [`DefineMeterOptions`](#definemeteroptions),
`{ aggregation?: "sum" | "max" | "last"; unit?: string; scope?: string }`.

Create or update the meter `(scope, key)`. `aggregation` defaults to `"sum"`
and `unit` to `""`; the client always sends both, and an update writes them
when they differ from the stored values (no write otherwise). `unit` may change
at any time. `aggregation` may change only while the meter has no rollup in
that scope. Returns `{ created: true }` on insert, `{ created: false }` on
update.

**Throws** `INVALID_ARGUMENT` (empty `scope` or `key`, or a `scope`, `key` or
`unit` longer than 256 UTF-16 code units), `AGGREGATION_LOCKED`.

### `record`

`record(ctx, meter, subjectRef, quantity, opts?) → Promise<RecordOutcome>` (mutation)

`opts`: [`RecordOptions`](#recordoptions),
`{ period?: string; idempotencyKey?: string; actorRef?: string; scope?: string }`.

Append a record and fold `quantity` into the `(meter, subjectRef, period)`
rollup under the meter's aggregation (`sum` adds, `max` keeps the peak, `last`
keeps the latest; the first record sets the value). Returns
`{ recorded: true, value, count }` with the new rollup, or
`{ recorded: false, reason: "duplicate" }` for a repeated `idempotencyKey`.
`actorRef` is stored on the record.

Checks run in this order: `quantity`, empty or over-long strings, meter exists, key on a
non-`sum` meter, period closed, duplicate key, overflow.

**Throws** `INVALID_QUANTITY` (negative or non-finite), `INVALID_ARGUMENT`
(`scope`, `meter`, `subjectRef`, `period`, `idempotencyKey` or `actorRef`
empty or longer than 256 UTF-16 code units), `METER_NOT_FOUND`, `IDEMPOTENCY_NOT_SUPPORTED`, `PERIOD_CLOSED`,
`QUANTITY_OVERFLOW`.

### `recordWithLimit`

`recordWithLimit(ctx, meter, subjectRef, quantity, limit, opts?) → Promise<LimitOutcome>` (mutation)

`opts`: [`RecordOptions`](#recordoptions).

Compute the projected rollup (current value folded with `quantity`) and record
only when it is `<= limit`, in one mutation. Returns the recorded outcome,
`{ recorded: false, reason: "duplicate" }`, or
`{ recorded: false, reason: "limit_exceeded", value, limit }` with the
unchanged `value`. A repeated key returns `duplicate` before the limit is
checked. `limit_exceeded` writes nothing, including the key.

**Throws** `INVALID_QUANTITY`, `INVALID_LIMIT` (negative or non-finite
`limit`), `INVALID_ARGUMENT` (as `record`), `METER_NOT_FOUND`, `IDEMPOTENCY_NOT_SUPPORTED`,
`PERIOD_CLOSED`.

### `adjust`

`adjust(ctx, meter, subjectRef, delta, opts?) → Promise<RecordOutcome>` (mutation)

`opts`: `{ period?: string; idempotencyKey?: string; actorRef?: string; scope?: string }`.
`sum` meters only.

Append a record with the signed `delta` (negative for a refund, credit or void)
and add it to the rollup, which may not go below zero. The rollup's `count`
goes up by 1. A period with no usage gets a new rollup. Returns the same shape
as `record`.

**Throws** `INVALID_QUANTITY` (non-finite `delta`), `INVALID_ARGUMENT` (as
`record`), `METER_NOT_FOUND`, `ADJUST_REQUIRES_SUM`, `PERIOD_CLOSED`, `QUANTITY_OVERFLOW`,
`ADJUST_BELOW_ZERO`.

### `closePeriod`

`closePeriod(ctx, meter, subjectRef, opts?) → Promise<boolean>` (mutation)

`opts`: `{ period?: string; scope?: string }`.

Set `closedAt` on the `(meter, subjectRef, period)` rollup. Later `record`,
`recordWithLimit` and `adjust` into it throw `PERIOD_CLOSED`, and `usage`
reports `closed: true`. Returns `false` when the period has no rollup. Closing
an already-closed period returns `true` and keeps the original `closedAt`.
`reset` and `eraseSubject` still delete a closed period. Empty strings are not
rejected.

### `reset`

`reset(ctx, meter, subjectRef, opts?) → Promise<number>` (mutation)

`opts`: `{ period?: string; scope?: string; batch?: number }` (`batch` default
`200`, integer 1..500).

Delete up to `batch` raw records of one `(meter, subjectRef, period)`. A full
batch schedules the next pass; the pass that finds fewer than `batch` records
also deletes the rollup. Returns the records deleted in this pass. Closed
periods are deleted too. `seen` keys are kept, so a replayed event stays a
`duplicate`.

**Throws** `INVALID_BATCH`.

### `eraseSubject`

`eraseSubject(ctx, subjectRef, opts?) → Promise<number>` (mutation)

`opts`: `{ scope?: string; batch?: number }` (`batch` default `200`, integer
1..500).

Delete up to `batch` records and up to `batch` rollups of `subjectRef` in one
scope, across every meter and period (closed periods included). Schedules
another pass while either batch was full. Returns the rows deleted in this
pass. `seen` keys are not touched.

**Throws** `INVALID_BATCH`.

### `pruneRecords`

`pruneRecords(ctx, before, batch?) → Promise<number>` (mutation)

Delete up to `batch` (default `200`, integer 1..500) raw records whose record
time is `< before` (absolute ms), oldest first, across every scope in the
mount. Schedules the next pass while a pass is full. Returns this pass's count.
Rollups and `seen` keys are not touched, so a pruned event's key still dedupes.

**Throws** `INVALID_BATCH`, `INVALID_BEFORE` (non-finite `before`).

### `pruneSeen`

`pruneSeen(ctx, before, batch?) → Promise<number>` (mutation)

Delete up to `batch` (default `200`, integer 1..500) idempotency keys stored
`< before` (absolute ms), oldest first, across every scope in the mount.
Schedules the next pass while a pass is full. Returns this pass's count. A
deleted key no longer dedupes: set `before` older than your longest retry or
redelivery window.

**Throws** `INVALID_BATCH`, `INVALID_BEFORE`.

### `getMeter`

`getMeter(ctx, key, scope?) → Promise<MeterDefinition | null>` (query)

The meter definition, or `null`.

### `listMeters`

`listMeters(ctx, scope?) → Promise<MeterDefinition[]>` (query)

Every meter in one scope (default: the client `defaultScope`), in the order
they were first defined, oldest first; re-defining a meter keeps its place. Not
paginated.

### `usage`

`usage(ctx, meter, subjectRef, opts?) → Promise<Usage | null>` (query)

`opts`: `{ period?: string; scope?: string }`.

`{ value, count, closed }` for one period, read from one rollup document, or
`null` when nothing was recorded. Does not check that the meter exists.

### `listUsage`

`listUsage(ctx, meter, subjectRef, scope?) → Promise<UsageEntry[]>` (query)

One `{ period, value, count, closed }` entry per period of one meter for a
subject, ordered by `period` string. Not paginated.

### `listSubjectUsage`

`listSubjectUsage(ctx, subjectRef, scope?) → Promise<SubjectUsageEntry[]>` (query)

One `{ meter, period, value, count, closed }` entry per meter and period for a
subject in one scope, in the order the rollups were created, oldest first. It is
not sorted by meter or period: sort in the host if you need that. A period
cleared by `reset` and recorded again gets a new rollup and moves to the end.
Not paginated.

### `verify`

`verify(ctx, meter, subjectRef, opts?) → Promise<VerifyResult>` (query)

`opts`: `{ period?: string; scope?: string }`.

Re-fold the surviving records of one period under the meter's aggregation and
compare. Returns `{ rollupValue, rollupCount, recomputedValue,
recordsRemaining, consistent }`; `consistent` is
`rollupValue === recomputedValue` and does not compare counts. It is complete
only while the period's full record history survives: `recordsRemaining > 0`
does not rule out partial pruning. With no rollup and no records it returns
zeros and `consistent: true`. Reads every record of the period (not
paginated).

**Throws** `METER_NOT_FOUND`.

## Types

### `MeteringComponent`

The type of `components.metering`: the component's `mutations` and `queries`
function references. Pass it to [`Metering`](#metering).

### `MeteringOptions`

`{ defaultScope?: string | undefined; defaultPeriod?: string | undefined }`.
Defaults `"global"` and `"all"`.

### `DefineMeterOptions`

`{ aggregation?: Aggregation | undefined; unit?: string | undefined; scope?: string | undefined }`.

### `RecordOptions`

`{ period?: string | undefined; idempotencyKey?: string | undefined; actorRef?: string | undefined; scope?: string | undefined }`.

### `RecordOutcome`

`{ recorded: true; value: number; count: number } | { recorded: false; reason: "duplicate" }`.

### `LimitOutcome`

`RecordOutcome | { recorded: false; reason: "limit_exceeded"; value: number; limit: number }`.

### `MeterDefinition`

`{ key: string; scope: string; aggregation: Aggregation; unit: string; createdAt: number }`.
`createdAt` is in ms.

### `Usage` type

`{ value: number; count: number; closed: boolean }`. `count` is the number of
records written into the period (`record`, `recordWithLimit` and `adjust` each
add one); pruning does not lower it.

### `UsageEntry`

`{ period: string; value: number; count: number; closed: boolean }`.

### `SubjectUsageEntry`

`{ meter: string; period: string; value: number; count: number; closed: boolean }`.

### `VerifyResult`

`{ rollupValue: number; rollupCount: number; recomputedValue: number; recordsRemaining: number; consistent: boolean }`.

### `Aggregation`

`"sum" | "max" | "last"`.

## React hooks

`@vllnt/convex-metering/react` (optional peer `react >=18`; also imports
`convex/react`). Each hook wraps `useQuery` over a public query reference that
**your app exports**, usually a wrapper around `usage` or `listUsage` with its
own authorization; the component never imports your `api`. The hooks take no
`"skip"` argument.

### `useUsage`

`useUsage(usageRef, args, opts?) → UsageView`

`usageRef`: a public query with args `{ meter; subjectRef; period; scope? }`
returning `Usage | null`. `args`:
`{ scope?: string | undefined; meter: string; subjectRef: string; period: string }`.
`opts`: `{ limit?: number | undefined }`.

### `useUsageList`

`useUsageList(listUsageRef, args) → UsageEntry[] | undefined`

`listUsageRef`: a public query with args `{ meter; subjectRef; scope? }`
returning `UsageEntry[]`. `args`:
`{ scope?: string | undefined; meter: string; subjectRef: string }`. Returns
`undefined` while loading.

### `UsageView`

`{ isLoading; value; count; closed; limit?; remaining?; fraction?; exceeded? }`.
`value` and `count` are `0` and `closed` is `false` while loading or when
nothing is recorded. With a `limit`: `remaining` is `max(0, limit - value)`,
`fraction` is `min(1, value / limit)` (`0` when `limit <= 0`), and `exceeded` is
`value > limit`.

## Other entry points

### `convex.config`

The default export of `@vllnt/convex-metering/convex.config` is the component
definition (`defineComponent("metering")`). Pass it to `app.use(metering)`, or
`app.use(metering, { name })` for a named mount.

### `register`

`register(t, name = "metering") → void`, from `@vllnt/convex-metering/test`.
Calls `t.registerComponent(name, schema, modules)` with the component's schema
and modules. `t` is the host app's own `convexTest(hostSchema, modules)`
instance, whatever its tables. The entry ships as TypeScript source and needs
`convex-test` and Vite's `import.meta.glob` (for example through `vitest`).
Build the host's module map with `import.meta.glob("./**/*.*s")` so it includes
the `.js` files in `convex/_generated/`; with `./**/*.ts` and no `.d.ts` files
there, `convex-test` throws `Could not find the "_generated" directory`.
Install the test tooling with
`pnpm add -D convex-test vitest vite @edge-runtime/vm` and set
`test.environment: "edge-runtime"` in your Vitest config. `convex-test` 0.0.72
and later declare peer `convex@^1.46.0` and fail `tsc` with TS2724
(`FunctionReference_future`) on convex 1.45 unless `skipLibCheck` is on; on
convex 1.45.x, use `convex-test@0.0.71` or older (peer `convex@^1.43.0`).

### `ComponentApi`

The generated type of the mounted component, from
`@vllnt/convex-metering/_generated/component` (types only).

## Error codes

Thrown as `ConvexError` with `data: { code, message }`; branch on
`error instanceof ConvexError && error.data.code === "PERIOD_CLOSED"`.

| Code | Thrown by | When |
| --- | --- | --- |
| `INVALID_ARGUMENT` | `defineMeter`, `record`, `recordWithLimit`, `adjust` | A string argument is empty, or longer than 256 UTF-16 code units: `scope` or `key` (`defineMeter`, which also caps `unit`); `scope`, `meter`, `subjectRef`, `period`, `idempotencyKey` or `actorRef` (the others). |
| `INVALID_QUANTITY` | `record`, `recordWithLimit`, `adjust` | `quantity` is negative or non-finite, or `delta` is non-finite. |
| `INVALID_LIMIT` | `recordWithLimit` | `limit` is negative or non-finite. |
| `METER_NOT_FOUND` | `record`, `recordWithLimit`, `adjust`, `verify` | No meter `(scope, meter)`. |
| `IDEMPOTENCY_NOT_SUPPORTED` | `record`, `recordWithLimit` | An `idempotencyKey` on a `max` or `last` meter. |
| `PERIOD_CLOSED` | `record`, `recordWithLimit`, `adjust` | The period was closed by `closePeriod`. |
| `QUANTITY_OVERFLOW` | `record`, `adjust` | The rollup would become non-finite. |
| `AGGREGATION_LOCKED` | `defineMeter` | `aggregation` changes while the meter has a rollup. |
| `ADJUST_REQUIRES_SUM` | `adjust` | The meter is not `sum`. |
| `ADJUST_BELOW_ZERO` | `adjust` | The rollup would go below zero. |
| `INVALID_BATCH` | `reset`, `eraseSubject`, `pruneRecords`, `pruneSeen` | `batch` is not an integer in 1..500. |
| `INVALID_BEFORE` | `pruneRecords`, `pruneSeen` | `before` is not finite. |
