# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - Unreleased

### Fixed

- `closePeriod` on an already-closed period is a no-op that keeps the original freeze time instead
  of rewriting it.
- Reject a `sum` rollup that would overflow to `Infinity` (`QUANTITY_OVERFLOW`) in `record` and
  `adjust`; previously the rollup silently became `Infinity` and could not be corrected.
- **Breaking:** Reject empty-string identifiers (`scope` and `key` on `defineMeter`; `scope`, `meter`,
  `subjectRef`, `period`, `idempotencyKey` and `actorRef` on `record`, `recordWithLimit` and `adjust`)
  with `ConvexError({ code: "INVALID_ARGUMENT" })` instead of silently bucketing usage under an empty
  key. Callers passing an empty string, which 0.1.0 accepted, now get a `ConvexError` instead of
  success.
- `useUsage` clamps `fraction` to its documented `0..1` range when usage is over the limit.
- `@vllnt/convex-metering/test` now type-checks under `moduleResolution: nodenext` (explicit `.js`
  relative imports, Vite client types referenced).
- Client and React hook option types accept an explicit `undefined` for optional fields
  (`period?: string | undefined`, …), so hosts using `exactOptionalPropertyTypes` can pass optional
  args straight through.
- `register()` from `/test` accepts a host app's `convexTest(hostSchema, modules)` instance. It was
  typed against the component's own schema, so any host schema with other tables failed with TS2345.

### Changed

- Fewer billed calls and writes: `reset` and `eraseSubject` schedule a follow-up pass only when a
  batch was full; `defineMeter` skips the write when nothing changed; `recordWithLimit` reads the
  idempotency ledger once.
- Clarify installation, usage, and idempotency documentation; retain `llms.txt` as the single
  maintained LLM index and remove the generated `llms-full.txt` bundle. Document the `/test` entry
  and the full error-code table.
- Releases run only from CI: canary from `main`, `@latest` from a `vX.Y.Z` tag, with npm trusted
  publishing and provenance. pnpm 10 with a release-age gate; deepmerge-ts override pinned to 8.0.2.
- The npm package now ships `docs/API.md`, `CHANGELOG.md` and `llms.txt`, so the docs under
  `node_modules/@vllnt/convex-metering/` match the installed version. `llms.txt` links shipped files
  relatively; `docs/API.md` documents every entry point, the React hooks and the `/test` helper, and
  lists `key` and `actorRef` under `INVALID_ARGUMENT`; `reset` and `eraseSubject` are documented to
  delete closed periods, and the `verify`/`adjust` code comments no longer overstate what a positive
  `recordsRemaining` proves. `pnpm lint` fails when a required file is missing from the tarball or a
  shipped doc links outside it. `homepage` points to https://oss.vllnt.com/packages/convex-metering.
- Every push to `main` that changes the package or its shipped docs publishes a `canary`; a
  repository variable no longer gates it. Canaries never move `latest`.
- Develop and test against `convex` 1.51 and `convex-test` 0.0.73, and move the development
  toolchain to ESLint 10, jsdom 31, `@vllnt/typescript` 3 and Vitest 5.1.1 (dev-only); pin the
  `minimatch` (11.0.9) and `handlebars` (4.7.10) dev overrides. The `convex` peer range (`^1.45.0`)
  is unchanged. Under `@vllnt/typescript` 3 (`exactOptionalPropertyTypes`), the client and
  component omit an unset `idempotencyKey` or `actorRef` instead of passing `undefined`; stored data
  is unchanged.
  `typecheck:ci` also type-checks the example host app.

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
