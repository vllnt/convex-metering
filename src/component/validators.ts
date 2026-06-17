import { v } from "convex/values";

/** How a meter rolls successive quantities into a period value. */
export const aggregation = v.union(
  v.literal("sum"),
  v.literal("max"),
  v.literal("last"),
);

/**
 * Result of `record` / `adjust`. `recorded: true` — the event was written and the
 * period rollup advanced to `value` over `count` events. `recorded: false` with
 * `reason: "duplicate"` — an event with the same `idempotencyKey` was already
 * recorded; nothing changed.
 */
export const recordResult = v.union(
  v.object({
    recorded: v.literal(true),
    value: v.number(),
    count: v.number(),
  }),
  v.object({
    recorded: v.literal(false),
    reason: v.literal("duplicate"),
  }),
);

/**
 * Result of `recordWithLimit` — `recordResult` plus a `limit_exceeded` arm carrying
 * the unchanged `value` and the `limit` it would have crossed.
 */
export const limitResult = v.union(
  v.object({
    recorded: v.literal(true),
    value: v.number(),
    count: v.number(),
  }),
  v.object({
    recorded: v.literal(false),
    reason: v.literal("duplicate"),
  }),
  v.object({
    recorded: v.literal(false),
    reason: v.literal("limit_exceeded"),
    value: v.number(),
    limit: v.number(),
  }),
);

/** Projection of a meter definition returned by `getMeter` / `listMeters`. */
export const meterDef = v.object({
  key: v.string(),
  scope: v.string(),
  aggregation,
  unit: v.string(),
  createdAt: v.number(),
});

/** A subject's rolled-up usage for one period, returned by `usage`. */
export const usageProjection = v.object({
  value: v.number(),
  count: v.number(),
  /** True once the period has been closed (frozen) for billing. */
  closed: v.boolean(),
});

/** A subject's usage for a single period, returned in the `listUsage` array. */
export const usageEntry = v.object({
  period: v.string(),
  value: v.number(),
  count: v.number(),
  closed: v.boolean(),
});

/** A subject's usage on one meter+period, returned in the `listSubjectUsage` array. */
export const subjectUsageEntry = v.object({
  meter: v.string(),
  period: v.string(),
  value: v.number(),
  count: v.number(),
  closed: v.boolean(),
});

/**
 * Result of `verify` — reconciliation of the materialized rollup against the
 * surviving raw records. `consistent` is `rollupValue === recomputedValue`; trust
 * it only when `recordsRemaining > 0` (pruned history can't be fully recomputed).
 */
export const verifyResult = v.object({
  rollupValue: v.number(),
  rollupCount: v.number(),
  recomputedValue: v.number(),
  recordsRemaining: v.number(),
  consistent: v.boolean(),
});
