import { v } from "convex/values";
import { query } from "./_generated/server";
import { meterDef, usageEntry, usageProjection } from "./validators";

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

/**
 * A subject's rolled-up usage for one `(meter, period)`: `{ value, count }`, or
 * `null` if nothing has been recorded. This is the O(1) read for billing and
 * limit checks.
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
    return { value: row.value, count: row.count };
  },
});

/**
 * Every period's rolled-up usage for a subject on a meter, as `{ period, value,
 * count }` entries. Reads the rollups via the `(scope, meter, subject)` index
 * prefix — one indexed scan, no per-row queries. Returns `[]` when the subject has
 * no recorded usage.
 */
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
    }));
  },
});
