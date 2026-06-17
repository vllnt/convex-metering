# Roadmap — @vllnt/convex-metering

This component's own roadmap. Phases are immutable kebab-case **outcome slugs**; tasks have stable
`slug.N` IDs. History is never deleted — completed and dropped work stays for the record.

**Status vocabulary:** `planned` · `in-progress` · `done` · `blocked` · `dropped`

> Hub-level milestones (creation, fleet programs, the canary→stable hold) live in the
> `vllnt/convex-components` hub `ROADMAP.md`. This file tracks only this package's own work.

---

## ship-metered-records — `done`

Idempotent usage records + per-period rollups, shipped at 0.1.0 (canary).

- `ship-metered-records.1` — `done` — `defineMeter` with per-meter aggregation (`sum`/`max`/`last`) + display unit.
- `ship-metered-records.2` — `done` — `record`: idempotent (`idempotencyKey` no-op), `INVALID_QUANTITY` / `METER_NOT_FOUND` validation, rollup folded on write.
- `ship-metered-records.3` — `done` — records + rollups split (raw audit/idempotency source vs O(1) billable rollup); `usage` / `listUsage` reads.
- `ship-metered-records.4` — `done` — `reset` one `(meter, subject, period)`; `pruneRecords` (required cutoff, bounded, self-rescheduling, rollups preserved).
- `ship-metered-records.5` — `done` — scope namespacing; host-supplied opaque `period`; server-sourced time.
- `ship-metered-records.6` — `done` — 100% E2E coverage via the `example/` host harness (happy + adversarial); lint/typecheck/build green.
- `ship-metered-records.7` — `done` — standard repo: CI, canary `publish.yml`, docs set, `.claude/rules`, repo hardening.

## harden-billing-correctness — `done`

Implemented from the 2026-06-17 multi-perspective review (5 reviewers). Shipped at 0.1.0 (canary),
100% coverage maintained.

- `harden-billing-correctness.1` — `done` — **decoupled dedup**: idempotency keys live in a dedicated `seen` table (not `records`), so `pruneRecords` can no longer re-open a duplicate and double-count the billable rollup; `pruneSeen` retains keys on an independent cutoff.
- `harden-billing-correctness.2` — `done` — **`closePeriod` + `closedAt`**: freeze a billed period (`PERIOD_CLOSED` on later writes) so a late event can't restate the invoiced number.
- `harden-billing-correctness.3` — `done` — **`adjust`** (signed sum-only corrections, never below zero, idempotent) — refunds/credits/voids without nuking the period.
- `harden-billing-correctness.4` — `done` — **`recordWithLimit`** (atomic check-and-record, closes the read-then-write overage race); **`AGGREGATION_LOCKED`** (no mid-flight aggregation switch); **`IDEMPOTENCY_NOT_SUPPORTED`** (no idempotency on gauges).
- `harden-billing-correctness.5` — `done` — **lifecycle + GDPR**: batched `reset`, `eraseSubject`, `listMeters` / `listSubjectUsage` discovery, `verify` (reconcile rollup vs records), optional `actorRef` audit field; integer-minor-unit precision documented.

> Deferred to later phases (design-sized): the `./react` `useUsage` hook (`reactive-usage-surface`),
> an opt-in calendar-agnostic `./period` helper, a self-driving retention cron, and sharded-counter
> write-sharding for high-throughput rollups (`retention-and-scale`).

## reactive-usage-surface — `planned`

Optional `./react` tooling, decided by the front-tooling analysis once a real consumer needs a live
usage read.

- `reactive-usage-surface.1` — `planned` — re-run the front-tooling usage analysis when the first consumer lands.
- `reactive-usage-surface.2` — `planned` — `useUsage` hook (a live "8,200 / 10,000 this period" meter) over a re-exported host ref; render-tested + coverage-included; tree-shakeable optional peer deps.

## billing-integration — `planned`

Make metered usage easy to bill from, without owning pricing.

- `billing-integration.1` — `planned` — a documented pattern / helper for joining a period's rollup to a host price (the host owns rates).
- `billing-integration.2` — `planned` — evaluate composing `@convex-dev/aggregate` for cross-subject/period totals at scale (fleet-wide usage reporting) vs per-subject rollups.
- `billing-integration.3` — `done` — period-close / freeze to snapshot a billed period immutably (shipped as `closePeriod`; see `harden-billing-correctness.2`).

## retention-and-scale — `planned`

Bound growth and keep reads O(1) as records accumulate.

- `retention-and-scale.1` — `planned` — optional retention helper / documented cron pattern around `pruneRecords` (host-driven cutoff).
- `retention-and-scale.2` — `planned` — guard `listUsage` against unbounded period scans for very long-lived subjects (pagination or capped windows).

## first-stable-release — `blocked`

Promote 0.1.0 (canary) to the first stable release.

- `first-stable-release.1` — `blocked` — needs a real 2nd consumer to satisfy the hub Rule of Three (0.1.0 shipped as an owner-sanctioned override of the graduation hold; the metering boundary vs quota/wallet/aggregate must hold across both consumers).
- `first-stable-release.2` — `blocked` — depends on `reactive-usage-surface` + `billing-integration` settling the public API before a 1.0.0 commitment.
