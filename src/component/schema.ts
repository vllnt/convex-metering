import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { aggregation } from "./validators";

/**
 * Sandboxed tables — the metering ledger's own concern. No host tables are
 * touched. `subjectRef`, `meterKey`, `scope`, and `period` are all opaque
 * host-owned strings.
 *
 * - `meters`  — the meter definition (its aggregation rule + display unit).
 * - `records` — the append-only raw usage events (audit + idempotency source).
 * - `rollups` — the materialized per-(meter, subject, period) aggregate, the fast
 *   read for billing/limits. Rollups are the billable truth and are never pruned;
 *   raw `records` may be pruned by the host once they pass its retention window.
 */
export default defineSchema({
  meters: defineTable({
    key: v.string(),
    scope: v.string(),
    aggregation,
    unit: v.string(),
    createdAt: v.number(),
  }).index("by_scope_key", ["scope", "key"]),

  records: defineTable({
    scope: v.string(),
    meterKey: v.string(),
    subjectRef: v.string(),
    quantity: v.number(),
    period: v.string(),
    idempotencyKey: v.optional(v.string()),
    recordedAt: v.number(),
  })
    .index("by_scope_meter_subject_period", [
      "scope",
      "meterKey",
      "subjectRef",
      "period",
    ])
    .index("by_idem", ["scope", "meterKey", "idempotencyKey"])
    .index("by_recorded", ["recordedAt"]),

  rollups: defineTable({
    scope: v.string(),
    meterKey: v.string(),
    subjectRef: v.string(),
    period: v.string(),
    value: v.number(),
    count: v.number(),
    updatedAt: v.number(),
  }).index("by_scope_meter_subject_period", [
    "scope",
    "meterKey",
    "subjectRef",
    "period",
  ]),
});
