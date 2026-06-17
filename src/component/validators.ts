import { v } from "convex/values";

/** How a meter rolls successive quantities into a period value. */
export const aggregation = v.union(
  v.literal("sum"),
  v.literal("max"),
  v.literal("last"),
);

/**
 * Result of `record`. `recorded: true` — the usage event was written and the
 * period rollup advanced to `value` over `count` events. `recorded: false` with
 * `reason: "duplicate"` — an event with the same `idempotencyKey` was already
 * recorded; `value`/`count` echo the unchanged rollup so a retry is a safe no-op.
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

/** Projection of a meter definition returned by `getMeter`. */
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
});

/** A subject's usage for a single period, returned in the `listUsage` array. */
export const usageEntry = v.object({
  period: v.string(),
  value: v.number(),
  count: v.number(),
});
