import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The example host app's own table. Invoices live in the HOST's table — outside
 * the component's sandboxed tables — to demonstrate the boundary: the component
 * owns accurate usage rollups; the host turns a period's usage into a bill at its
 * own rate.
 */
export default defineSchema({
  invoices: defineTable({
    subjectRef: v.string(),
    period: v.string(),
    amount: v.number(),
  }).index("by_subject_period", ["subjectRef", "period"]),
});
