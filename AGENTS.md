<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `example/convex/_generated/ai/guidelines.md` first** for
important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->

# @vllnt/convex-metering

Metered usage records — idempotent usage events rolled up per billing period, as a Convex component.
It follows the vllnt Component Standard (see the `oss-packages` hub
`.claude/rules/component-standard.md`).

## Architecture

```
src/
├── shared.ts              # constants + the pure aggregation rule (applyAggregation)
├── test.ts                # convex-test register() helper
├── react/
│   └── index.tsx          # optional ./react hooks (useUsage, useUsageList)
├── client/
│   ├── index.ts           # Metering class (consumer-facing API)
│   └── types.ts           # public TypeScript interfaces
└── component/
    ├── schema.ts           # sandboxed tables: meters, records, seen, rollups
    ├── convex.config.ts    # defineComponent("metering")
    ├── mutations.ts        # defineMeter, record, recordWithLimit, adjust, closePeriod,
    │                       #   reset, eraseSubject, pruneRecords, pruneSeen
    ├── queries.ts          # getMeter, listMeters, usage, listUsage, listSubjectUsage, verify
    └── validators.ts       # shared validators (aggregation, recordResult, limitResult, …)
```

Sandboxed tables, no host tables touched:

- `meters`  — the definition (`aggregation` rule + display `unit`), unique per `(scope, key)`.
- `records` — append-only raw usage events (the audit trail; carries optional `actorRef`).
- `seen`    — the idempotency-key ledger, **separate from `records`** so pruning audit rows never
  re-opens a duplicate.
- `rollups` — the materialized per-`(meter, subject, period)` aggregate; the O(1) read and the
  billable truth (never pruned). `closedAt` freezes a billed period.

## Ownership boundary

**Component owns:**

- The four tables — meter definitions, raw records, the `seen` dedup ledger, materialized rollups
- The aggregation rule per meter (`sum` | `max` | `last`, locked once usage exists) and the rollup math
- Idempotent recording — dedup against `seen` survives `pruneRecords`
- Period-bounded accounting + period freeze (`closePeriod`); corrections (`adjust`); atomic
  enforcement (`recordWithLimit`); reconciliation (`verify`)
- Lifecycle — batched `reset`, GDPR `eraseSubject`, `pruneRecords` + `pruneSeen`
- Validation + server-sourced time

**Host owns:**

- The meter keys and what a unit means (a request, a GB, a seat)
- `subjectRef` / `actorRef` — opaque identity strings; the component never assumes their shape
- `period` — an opaque bucket string; the host owns the calendar/timezone, the component never parses dates
- **Pricing** — turning a period's usage into a bill happens in the host's own tables at the host's rate
- **Precision** — record integer minor-units (bytes, mills) for exact money; `sum` accumulates in f64
- Retention — driving `pruneRecords`/`pruneSeen` with cutoffs; rollups are never pruned
- Auth and authorization — who may define, record, adjust, close, reset, erase, or read

**Auth:** the component is completely auth-agnostic; the host gates every call. `subjectRef` is not
authenticated — a caller can read/write any subject's usage, so the host MUST verify ownership.

## Key design decisions

- **Idempotency is decoupled from record pruning (`seen` table):** dedup is checked against a dedicated
  `seen` ledger, not `records`, so `pruneRecords` deleting raw audit rows can never re-open a
  duplicate and double-count the billable rollup. `seen` has its own retention via `pruneSeen` — set
  its cutoff older than your longest delivery/retry window. (Earlier docs implied prune was
  consequence-free; with a shared dedup-on-records table it wasn't — this fixes it.)

- **Period freeze (`closePeriod`):** marks a `(meter, subject, period)` rollup `closedAt`; `record` /
  `adjust` / `recordWithLimit` into a frozen period throw `PERIOD_CLOSED`, so a late event can't
  silently restate an already-invoiced number.

- **Signed corrections (`adjust`, sum-only):** refunds/credits/voids post a signed `delta` (may be
  negative) that appends a reversing record and re-folds. The rollup stays equal to the sum of its
  records and never goes negative (`ADJUST_BELOW_ZERO` otherwise) — so `verify` reconciles.

- **Atomic enforcement (`recordWithLimit`):** checks the projected rollup against a `limit` and records
  in one serializable mutation, closing the read-then-write race a host-side `usage()` → `record()`
  leaves open. Returns `limit_exceeded` without recording when it would cross.

- **Aggregation locked once usage exists (`AGGREGATION_LOCKED`):** `unit` may change; `aggregation`
  may not (switching `sum`→`max` mid-flight would leave the rollup computed under two rules). Define a
  new meter key instead.

- **Counters vs gauges:** `idempotencyKey` is meaningful only for `sum` counters; on a `max`/`last`
  gauge it throws `IDEMPOTENCY_NOT_SUPPORTED` (dedup-skipping a gauge reading is incoherent).

- **Records + rollups split:** raw `records` are the append-only audit trail; `rollups` are the O(1)
  per-period aggregate and the billable truth (never pruned). `verify` recomputes the rollup from the
  surviving records and flags drift (`consistent`, trustworthy only when `recordsRemaining > 0`).

- **`period` is a host-supplied opaque string:** the component never parses dates — locale/calendar-agnostic.

- **Lifecycle is bounded + self-rescheduling:** `reset` (one meter/period) and `eraseSubject` (GDPR,
  all meters/periods for a subject) delete in batches and self-reschedule; `reset` keeps the subject's
  `seen` keys so a late replay stays deduped rather than re-counting.

- **Metering is not a gate, a balance, or a raw aggregate** — distinct from a rate-limiter, a wallet,
  and a generic counter; those compose around it.

- **Fully typed, zero `v.any()`; server-sourced time.**

- **Optional `./react` front-tooling:** `useUsage` (a live "8,200 / 10,000 this period" meter — derives
  `remaining`/`fraction`/`exceeded` from an optional `limit`) and `useUsageList` wrap `useQuery` over the
  host's **re-exported** query refs — the component never owns the host `api`. `react` is an optional
  peer dep; the hooks are render-tested in jsdom at 100%. No-leak: only the caller's own usage metadata.

## Conventions

- Mutations in `mutations.ts`, queries in `queries.ts` (enforced by `@vllnt/eslint-config/convex`).
- Explicit `args` + `returns` on every Convex function.
- Concrete typed args throughout — no `v.any()` dumps (none is needed here).
- 100% test coverage is BLOCKING (`vitest.config.mts` thresholds: statements, branches, functions, lines).
- Runtime deps: only official `@convex-dev/*` + `@vllnt/*`.

## Project rules

The universal vllnt engineering rules ship in `.claude/rules/` — **synced from the
`oss-packages` hub** (single source; edit them there, not here):

| Rule | Covers |
|------|--------|
| [`code-style.md`](.claude/rules/code-style.md) | Match-surrounding-code, smallest change that works, typed public APIs |
| [`git-workflow.md`](.claude/rules/git-workflow.md) | Branch-first, signed no-reply commits, landing mode, strict checks |
| [`commit-privacy.md`](.claude/rules/commit-privacy.md) | No-reply commit identity; never leak a personal email |
| [`security.md`](.claude/rules/security.md) | Secrets, boundary validation, OWASP, dependency review |
| [`docs-sync.md`](.claude/rules/docs-sync.md) | **BLOCKING** docs stay current with every commit |

The full BLOCKING Component Standard (file/CI/docs/coverage contract) and fleet governance live in
the hub (`oss-packages` `.claude/rules/component-standard.md`) — not duplicated into this repo.

## Docs sync

| Changed | Update in the same commit |
|---------|--------------------------|
| Public API (defineMeter/record/recordWithLimit/adjust/closePeriod/reset/eraseSubject/prune*/getMeter/listMeters/usage/listUsage/listSubjectUsage/verify) | README API Reference table, `docs/API.md`, `llms.txt` context |
| Config options / defaults (`defaultScope`, `defaultPeriod`, aggregation, batch) | README API Reference, `docs/API.md` constructor section |
| Schema / tables / indexes | this file (Architecture), README Architecture, `docs/API.md` |
| Error codes | `docs/API.md` → `## Error codes` table |
| `peerDependencies.convex` version | `llms.txt` context line (`convex@^X.Y.Z`), `docs/API.md` Compatibility line, README Installation peer note |
| Aggregation / idempotency / period / adjust / rollup semantics | `docs/API.md`, Key design decisions above |

Grep old values before committing (e.g. `git grep "1.36.1"` → must be empty).
