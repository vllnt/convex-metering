# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-28

### Changed

- **Breaking:** `defineMeter` (`scope`, `key`) and `record`, `recordWithLimit` and `adjust` (`scope`,
  `meter`, `subjectRef`, `period`, `idempotencyKey`, `actorRef`) reject an empty string with
  `ConvexError({ code: "INVALID_ARGUMENT" })` (`<name> must not be an empty string`); 0.1.0 accepted
  it and bucketed the usage under the empty key. Omit an optional field instead of passing `""`,
  and check that `defaultScope` and `defaultPeriod` are not `""`.
- **Breaking:** `defineMeter` (`scope`, `key`, `unit`) and `record`, `recordWithLimit` and `adjust`
  (`scope`, `meter`, `subjectRef`, `period`, `idempotencyKey`, `actorRef`) reject a string longer
  than 256 UTF-16 code units (JavaScript `.length`) with `ConvexError({ code: "INVALID_ARGUMENT" })`
  (`<name> must be at most 256 characters`), bounding stored row and index-key size. Keep these
  identifiers at most 256 characters, or hash longer ones in the host. For `idempotencyKey`, hash
  only keys of new events: a retry of an event first recorded with a longer key throws
  `INVALID_ARGUMENT`; treat that as already counted, or wait until such retries stop, before
  switching to hashed keys, since a hashed key does not match the stored one and would count the
  event again. Rows an older version stored with a longer value stay readable (`getMeter`,
  `listMeters`, `usage`, `listUsage`, `listSubjectUsage`, `verify`) and erasable (`closePeriod`,
  `reset`, `eraseSubject`, `pruneRecords`, `pruneSeen` are not capped), but recording, adjusting or
  redefining (`defineMeter`) them throws, so move that usage to a shorter meter key or subject.
  Switch at a period boundary, or add both rollups together when billing or enforcing a limit for
  that period: the old and new rollups are separate rows, `recordWithLimit` checks only the new one,
  and `usage` and `closePeriod` see only one.
- **Breaking:** `record` and `adjust` throw `QUANTITY_OVERFLOW` when a `sum` rollup would overflow
  to `Infinity` and leave the rollup unchanged; 0.1.0 stored `Infinity`, which no correction could
  undo. Check the input for a unit or loop bug.
- **Breaking:** `engines.node` is now `>=20` (was `>=18`), the minimum the lowest supported `convex`
  peer (1.45.0) declares; use Node.js 20 or newer. The `convex` peer range (`^1.45.0`) is unchanged.
- `reset` deletes the rollup in the pass that finds fewer than `batch` records (0.1.0 deleted it
  only in a pass that found none, so it always scheduled one more pass), and `reset` and
  `eraseSubject` schedule a follow-up pass only after a full batch. `defineMeter` skips the write
  when nothing changed, and `recordWithLimit` reads the idempotency ledger once.
- The npm package ships `docs/API.md`, `CHANGELOG.md` and `llms.txt`, so the docs under
  `node_modules/@vllnt/convex-metering/` match the installed version, and no longer ships test files
  under `src/`.
- Rewritten docs: the README has a quick start, an export table, every error code and message with
  its fix, a limits list (including the order of list results and the Convex conflict error on one
  very busy rollup) and the test tooling setup (`convex-test` 0.0.72+ needs `convex@^1.46.0`);
  `docs/API.md` has one heading per export and every entry point, including the `.js` aliases;
  `llms.txt` is refreshed, and every public export has TSDoc. `homepage` is
  https://oss.vllnt.com/packages/convex-metering, and the `description` and `keywords` describe
  usage metering, limits, period close and corrections.
- Releases are published only from CI with npm provenance: every push to `main` publishes a
  `canary` build, which never moves `latest`, and `latest` comes from a `vX.Y.Z` tag.
- Internal: CI, tooling and tests (pnpm 10 with a 7-day release-age gate, pinned actions,
  development on `convex` 1.51 and Vitest 5, a docs check, a test of the packed tarball, and a
  behaviour and failure test for every public function).

### Fixed

- `closePeriod` on an already-closed period is a no-op that keeps the original freeze time instead
  of rewriting it.
- `useUsage` clamps `fraction` to its documented `0..1` range when usage is over the limit.
- `@vllnt/convex-metering/test` now type-checks under `moduleResolution: nodenext` (explicit `.js`
  relative imports, Vite client types referenced).
- Client and React hook option types accept an explicit `undefined` for optional fields
  (`period?: string | undefined`, …), so hosts using `exactOptionalPropertyTypes` can pass optional
  args straight through.
- `register()` from `/test` accepts a host app's `convexTest(hostSchema, modules)` instance. It was
  typed against the component's own schema, so any host schema with other tables failed with TS2345.

## [0.1.0] - 2026-09-01

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
- Optional `@vllnt/convex-metering/react` entry — `useUsage` (a live usage meter deriving
  `remaining`/`fraction`/`exceeded` from an optional `limit`) and `useUsageList`. Thin `useQuery`
  wrappers over the host's re-exported refs; `react` is an optional peer dep; render-tested in jsdom at 100%.
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
- Treat Convex `_generated` output as CLI-owned and expose a dedicated codegen script.
- Require `convex@^1.45.0`.

### Fixed

- **Prune-vs-dedup double-count.** Dedup previously read the `records` table that `pruneRecords`
  deletes, so a redelivered event after a prune re-counted the billable rollup. Dedup now lives in the
  separate `seen` ledger (pruned independently via `pruneSeen`), so pruning audit rows never re-opens
  a duplicate. The earlier docs ("retried record is a safe no-op", "rollups never touched") implied
  prune was consequence-free; corrected.
- Return `duplicate` before quota projection for retried limited records, even when later usage
  would now exceed the supplied limit.
- Reject negative or non-finite quota limits and unsafe maintenance batch/cutoff values, preventing
  stalled self-scheduling loops and oversized transactions.
