import { ConvexError, v } from "convex/values";
import { api } from "./_generated/api";
import { mutation } from "./_generated/server";
import { applyAggregation } from "../shared";
import { aggregation, recordResult } from "./validators";

/**
 * Create or update a meter definition, keyed by `(scope, key)`. `aggregation`
 * fixes how successive quantities fold into a period value (`sum` | `max` |
 * `last`); `unit` is a display label. Returns `{ created: true }` on insert,
 * `{ created: false }` on update. Time is server-sourced.
 */
export const defineMeter = mutation({
  args: {
    scope: v.string(),
    key: v.string(),
    aggregation,
    unit: v.string(),
  },
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
    await ctx.db.patch(existing._id, {
      aggregation: args.aggregation,
      unit: args.unit,
    });
    return { created: false };
  },
});

/**
 * Record a usage event for `subjectRef` against `meter` in `period`, advancing the
 * materialized rollup per the meter's aggregation. Returns `{ recorded: true,
 * value, count }` with the new period rollup, or `{ recorded: false, reason:
 * "duplicate" }` when an event with the same `idempotencyKey` was already recorded
 * — making a retried `record` a safe no-op. Time is server-sourced.
 *
 * @throws `ConvexError({ code: "INVALID_QUANTITY" })` when `quantity` is negative
 *   or non-finite.
 * @throws `ConvexError({ code: "METER_NOT_FOUND" })` when no meter is defined for
 *   `(scope, meter)` — define it first with `defineMeter`.
 */
export const record = mutation({
  args: {
    scope: v.string(),
    meter: v.string(),
    subjectRef: v.string(),
    quantity: v.number(),
    period: v.string(),
    idempotencyKey: v.optional(v.string()),
  },
  returns: recordResult,
  handler: async (ctx, args) => {
    if (!(args.quantity >= 0 && isFinite(args.quantity))) {
      throw new ConvexError({
        code: "INVALID_QUANTITY",
        message: "quantity must be a non-negative finite number",
      });
    }

    const meter = await ctx.db
      .query("meters")
      .withIndex("by_scope_key", (q) =>
        q.eq("scope", args.scope).eq("key", args.meter),
      )
      .unique();
    if (meter === null) {
      throw new ConvexError({
        code: "METER_NOT_FOUND",
        message: `no meter "${args.meter}" in scope "${args.scope}" — define it first`,
      });
    }

    const now = Date.now();

    if (args.idempotencyKey !== undefined) {
      const duplicate = await ctx.db
        .query("records")
        .withIndex("by_idem", (q) =>
          q
            .eq("scope", args.scope)
            .eq("meterKey", args.meter)
            .eq("idempotencyKey", args.idempotencyKey),
        )
        .first();
      if (duplicate !== null) {
        return { recorded: false as const, reason: "duplicate" as const };
      }
    }

    await ctx.db.insert("records", {
      scope: args.scope,
      meterKey: args.meter,
      subjectRef: args.subjectRef,
      quantity: args.quantity,
      period: args.period,
      idempotencyKey: args.idempotencyKey,
      recordedAt: now,
    });

    const rollup = await ctx.db
      .query("rollups")
      .withIndex("by_scope_meter_subject_period", (q) =>
        q
          .eq("scope", args.scope)
          .eq("meterKey", args.meter)
          .eq("subjectRef", args.subjectRef)
          .eq("period", args.period),
      )
      .unique();

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
 * Clear a subject's usage for one `(meter, period)` — deletes the rollup and every
 * raw record behind it. Returns `true` when a rollup existed, `false` otherwise.
 * For period corrections or a manual reset; it never touches other periods.
 */
export const reset = mutation({
  args: {
    scope: v.string(),
    meter: v.string(),
    subjectRef: v.string(),
    period: v.string(),
  },
  returns: v.boolean(),
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
      .collect();
    for (const row of records) {
      await ctx.db.delete(row._id);
    }
    const rollup = await ctx.db
      .query("rollups")
      .withIndex("by_scope_meter_subject_period", (q) =>
        q
          .eq("scope", args.scope)
          .eq("meterKey", args.meter)
          .eq("subjectRef", args.subjectRef)
          .eq("period", args.period),
      )
      .unique();
    if (rollup === null) {
      return false;
    }
    await ctx.db.delete(rollup._id);
    return true;
  },
});

/**
 * Delete up to `batch` raw records whose `recordedAt < before`, oldest first via
 * the `by_recorded` index, and return the count removed in the first pass. Rollups
 * — the billable truth — are never touched. `before` is required (no default), so
 * a caller cannot accidentally prune everything by passing "now"; the host owns
 * its retention window. If a full batch was removed the sweep self-reschedules
 * until the tail is clean. Idempotent.
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
