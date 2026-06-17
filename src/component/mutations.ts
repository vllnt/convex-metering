import { ConvexError, v } from "convex/values";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./_generated/server";
import { applyAggregation } from "../shared";
import { aggregation, limitResult, recordResult } from "./validators";

/** Load a meter or throw `METER_NOT_FOUND`. */
async function loadMeter(
  ctx: MutationCtx,
  scope: string,
  key: string,
): Promise<Doc<"meters">> {
  const meter = await ctx.db
    .query("meters")
    .withIndex("by_scope_key", (q) => q.eq("scope", scope).eq("key", key))
    .unique();
  if (meter === null) {
    throw new ConvexError({
      code: "METER_NOT_FOUND",
      message: `no meter "${key}" in scope "${scope}" — define it first`,
    });
  }
  return meter;
}

/** The rollup for a `(scope, meter, subject, period)`, or `null`. */
function loadRollup(
  ctx: MutationCtx,
  scope: string,
  meterKey: string,
  subjectRef: string,
  period: string,
): Promise<Doc<"rollups"> | null> {
  return ctx.db
    .query("rollups")
    .withIndex("by_scope_meter_subject_period", (q) =>
      q
        .eq("scope", scope)
        .eq("meterKey", meterKey)
        .eq("subjectRef", subjectRef)
        .eq("period", period),
    )
    .unique();
}

/** Throw `PERIOD_CLOSED` when the rollup exists and its period is frozen. */
function guardOpen(rollup: Doc<"rollups"> | null): void {
  if (rollup !== null && rollup.closedAt !== undefined) {
    throw new ConvexError({
      code: "PERIOD_CLOSED",
      message: "this period is closed; record into the next open period",
    });
  }
}

/**
 * Idempotency check against the dedicated `seen` ledger (NOT `records`, so pruning
 * audit rows never re-opens a duplicate). Returns `true` if this key was already
 * seen; otherwise marks it and returns `false`. A no-op when no key is supplied.
 */
async function dedupe(
  ctx: MutationCtx,
  scope: string,
  meterKey: string,
  idempotencyKey: string | undefined,
  now: number,
): Promise<boolean> {
  if (idempotencyKey === undefined) {
    return false;
  }
  const existing = await ctx.db
    .query("seen")
    .withIndex("by_idem", (q) =>
      q.eq("scope", scope).eq("meterKey", meterKey).eq("idempotencyKey", idempotencyKey),
    )
    .first();
  if (existing !== null) {
    return true;
  }
  await ctx.db.insert("seen", { scope, meterKey, idempotencyKey, seenAt: now });
  return false;
}

/**
 * Create or update a meter definition, keyed by `(scope, key)`. `unit` is a display
 * label and may change freely. `aggregation` is **locked once any rollup exists**
 * for the meter — switching `sum`→`max` mid-flight would leave the rollup computed
 * under two rules. Returns `{ created }`. Time is server-sourced.
 *
 * @throws `ConvexError({ code: "AGGREGATION_LOCKED" })` on an aggregation change
 *   after usage has been recorded — define a new meter key instead.
 */
export const defineMeter = mutation({
  args: { scope: v.string(), key: v.string(), aggregation, unit: v.string() },
  returns: v.object({ created: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("meters")
      .withIndex("by_scope_key", (q) =>
        q.eq("scope", args.scope).eq("key", args.key),
      )
      .unique();
    if (existing === null) {
      await ctx.db.insert("meters", {
        key: args.key,
        scope: args.scope,
        aggregation: args.aggregation,
        unit: args.unit,
        createdAt: Date.now(),
      });
      return { created: true };
    }
    if (existing.aggregation !== args.aggregation) {
      const firstRollup = await ctx.db
        .query("rollups")
        .withIndex("by_scope_meter_subject_period", (q) =>
          q.eq("scope", args.scope).eq("meterKey", args.key),
        )
        .first();
      if (firstRollup !== null) {
        throw new ConvexError({
          code: "AGGREGATION_LOCKED",
          message:
            "a meter's aggregation is immutable once usage exists; define a new meter key",
        });
      }
    }
    await ctx.db.patch(existing._id, {
      aggregation: args.aggregation,
      unit: args.unit,
    });
    return { created: false };
  },
});

/**
 * Record a usage event and advance the rollup per the meter's aggregation. Returns
 * `{ recorded: true, value, count }`, or `{ recorded: false, reason: "duplicate" }`
 * when the `idempotencyKey` was already seen — a retried `record` is a safe no-op,
 * and the dedup survives `pruneRecords`. Time is server-sourced.
 *
 * @throws `INVALID_QUANTITY` (negative/non-finite), `METER_NOT_FOUND`,
 *   `IDEMPOTENCY_NOT_SUPPORTED` (an `idempotencyKey` on a non-`sum` gauge meter),
 *   `PERIOD_CLOSED` (the period was frozen by `closePeriod`).
 */
export const record = mutation({
  args: {
    scope: v.string(),
    meter: v.string(),
    subjectRef: v.string(),
    quantity: v.number(),
    period: v.string(),
    idempotencyKey: v.optional(v.string()),
    actorRef: v.optional(v.string()),
  },
  returns: recordResult,
  handler: async (ctx, args) => {
    if (!(args.quantity >= 0 && isFinite(args.quantity))) {
      throw new ConvexError({
        code: "INVALID_QUANTITY",
        message: "quantity must be a non-negative finite number",
      });
    }
    const meter = await loadMeter(ctx, args.scope, args.meter);
    if (args.idempotencyKey !== undefined && meter.aggregation !== "sum") {
      throw new ConvexError({
        code: "IDEMPOTENCY_NOT_SUPPORTED",
        message: "idempotencyKey is only meaningful for sum meters, not max/last gauges",
      });
    }
    const now = Date.now();
    const rollup = await loadRollup(ctx, args.scope, args.meter, args.subjectRef, args.period);
    guardOpen(rollup);
    if (await dedupe(ctx, args.scope, args.meter, args.idempotencyKey, now)) {
      return { recorded: false as const, reason: "duplicate" as const };
    }
    await ctx.db.insert("records", {
      scope: args.scope,
      meterKey: args.meter,
      subjectRef: args.subjectRef,
      quantity: args.quantity,
      period: args.period,
      idempotencyKey: args.idempotencyKey,
      actorRef: args.actorRef,
      recordedAt: now,
    });
    if (rollup === null) {
      await ctx.db.insert("rollups", {
        scope: args.scope,
        meterKey: args.meter,
        subjectRef: args.subjectRef,
        period: args.period,
        value: args.quantity,
        count: 1,
        updatedAt: now,
      });
      return { recorded: true as const, value: args.quantity, count: 1 };
    }
    const value = applyAggregation(meter.aggregation, rollup.value, args.quantity);
    const count = rollup.count + 1;
    await ctx.db.patch(rollup._id, { value, count, updatedAt: now });
    return { recorded: true as const, value, count };
  },
});

/**
 * Record only if it would not push the period rollup over `limit` — an atomic
 * check-and-record that closes the read-then-write race a host-side `usage()` →
 * `record()` leaves open. Returns the recorded outcome, `{ recorded: false, reason:
 * "duplicate" }`, or `{ recorded: false, reason: "limit_exceeded", value, limit }`.
 *
 * @throws same as `record`.
 */
export const recordWithLimit = mutation({
  args: {
    scope: v.string(),
    meter: v.string(),
    subjectRef: v.string(),
    quantity: v.number(),
    period: v.string(),
    limit: v.number(),
    idempotencyKey: v.optional(v.string()),
    actorRef: v.optional(v.string()),
  },
  returns: limitResult,
  handler: async (ctx, args) => {
    if (!(args.quantity >= 0 && isFinite(args.quantity))) {
      throw new ConvexError({
        code: "INVALID_QUANTITY",
        message: "quantity must be a non-negative finite number",
      });
    }
    const meter = await loadMeter(ctx, args.scope, args.meter);
    if (args.idempotencyKey !== undefined && meter.aggregation !== "sum") {
      throw new ConvexError({
        code: "IDEMPOTENCY_NOT_SUPPORTED",
        message: "idempotencyKey is only meaningful for sum meters, not max/last gauges",
      });
    }
    const now = Date.now();
    const rollup = await loadRollup(ctx, args.scope, args.meter, args.subjectRef, args.period);
    guardOpen(rollup);
    const base = rollup?.value ?? 0;
    const projected = applyAggregation(meter.aggregation, base, args.quantity);
    if (projected > args.limit) {
      return {
        recorded: false as const,
        reason: "limit_exceeded" as const,
        value: base,
        limit: args.limit,
      };
    }
    if (await dedupe(ctx, args.scope, args.meter, args.idempotencyKey, now)) {
      return { recorded: false as const, reason: "duplicate" as const };
    }
    await ctx.db.insert("records", {
      scope: args.scope,
      meterKey: args.meter,
      subjectRef: args.subjectRef,
      quantity: args.quantity,
      period: args.period,
      idempotencyKey: args.idempotencyKey,
      actorRef: args.actorRef,
      recordedAt: now,
    });
    if (rollup === null) {
      await ctx.db.insert("rollups", {
        scope: args.scope,
        meterKey: args.meter,
        subjectRef: args.subjectRef,
        period: args.period,
        value: projected,
        count: 1,
        updatedAt: now,
      });
      return { recorded: true as const, value: projected, count: 1 };
    }
    await ctx.db.patch(rollup._id, {
      value: projected,
      count: rollup.count + 1,
      updatedAt: now,
    });
    return { recorded: true as const, value: projected, count: rollup.count + 1 };
  },
});

/**
 * Post a signed correction to a **`sum`** meter's rollup — a refund, credit, void,
 * or over-count fix — appending a reversing record (`delta` may be negative) and
 * re-folding. The rollup stays equal to the sum of its records and never goes
 * negative. Idempotent via `idempotencyKey`. Time is server-sourced.
 *
 * @throws `INVALID_QUANTITY` (non-finite delta), `METER_NOT_FOUND`,
 *   `ADJUST_REQUIRES_SUM` (non-`sum` meter), `PERIOD_CLOSED`, `ADJUST_BELOW_ZERO`
 *   (the correction would make the rollup negative).
 */
export const adjust = mutation({
  args: {
    scope: v.string(),
    meter: v.string(),
    subjectRef: v.string(),
    delta: v.number(),
    period: v.string(),
    idempotencyKey: v.optional(v.string()),
    actorRef: v.optional(v.string()),
  },
  returns: recordResult,
  handler: async (ctx, args) => {
    if (!isFinite(args.delta)) {
      throw new ConvexError({
        code: "INVALID_QUANTITY",
        message: "delta must be a finite number",
      });
    }
    const meter = await loadMeter(ctx, args.scope, args.meter);
    if (meter.aggregation !== "sum") {
      throw new ConvexError({
        code: "ADJUST_REQUIRES_SUM",
        message: "adjust is only defined for sum meters",
      });
    }
    const now = Date.now();
    const rollup = await loadRollup(ctx, args.scope, args.meter, args.subjectRef, args.period);
    guardOpen(rollup);
    if (await dedupe(ctx, args.scope, args.meter, args.idempotencyKey, now)) {
      return { recorded: false as const, reason: "duplicate" as const };
    }
    const newValue = (rollup?.value ?? 0) + args.delta;
    if (newValue < 0) {
      throw new ConvexError({
        code: "ADJUST_BELOW_ZERO",
        message: "the adjustment would make the rollup negative",
      });
    }
    await ctx.db.insert("records", {
      scope: args.scope,
      meterKey: args.meter,
      subjectRef: args.subjectRef,
      quantity: args.delta,
      period: args.period,
      idempotencyKey: args.idempotencyKey,
      actorRef: args.actorRef,
      recordedAt: now,
    });
    if (rollup === null) {
      await ctx.db.insert("rollups", {
        scope: args.scope,
        meterKey: args.meter,
        subjectRef: args.subjectRef,
        period: args.period,
        value: newValue,
        count: 1,
        updatedAt: now,
      });
      return { recorded: true as const, value: newValue, count: 1 };
    }
    await ctx.db.patch(rollup._id, {
      value: newValue,
      count: rollup.count + 1,
      updatedAt: now,
    });
    return { recorded: true as const, value: newValue, count: rollup.count + 1 };
  },
});

/**
 * Freeze a `(meter, subject, period)` — its billed value becomes immutable, so a
 * late event can't silently restate the invoiced number (`record`/`adjust` into it
 * throw `PERIOD_CLOSED`). Returns `false` when no rollup exists, `true` once frozen.
 */
export const closePeriod = mutation({
  args: {
    scope: v.string(),
    meter: v.string(),
    subjectRef: v.string(),
    period: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const rollup = await loadRollup(ctx, args.scope, args.meter, args.subjectRef, args.period);
    if (rollup === null) {
      return false;
    }
    await ctx.db.patch(rollup._id, { closedAt: Date.now() });
    return true;
  },
});

/**
 * Clear a subject's usage for one `(meter, period)` — deletes the rollup and its
 * raw records in bounded, self-rescheduling batches. Returns the records removed
 * this pass (0 once drained). Idempotency keys in `seen` are NOT cleared, so a late
 * replay stays deduped rather than re-counting after a reset.
 */
export const reset = mutation({
  args: {
    scope: v.string(),
    meter: v.string(),
    subjectRef: v.string(),
    period: v.string(),
    batch: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("records")
      .withIndex("by_scope_meter_subject_period", (q) =>
        q
          .eq("scope", args.scope)
          .eq("meterKey", args.meter)
          .eq("subjectRef", args.subjectRef)
          .eq("period", args.period),
      )
      .take(args.batch);
    for (const row of records) {
      await ctx.db.delete(row._id);
    }
    if (records.length > 0) {
      await ctx.scheduler.runAfter(0, api.mutations.reset, {
        scope: args.scope,
        meter: args.meter,
        subjectRef: args.subjectRef,
        period: args.period,
        batch: args.batch,
      });
      return records.length;
    }
    const rollup = await loadRollup(ctx, args.scope, args.meter, args.subjectRef, args.period);
    if (rollup !== null) {
      await ctx.db.delete(rollup._id);
    }
    return 0;
  },
});

/**
 * Erase a subject across every meter and period — all their records + rollups —
 * in bounded, self-rescheduling batches. The GDPR right-to-erasure primitive.
 * Returns the rows removed this pass (0 once drained). `seen` (idempotency keys,
 * no subject PII) is left intact.
 */
export const eraseSubject = mutation({
  args: { scope: v.string(), subjectRef: v.string(), batch: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    let removed = 0;
    const records = await ctx.db
      .query("records")
      .withIndex("by_scope_subject", (q) =>
        q.eq("scope", args.scope).eq("subjectRef", args.subjectRef),
      )
      .take(args.batch);
    for (const row of records) {
      await ctx.db.delete(row._id);
      removed++;
    }
    const rollups = await ctx.db
      .query("rollups")
      .withIndex("by_scope_subject", (q) =>
        q.eq("scope", args.scope).eq("subjectRef", args.subjectRef),
      )
      .take(args.batch);
    for (const row of rollups) {
      await ctx.db.delete(row._id);
      removed++;
    }
    if (removed > 0) {
      await ctx.scheduler.runAfter(0, api.mutations.eraseSubject, {
        scope: args.scope,
        subjectRef: args.subjectRef,
        batch: args.batch,
      });
    }
    return removed;
  },
});

/**
 * Delete up to `batch` raw records whose `recordedAt < before`, oldest first.
 * Rollups (the billable truth) and `seen` (dedup keys) are never touched, so
 * pruning audit cannot re-open a duplicate. `before` is required. Bounded +
 * self-rescheduling. Returns the count removed this pass.
 */
export const pruneRecords = mutation({
  args: { before: v.number(), batch: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const stale = await ctx.db
      .query("records")
      .withIndex("by_recorded", (q) => q.lt("recordedAt", args.before))
      .take(args.batch);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
    if (stale.length === args.batch) {
      await ctx.scheduler.runAfter(0, api.mutations.pruneRecords, {
        before: args.before,
        batch: args.batch,
      });
    }
    return stale.length;
  },
});

/**
 * Delete up to `batch` idempotency keys whose `seenAt < before`, oldest first.
 * Set `before` older than your longest delivery/retry window — pruning a key
 * re-opens its replay. Bounded + self-rescheduling. Returns the count removed.
 */
export const pruneSeen = mutation({
  args: { before: v.number(), batch: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const stale = await ctx.db
      .query("seen")
      .withIndex("by_seen", (q) => q.lt("seenAt", args.before))
      .take(args.batch);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
    if (stale.length === args.batch) {
      await ctx.scheduler.runAfter(0, api.mutations.pruneSeen, {
        before: args.before,
        batch: args.batch,
      });
    }
    return stale.length;
  },
});
