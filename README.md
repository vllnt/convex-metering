<!-- Badges -->
[![convex-component](https://img.shields.io/badge/convex-component-EE342F.svg)](https://www.convex.dev/components)
[![npm](https://img.shields.io/npm/v/@vllnt/convex-metering.svg)](https://www.npmjs.com/package/@vllnt/convex-metering)
[![CI](https://github.com/vllnt/convex-metering/actions/workflows/ci.yml/badge.svg)](https://github.com/vllnt/convex-metering/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@vllnt/convex-metering.svg)](./LICENSE)

# @vllnt/convex-metering

Metered usage records — idempotent usage events rolled up per billing period, as a Convex component.

```ts
const metering = new Metering(components.metering);
await metering.defineMeter(ctx, "api_calls", { aggregation: "sum", unit: "requests" });
await metering.record(ctx, "api_calls", orgId, 1, {
  period: "2026-06",
  idempotencyKey: requestId, // a retry won't double-count
});
const used = await metering.usage(ctx, "api_calls", orgId, { period: "2026-06" });
```

Define a meter, record usage for an opaque subject into host-chosen period buckets, and read O(1)
per-period rollups for billing or limit checks. Recording is idempotent, so at-least-once retries
never double-count. Price it in your own tables — this owns accurate usage, not your rates.

## Features

- **Idempotent recording** — `idempotencyKey` makes a retry a no-op; the dedup ledger is **separate from records**, so it survives `pruneRecords` (no double-count after pruning).
- **Per-meter aggregation** — `sum` (accumulate), `max` (peak), or `last` (gauge), locked once usage exists.
- **Corrections + freeze** — `adjust` posts signed refunds/credits (sum, never below zero); `closePeriod` freezes a billed period so late events can't restate it.
- **Atomic limits** — `recordWithLimit` checks a cap and records in one transaction (no read-then-write overage race).
- **Reconciliation** — `verify` recomputes the rollup from records and flags drift for billing audits.
- **Lifecycle + GDPR** — `listMeters`/`listSubjectUsage` discovery, batched `reset`, and `eraseSubject` (erase a subject across all meters).
- **Period rollups** — each `(meter, subject, period)` rolls up independently; reads are O(1).
- **Host-owned periods** — `period` is an opaque string you choose (`"2026-06"`, `"2026-W24"`, `"all"`); no date parsing, any calendar/timezone.
- **Audit + retention** — raw records back every rollup; prune old records on your schedule, rollups stay.
- **Scopes** — global by default, or namespace per tenant.
- **Fully typed** — quantities, periods, and units are concrete types end to end; no `any`.
- **Server-sourced time** — record timestamps come from the server, never the caller.

## Installation

```bash
pnpm add @vllnt/convex-metering
```

Peer dependency: `convex@^1.41.0`.

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

Read `usage(ctx, "api_calls", orgId, { period })` for a limit check, or bill from it at your own rate
in your own table — see [`example/convex/example.ts`](example/convex/example.ts).

## API Reference

| Method | Kind | Result |
|--------|------|--------|
| `defineMeter(ctx, key, { aggregation?, unit?, scope? })` | mutation | `{ created: boolean }` |
| `record(ctx, meter, subjectRef, quantity, { period?, idempotencyKey?, actorRef?, scope? })` | mutation | `{ recorded: true; value; count } \| { recorded: false; reason: "duplicate" }` |
| `recordWithLimit(ctx, meter, subjectRef, quantity, limit, opts?)` | mutation | `RecordOutcome \| { recorded: false; reason: "limit_exceeded"; value; limit }` |
| `adjust(ctx, meter, subjectRef, delta, opts?)` | mutation | `RecordOutcome` (sum-only signed correction) |
| `closePeriod(ctx, meter, subjectRef, { period?, scope? })` | mutation | `boolean` (freeze) |
| `reset(ctx, meter, subjectRef, { period?, scope?, batch? })` | mutation | `number` (records removed this pass) |
| `eraseSubject(ctx, subjectRef, { scope?, batch? })` | mutation | `number` (GDPR erasure) |
| `pruneRecords(ctx, before, batch?)` · `pruneSeen(ctx, before, batch?)` | mutation | `number` |
| `getMeter(ctx, key, scope?)` · `listMeters(ctx, scope?)` | query | `MeterDefinition \| null` · `MeterDefinition[]` |
| `usage(ctx, meter, subjectRef, { period?, scope? })` | query | `{ value, count, closed } \| null` |
| `listUsage(ctx, meter, subjectRef, scope?)` | query | `{ period, value, count, closed }[]` |
| `listSubjectUsage(ctx, subjectRef, scope?)` | query | `{ meter, period, value, count, closed }[]` |
| `verify(ctx, meter, subjectRef, { period?, scope? })` | query | `{ rollupValue, recomputedValue, recordsRemaining, consistent, … }` |

Full reference: [docs/API.md](docs/API.md).

## React

Backend-only at this version — no `./react` entry. Usage is recorded server-side; a reactive usage
hook may ship in a later version.

## Security

- Auth-agnostic — the host resolves identity and decides who may define meters, record, reset, or read.
- Tables sandboxed — reached only through the exported functions; `subjectRef`, `scope`, and `period` stay opaque.
- Server-sourced timestamps — a caller cannot supply record time.

See [docs/API.md](docs/API.md).

## Testing

```bash
pnpm test           # single run
pnpm test:coverage  # enforced 100% on covered files
```

Tests run against the real component runtime via `convex-test` (`@edge-runtime/vm`), not mocks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Author

Built by [bntvllnt](https://github.com/bntvllnt) · [bntvllnt.com](https://bntvllnt.com) · [X @bntvllnt](https://x.com/bntvllnt)

Part of the [@vllnt](https://github.com/vllnt) Convex component fleet — [vllnt.com](https://vllnt.com)

If this is useful, [sponsor the work](https://github.com/sponsors/bntvllnt).

## License

MIT — see [LICENSE](LICENSE).
