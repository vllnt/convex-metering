<!-- Badges -->

[![convex-component](https://img.shields.io/badge/convex-component-EE342F.svg)](https://www.convex.dev/components)
[![npm](https://img.shields.io/npm/v/@vllnt/convex-metering.svg)](https://www.npmjs.com/package/@vllnt/convex-metering)
[![CI](https://github.com/vllnt/convex-metering/actions/workflows/ci.yml/badge.svg)](https://github.com/vllnt/convex-metering/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@vllnt/convex-metering.svg)](./LICENSE)

# @vllnt/convex-metering

Metered usage records — idempotent usage events rolled up per billing period, as
a Convex component.

```ts
const metering = new Metering(components.metering);
await metering.defineMeter(ctx, "api_calls", {
  aggregation: "sum",
  unit: "requests",
});
await metering.record(ctx, "api_calls", orgId, 1, {
  period: "2026-06",
  idempotencyKey: requestId, // a retry won't double-count
});
const used = await metering.usage(ctx, "api_calls", orgId, {
  period: "2026-06",
});
```

Define a meter, record usage for an opaque subject into host-chosen period
buckets, and read O(1) per-period rollups for billing or limit checks. Sum
recording with a retained idempotency key avoids double-counting retries. Price
it in your own tables — this owns accurate usage, not your rates.

## Features

- **Idempotent recording** — `idempotencyKey` makes a retry a no-op; the dedup
  ledger is **separate from records**, so it survives `pruneRecords` (no
  double-count after pruning).
- **Per-meter aggregation** — `sum` (accumulate), `max` (peak), or `last`
  (gauge), locked once usage exists.
- **Corrections + freeze** — `adjust` posts signed refunds/credits (sum, never
  below zero); `closePeriod` freezes a billed period so late events can't
  restate it.
- **Atomic limits** — `recordWithLimit` checks a cap and records in one
  transaction (no read-then-write overage race).
- **Reconciliation** — `verify` recomputes the rollup from records and flags
  drift for billing audits.
- **Lifecycle + GDPR** — `listMeters`/`listSubjectUsage` discovery, batched
  `reset`, and `eraseSubject` (erase a subject across all meters).
- **Period rollups** — each `(meter, subject, period)` rolls up independently;
  reads are O(1).
- **Host-owned periods** — `period` is an opaque string you choose (`"2026-06"`,
  `"2026-W24"`, `"all"`); no date parsing, any calendar/timezone.
- **Audit + retention** — raw records back every rollup; prune old records on
  your schedule, rollups stay.
- **Scopes** — global by default, or namespace per tenant.
- **Fully typed** — quantities, periods, and units are concrete types end to
  end; no `any`.
- **Server-sourced time** — record timestamps come from the server, never the
  caller.

## Installation

```bash
pnpm add @vllnt/convex-metering
```

Node.js >=18; required peer: `convex@^1.45.0`. React >=18 is optional. The
default npm channel is stable; use `@vllnt/convex-metering@canary` for the
current prerelease surface documented here.

## Usage

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import metering from "@vllnt/convex-metering/convex.config";

const app = defineApp();
app.use(metering);
export default app;
```

```ts
// convex/usage.ts — host owns auth; pass an opaque subjectRef + period in.
import { components } from "./_generated/api";
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { Metering } from "@vllnt/convex-metering";

const metering = new Metering(components.metering);

export const meterApiCall = mutation({
  args: { orgId: v.string(), requestId: v.string() },
  handler: async (ctx, { orgId, requestId }) => {
    return metering.record(ctx, "api_calls", orgId, 1, {
      period: "2026-06",
      idempotencyKey: requestId, // safe under retries
    });
  },
});
```

Read `usage(ctx, "api_calls", orgId, { period })` to display usage or bill at
your own rate. Use `recordWithLimit` for atomic enforcement, not a
read-then-record sequence. The wrapper above is illustrative: authenticate the
caller, authorize the organization and derive trusted request IDs/periods in the
host. After mounting, run `pnpm convex dev` to generate component references.
See [`example/convex/example.ts`](example/convex/example.ts).

## Configuration and limits

Client defaults: `defaultScope: "global"`, `defaultPeriod: "all"`. Omitted
periods accumulate in one all-time bucket; no automatic calendar reset exists.
`defineMeter` defaults to `aggregation: "sum"` and `unit: ""`.

Idempotency keys are scoped to `(scope, meter)`, **not subject or period**; use
a unique key per logical event across that meter. Keys are supported only on sum
meters. Without a key, record/adjust calls are not retry-deduplicated. Pruning
`seen` reopens replay; pruning records does not. Prune methods span every scope
in the mount and must be admin-only. Cleanup batches default to 200 (integer
1–500); returns count only the first pass. List queries and `verify` are not
paginated and remain subject to Convex read limits.

`verify.consistent` compares values, not counts. Even a positive
`recordsRemaining` is insufficient after partial pruning: complete
reconciliation requires the entire relevant record history. Pricing and payment
processing belong to the host; use integer minor-units within JavaScript's safe
precision.

## Multiple mounts

```ts
app.use(metering, { name: "webMetering" });
app.use(metering, { name: "gameMetering" });
// new Metering(components.webMetering), new Metering(components.gameMetering)
```

Mounts isolate records, dedup keys and scheduled work; runtime scopes do not
replace host authorization.

## API Reference

| Method                                                                                      | Kind     | Result                                                                         |
| ------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `defineMeter(ctx, key, { aggregation?, unit?, scope? })`                                    | mutation | `{ created: boolean }`                                                         |
| `record(ctx, meter, subjectRef, quantity, { period?, idempotencyKey?, actorRef?, scope? })` | mutation | `{ recorded: true; value; count } \| { recorded: false; reason: "duplicate" }` |
| `recordWithLimit(ctx, meter, subjectRef, quantity, limit, opts?)`                           | mutation | `RecordOutcome \| { recorded: false; reason: "limit_exceeded"; value; limit }` |
| `adjust(ctx, meter, subjectRef, delta, opts?)`                                              | mutation | `RecordOutcome` (sum-only signed correction)                                   |
| `closePeriod(ctx, meter, subjectRef, { period?, scope? })`                                  | mutation | `boolean` (freeze)                                                             |
| `reset(ctx, meter, subjectRef, { period?, scope?, batch? })`                                | mutation | `number` (records removed this pass)                                           |
| `eraseSubject(ctx, subjectRef, { scope?, batch? })`                                         | mutation | `number` (GDPR erasure)                                                        |
| `pruneRecords(ctx, before, batch?)` · `pruneSeen(ctx, before, batch?)`                      | mutation | `number`                                                                       |
| `getMeter(ctx, key, scope?)` · `listMeters(ctx, scope?)`                                    | query    | `MeterDefinition \| null` · `MeterDefinition[]`                                |
| `usage(ctx, meter, subjectRef, { period?, scope? })`                                        | query    | `{ value, count, closed } \| null`                                             |
| `listUsage(ctx, meter, subjectRef, scope?)`                                                 | query    | `{ period, value, count, closed }[]`                                           |
| `listSubjectUsage(ctx, subjectRef, scope?)`                                                 | query    | `{ meter, period, value, count, closed }[]`                                    |
| `verify(ctx, meter, subjectRef, { period?, scope? })`                                       | query    | `{ rollupValue, rollupCount, recomputedValue, recordsRemaining, consistent }`  |

Full reference: [docs/API.md](docs/API.md).

## React

Optional, tree-shakeable hooks via `@vllnt/convex-metering/react` (`react` is an
optional peer dep). Each wraps `useQuery` over a query reference **you
re-export** from your app — the component never owns your `api`. `useUsage`
derives a progress-bar view from an optional `limit`.

```tsx
// convex/usage.ts — re-export a host wrapper (auth gated)
// export const myUsage = query({
//   args: { meter: v.string(), subjectRef: v.string(), period: v.string() },
//   handler: (ctx, { meter, subjectRef, period }) =>
//     metering.usage(ctx, meter, subjectRef, { period }) });
// Add host authorization before exposing this illustrative wrapper.

import { useUsage } from "@vllnt/convex-metering/react";
import { api } from "@/convex/_generated/api";

function UsageBar({ orgId }: { orgId: string }) {
  const u = useUsage(
    api.usage.myUsage,
    { meter: "api_calls", subjectRef: orgId, period: "2026-06" },
    { limit: 10000 },
  );
  if (u.isLoading) return <Spinner />;
  return (
    <Meter
      value={u.fraction}
      label={`${u.value} / ${u.limit}`}
      warn={u.exceeded}
    />
  );
}
```

| Hook                                   | Wraps       | Returns                                                                         |
| -------------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| `useUsage(usageRef, args, { limit? })` | `usage`     | `{ isLoading, value, count, closed, limit?, remaining?, fraction?, exceeded? }` |
| `useUsageList(listUsageRef, args)`     | `listUsage` | `UsageEntry[] \| undefined`                                                     |

## Security

- Auth-agnostic — the host resolves identity and decides who may define meters,
  record, reset, or read.
- Tables sandboxed — reached only through the exported functions; `subjectRef`,
  `scope`, and `period` stay opaque.
- Server-sourced timestamps — a caller cannot supply record time.

See [docs/API.md](docs/API.md).

## Testing

```bash
pnpm test           # single run
pnpm test:coverage  # enforced 100% on covered files
```

Tests use the simulated `convex-test` backend (`@edge-runtime/vm`), not a real
Convex deployment; they do not prove production concurrency or scheduler
delivery.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Author

Built by [bntvllnt](https://github.com/bntvllnt) ·
[bntvllnt.com](https://bntvllnt.com) · [X @bntvllnt](https://x.com/bntvllnt)

Part of the [@vllnt](https://github.com/vllnt) Convex component fleet —
[vllnt.com](https://vllnt.com)

If this is useful, [sponsor the work](https://github.com/sponsors/bntvllnt).

## License

MIT — see [LICENSE](LICENSE).
