# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `adjust` — signed corrections (refund/credit/void) on `sum` meters; appends a reversing record,
  keeps the rollup equal to the sum of records and never negative (`ADJUST_BELOW_ZERO`).
- `recordWithLimit` — atomic check-and-record against a `limit` (closes the read-then-write overage
  race); returns `limit_exceeded` without recording when it would cross.
- `closePeriod` + `closed` on the usage reads — freeze a billed period so a late event can't restate
  it (`record`/`adjust`/`recordWithLimit` then throw `PERIOD_CLOSED`).
- `eraseSubject` (GDPR, across all meters/periods), `listMeters`, `listSubjectUsage`, and `verify`
  (reconcile the rollup against surviving records). `reset` is now bounded + self-rescheduling
  (returns a count) and `pruneSeen` prunes the idempotency ledger. Optional `actorRef` on records.

### Changed

- **Idempotency dedup moved to a dedicated `seen` table.** A meter's aggregation is now **locked**
  once usage exists (`AGGREGATION_LOCKED`), and an `idempotencyKey` on a non-`sum` gauge is rejected
  (`IDEMPOTENCY_NOT_SUPPORTED`).

### Fixed

- **Prune-vs-dedup double-count.** Dedup previously read the `records` table that `pruneRecords`
  deletes, so a redelivered event after a prune re-counted the billable rollup. Dedup now lives in the
  separate `seen` ledger (pruned independently via `pruneSeen`), so pruning audit rows never re-opens
  a duplicate. The earlier docs ("retried record is a safe no-op", "rollups never touched") implied
  prune was consequence-free; corrected.

## [0.1.0] - 2026-06-17

### Added

- First release of `@vllnt/convex-metering`.
- `defineMeter` registers a meter with a per-meter aggregation rule (`sum` | `max` | `last`) and a
  display unit; `record` writes a usage event and folds it into the `(meter, subject, period)`
  rollup on write.
- Idempotent recording: passing an `idempotencyKey` makes a retried `record` a safe no-op
  (`{ recorded: false, reason: "duplicate" }`), so at-least-once delivery never double-counts.
- Records + rollups split: raw `records` are the append-only audit trail and idempotency source;
  `rollups` are the O(1) per-period read for billing and limit checks (the billable truth, never
  pruned).
- `usage` / `listUsage` read a subject's rollups; `reset` clears one `(meter, subject, period)`.
- `pruneRecords` deletes raw records older than a **required** `before` cutoff (no default-to-now
  footgun), bounded and self-rescheduling; rollups are untouched.
- `period` is a host-supplied opaque string — the component never parses dates, keeping it locale-
  and calendar-agnostic. Scopes namespace meters per tenant; server-sourced timestamps throughout.
- Fully typed end to end — quantities, periods, units, and refs are concrete types; no `v.any()`.
- `record` rejects a negative or non-finite `quantity` with `INVALID_QUANTITY`, and an undefined
  meter with `METER_NOT_FOUND`.
