import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { applyAggregation } from "../shared";
import {
  meterDef,
  subjectUsageEntry,
  usageEntry,
  usageProjection,
  verifyResult,
} from "./validators";

/** The meter definition for `(scope, key)`, or `null` if none exists. */
export const getMeter = query({
  args: { scope: v.string(), key: v.string() },
  returns: v.union(v.null(), meterDef),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("meters")
      .withIndex("by_scope_key", (q) =>
        q.eq("scope", args.scope).eq("key", args.key),
      )
      .unique();
    if (row === null) {
      return null;
    }
    return {
      key: row.key,
      scope: row.scope,
      aggregation: row.aggregation,
      unit: row.unit,
      createdAt: row.createdAt,
    };
  },
});

/** Every meter defined in a scope — the discovery / management surface. */
export const listMeters = query({
  args: { scope: v.string() },
  returns: v.array(meterDef),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("meters")
      .withIndex("by_scope", (q) => q.eq("scope", args.scope))
      .collect();
    return rows.map((row) => ({
      key: row.key,
      scope: row.scope,
      aggregation: row.aggregation,
      unit: row.unit,
      createdAt: row.createdAt,
    }));
  },
});

/**
 * A subject's rolled-up usage for one `(meter, period)`: `{ value, count, closed }`,
 * or `null` if nothing has been recorded. The O(1) read for billing / limit checks.
 */
export const usage = query({
  args: {
    scope: v.string(),
    meter: v.string(),
    subjectRef: v.string(),
    period: v.string(),
  },
  returns: v.union(v.null(), usageProjection),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("rollups")
      .withIndex("by_scope_meter_subject_period", (q) =>
        q
          .eq("scope", args.scope)
          .eq("meterKey", args.meter)
          .eq("subjectRef", args.subjectRef)
          .eq("period", args.period),
      )
      .unique();
    if (row === null) {
      return null;
    }
    return { value: row.value, count: row.count, closed: row.closedAt !== undefined };
  },
});

/** Every period's rolled-up usage for a subject on a meter. */
export const listUsage = query({
  args: { scope: v.string(), meter: v.string(), subjectRef: v.string() },
  returns: v.array(usageEntry),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("rollups")
      .withIndex("by_scope_meter_subject_period", (q) =>
        q
          .eq("scope", args.scope)
          .eq("meterKey", args.meter)
          .eq("subjectRef", args.subjectRef),
      )
      .collect();
    return rows.map((row) => ({
      period: row.period,
      value: row.value,
      count: row.count,
      closed: row.closedAt !== undefined,
    }));
  },
});

/** Every meter+period rollup for a subject across the scope (invoice line items). */
export const listSubjectUsage = query({
  args: { scope: v.string(), subjectRef: v.string() },
  returns: v.array(subjectUsageEntry),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("rollups")
      .withIndex("by_scope_subject", (q) =>
        q.eq("scope", args.scope).eq("subjectRef", args.subjectRef),
      )
      .collect();
    return rows.map((row) => ({
      meter: row.meterKey,
      period: row.period,
      value: row.value,
      count: row.count,
      closed: row.closedAt !== undefined,
    }));
  },
});

/**
 * Reconcile the materialized rollup against the surviving raw records for a
 * `(meter, subject, period)`: recomputes the value by re-folding the records under
 * the meter's aggregation and compares. `consistent` is `rollupValue ===
 * recomputedValue`; trust it only when `recordsRemaining > 0` (pruned history
 * cannot be fully recomputed). The reconciliation guardrail for billing audits.
 *
 * @throws `ConvexError({ code: "METER_NOT_FOUND" })`.
 */
export const verify = query({
  args: {
    scope: v.string(),
    meter: v.string(),
    subjectRef: v.string(),
    period: v.string(),
  },
  returns: verifyResult,
  handler: async (ctx, args) => {
    const meter = await ctx.db
      .query("meters")
      .withIndex("by_scope_key", (q) =>
        q.eq("scope", args.scope).eq("key", args.meter),
      )
      .unique();
    if (meter === null) {
      throw new ConvexError({
        code: "METER_NOT_FOUND",
        message: `no meter "${args.meter}" in scope "${args.scope}"`,
      });
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
    let recomputed = 0;
    let first = true;
    for (const row of records) {
      if (first) {
        recomputed = row.quantity;
        first = false;
      } else {
        recomputed = applyAggregation(meter.aggregation, recomputed, row.quantity);
      }
    }
    const rollupValue = rollup?.value ?? 0;
    return {
      rollupValue,
      rollupCount: rollup?.count ?? 0,
      recomputedValue: recomputed,
      recordsRemaining: records.length,
      consistent: rollupValue === recomputed,
    };
  },
});
