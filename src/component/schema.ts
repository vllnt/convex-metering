import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { aggregation } from "./validators";

/**
 * Sandboxed tables — the metering ledger's own concern. No host tables are
 * touched. `subjectRef`, `meterKey`, `scope`, and `period` are all opaque
 * host-owned strings.
 *
 * - `meters`  — the meter definition (its aggregation rule + display unit).
 * - `records` — the append-only raw usage events (the audit trail).
 * - `seen`    — the idempotency-key ledger, **separate from `records`** so pruning
 *   raw audit rows never re-opens a duplicate (the prune-vs-dedup double-count).
 * - `rollups` — the materialized per-(meter, subject, period) aggregate, the fast
 *   read for billing/limits; the billable truth (never pruned). `closedAt` freezes
 *   a billed period so late events can't silently restate the invoiced number.
 */
export default defineSchema({
  meters: defineTable({
    key: v.string(),
    scope: v.string(),
    aggregation,
    unit: v.string(),
    createdAt: v.number(),
  })
    .index("by_scope_key", ["scope", "key"])
    .index("by_scope", ["scope"]),

  records: defineTable({
    scope: v.string(),
    meterKey: v.string(),
    subjectRef: v.string(),
    quantity: v.number(),
    period: v.string(),
    idempotencyKey: v.optional(v.string()),
    actorRef: v.optional(v.string()),
    recordedAt: v.number(),
  })
    .index("by_scope_meter_subject_period", [
      "scope",
      "meterKey",
      "subjectRef",
      "period",
    ])
    .index("by_scope_subject", ["scope", "subjectRef"])
    .index("by_recorded", ["recordedAt"]),

  seen: defineTable({
    scope: v.string(),
    meterKey: v.string(),
    idempotencyKey: v.string(),
    seenAt: v.number(),
  })
    .index("by_idem", ["scope", "meterKey", "idempotencyKey"])
    .index("by_seen", ["seenAt"]),

  rollups: defineTable({
    scope: v.string(),
    meterKey: v.string(),
    subjectRef: v.string(),
    period: v.string(),
    value: v.number(),
    count: v.number(),
    updatedAt: v.number(),
    closedAt: v.optional(v.number()),
  })
    .index("by_scope_meter_subject_period", [
      "scope",
      "meterKey",
      "subjectRef",
      "period",
    ])
    .index("by_scope_subject", ["scope", "subjectRef"]),
});
