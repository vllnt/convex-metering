<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `example/convex/_generated/ai/guidelines.md` first** for
important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->

# @vllnt/convex-metering

Metered usage records — idempotent usage events rolled up per billing period, as a Convex component.
It follows the vllnt Component Standard (see the `convex-components` hub
`.claude/rules/component-standard.md`).

## Architecture

```
src/
├── shared.ts              # constants + the pure aggregation rule (applyAggregation)
├── test.ts                # convex-test register() helper
├── client/
│   ├── index.ts           # Metering class (consumer-facing API)
│   └── types.ts           # public TypeScript interfaces
└── component/
    ├── schema.ts           # sandboxed tables: meters, records, rollups
    ├── convex.config.ts    # defineComponent("metering")
    ├── mutations.ts        # defineMeter, record, reset, pruneRecords
    ├── queries.ts          # getMeter, usage, listUsage
    └── validators.ts       # shared validators (aggregation, recordResult, …)
```

Sandboxed tables, no host tables touched:

- `meters` — the definition (`aggregation` rule + display `unit`), unique per `(scope, key)`.
- `records` — append-only raw usage events (the audit trail + the idempotency source).
- `rollups` — the materialized per-`(meter, subject, period)` aggregate; the O(1) read for billing.

## Ownership boundary

**Component owns:**

- The three tables — meter definitions, raw records, materialized rollups
- The aggregation rule per meter (`sum` | `max` | `last`) and the rollup math
- Idempotent recording — a repeat `record` with the same `idempotencyKey` is a no-op
- Period-bounded accounting — each `(meter, subject, period)` rolls up independently
- Validation (`INVALID_QUANTITY`, `METER_NOT_FOUND`) and server-sourced time

**Host owns:**

- The meter keys and what a unit means (a request, a GB, a seat)
- `subjectRef` — an opaque identity string; the component never assumes its shape or source
- `period` — an opaque bucket string (`"2026-06"`, `"2026-W24"`, `"all"`); the host owns the
  calendar and timezone, so the component never parses dates
- **Pricing** — turning a period's usage into a bill happens in the host's own tables at the host's
  rate (see `example/convex/example.ts`)
- Retention — the host drives `pruneRecords` with its own cutoff; rollups are never pruned
- Auth and authorization — who may define meters, record usage, reset, or read

**Auth:** the component is completely auth-agnostic. The host resolves identity, decides access, and
passes opaque `subjectRef` / `scope` / `period` strings.

## Key design decisions

- **Records + rollups split:** raw `records` are the append-only audit trail and the idempotency
  source; `rollups` are the materialized per-period aggregate read in O(1) for billing and limit
  checks. The rollup is the **billable truth** and is never pruned; raw records may be pruned by the
  host once they age past its retention window.

- **Idempotent `record`:** an optional `idempotencyKey` makes a retried event a safe no-op
  (`{ recorded: false, reason: "duplicate" }`) — at-least-once delivery (webhooks, retried
  mutations) never double-counts. Without a key, every call is a distinct event.

- **Aggregation is per-meter, applied on write:** `sum` accumulates, `max` keeps the peak, `last`
  overwrites — fixed at `defineMeter`. The fold is a pure function (`applyAggregation`); the first
  event of a period seeds the rollup with its own quantity, later events fold in.

- **`period` is a host-supplied opaque string:** the component never parses dates or assumes a
  calendar/timezone — the host buckets (`"2026-06"`, `"2026-W24"`, `"all"`) and passes the string in.
  This keeps the component locale- and calendar-agnostic.

- **Metering is not a gate, a balance, or a raw aggregate:** it is accurate, idempotent usage
  accounting with period boundaries — distinct from a rate-limiter (which *blocks*), a wallet (a
  *spendable* balance), and a generic counter (no period model or idempotency). Those compose around
  it; this owns the metered record.

- **Explicit meter definition:** `record` throws `METER_NOT_FOUND` if the meter was never defined —
  the meter's aggregation rule must be known before usage lands, so there is no silent auto-create.

- **Safe prune:** `pruneRecords` requires an explicit `before` cutoff (no default-to-now), so a
  caller cannot wipe all records by accident; rollups are untouched. Bounded + self-rescheduling.

- **Fully typed, zero `v.any()`:** quantities, periods, units, and refs are all concrete types —
  there is no opaque host payload, so the component needs no `jsonValue` escape hatch.

- **Server-sourced time:** `recordedAt` and rollup timestamps are read from the server clock; no API
  accepts a caller-supplied timestamp.

- **Backend-only at 0.1.0 (no `./react` entry):** usage is recorded server-side. A reactive
  `useUsage` read surface (a live "8,200 / 10,000 this period" meter) is a real future addition —
  deferred until a first consumer asks for it, per the front-tooling analysis in the README.

## Conventions

- Mutations in `mutations.ts`, queries in `queries.ts` (enforced by `@vllnt/eslint-config/convex`).
- Explicit `args` + `returns` on every Convex function.
- Concrete typed args throughout — no `v.any()` dumps (none is needed here).
- 100% test coverage is BLOCKING (`vitest.config.mts` thresholds: statements, branches, functions, lines).
- Runtime deps: only official `@convex-dev/*` + `@vllnt/*`.

## Project rules

The universal vllnt engineering rules ship in `.claude/rules/` — **synced from the
`convex-components` hub** (single source; edit them there, not here):

| Rule | Covers |
|------|--------|
| [`code-style.md`](.claude/rules/code-style.md) | Match-surrounding-code, smallest change that works, typed public APIs |
| [`git-workflow.md`](.claude/rules/git-workflow.md) | Branch-first, signed no-reply commits, landing mode, strict checks |
| [`commit-privacy.md`](.claude/rules/commit-privacy.md) | No-reply commit identity; never leak a personal email |
| [`security.md`](.claude/rules/security.md) | Secrets, boundary validation, OWASP, dependency review |
| [`docs-sync.md`](.claude/rules/docs-sync.md) | **BLOCKING** docs stay current with every commit |

The full BLOCKING Component Standard (file/CI/docs/coverage contract) and fleet governance live in
the hub (`convex-components` `.claude/rules/component-standard.md`) — not duplicated into this repo.

## Docs sync

| Changed | Update in the same commit |
|---------|--------------------------|
| Public API (defineMeter/record/reset/pruneRecords/getMeter/usage/listUsage signatures) | README API Reference table, `docs/API.md`, `llms.txt` context, regenerate `llms-full.txt` |
| Config options / defaults (`defaultScope`, `defaultPeriod`, aggregation) | README API Reference, `docs/API.md` constructor section |
| Schema / tables / indexes | this file (Architecture), README Architecture, `docs/API.md` |
| Error codes | `docs/API.md` → `## Error codes` table |
| `peerDependencies.convex` version | `llms.txt` context line (`convex@^X.Y.Z`), `docs/API.md` Compatibility line, README Installation peer note |
| Aggregation / idempotency / rollup semantics | `docs/API.md`, Key design decisions above |
| Any change | `pnpm generate:llms` to keep `llms-full.txt` current |

Grep old values before committing (e.g. `git grep "1.36.1"` → must be empty).
