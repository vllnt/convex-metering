import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { Metering } from "../../src/client";

/**
 * Host-app wrappers. The host owns auth: resolve identity here, then pass an
 * opaque `subjectRef` (and host-chosen `period`) into the metering client. Time is
 * server-sourced inside the component.
 */
const metering = new Metering(components.metering);

/** A second client with non-default options — exercises the client defaults. */
const scoped = new Metering(components.metering, {
  defaultScope: "tenant",
  defaultPeriod: "2026-Q2",
});

const aggregationArg = v.union(v.literal("sum"), v.literal("max"), v.literal("last"));
const recordResult = v.union(
  v.object({ recorded: v.literal(true), value: v.number(), count: v.number() }),
  v.object({ recorded: v.literal(false), reason: v.literal("duplicate") }),
);
const limitResult = v.union(
  v.object({ recorded: v.literal(true), value: v.number(), count: v.number() }),
  v.object({ recorded: v.literal(false), reason: v.literal("duplicate") }),
  v.object({
    recorded: v.literal(false),
    reason: v.literal("limit_exceeded"),
    value: v.number(),
    limit: v.number(),
  }),
);
const meterObject = v.object({
  key: v.string(),
  scope: v.string(),
  aggregation: aggregationArg,
  unit: v.string(),
  createdAt: v.number(),
});
const meterDef = v.union(v.null(), meterObject);
const usageProjection = v.union(
  v.null(),
  v.object({ value: v.number(), count: v.number(), closed: v.boolean() }),
);
const usageEntries = v.array(
  v.object({ period: v.string(), value: v.number(), count: v.number(), closed: v.boolean() }),
);
const subjectUsageEntries = v.array(
  v.object({
    meter: v.string(),
    period: v.string(),
    value: v.number(),
    count: v.number(),
    closed: v.boolean(),
  }),
);
const verifyResult = v.object({
  rollupValue: v.number(),
  rollupCount: v.number(),
  recomputedValue: v.number(),
  recordsRemaining: v.number(),
  consistent: v.boolean(),
});

/** Full-options defineMeter — exercises explicit aggregation/unit/scope. */
export const defineMeter = mutation({
  args: {
    key: v.string(),
    aggregation: v.optional(aggregationArg),
    unit: v.optional(v.string()),
    scope: v.optional(v.string()),
  },
  returns: v.object({ created: v.boolean() }),
  handler: (ctx, a) =>
    metering.defineMeter(ctx, a.key, { aggregation: a.aggregation, unit: a.unit, scope: a.scope }),
});

/** Minimal defineMeter — omits aggregation/unit/scope to exercise client defaults. */
export const defineMeterDefaults = mutation({
  args: { key: v.string() },
  returns: v.object({ created: v.boolean() }),
  handler: (ctx, a) => metering.defineMeter(ctx, a.key),
});

export const record = mutation({
  args: {
    meter: v.string(),
    subjectRef: v.string(),
    quantity: v.number(),
    period: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    actorRef: v.optional(v.string()),
    scope: v.optional(v.string()),
  },
  returns: recordResult,
  handler: (ctx, a) =>
    metering.record(ctx, a.meter, a.subjectRef, a.quantity, {
      period: a.period,
      idempotencyKey: a.idempotencyKey,
      actorRef: a.actorRef,
      scope: a.scope,
    }),
});

/** Minimal record — omits options to exercise the client defaults. */
export const recordDefaults = mutation({
  args: { meter: v.string(), subjectRef: v.string(), quantity: v.number() },
  returns: recordResult,
  handler: (ctx, a) => metering.record(ctx, a.meter, a.subjectRef, a.quantity),
});

export const recordWithLimit = mutation({
  args: {
    meter: v.string(),
    subjectRef: v.string(),
    quantity: v.number(),
    limit: v.number(),
    period: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    scope: v.optional(v.string()),
  },
  returns: limitResult,
  handler: (ctx, a) =>
    metering.recordWithLimit(ctx, a.meter, a.subjectRef, a.quantity, a.limit, {
      period: a.period,
      idempotencyKey: a.idempotencyKey,
      scope: a.scope,
    }),
});

export const adjust = mutation({
  args: {
    meter: v.string(),
    subjectRef: v.string(),
    delta: v.number(),
    period: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    scope: v.optional(v.string()),
  },
  returns: recordResult,
  handler: (ctx, a) =>
    metering.adjust(ctx, a.meter, a.subjectRef, a.delta, {
      period: a.period,
      idempotencyKey: a.idempotencyKey,
      scope: a.scope,
    }),
});

export const closePeriod = mutation({
  args: {
    meter: v.string(),
    subjectRef: v.string(),
    period: v.optional(v.string()),
    scope: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: (ctx, a) =>
    metering.closePeriod(ctx, a.meter, a.subjectRef, { period: a.period, scope: a.scope }),
});

export const reset = mutation({
  args: {
    meter: v.string(),
    subjectRef: v.string(),
    period: v.optional(v.string()),
    scope: v.optional(v.string()),
    batch: v.optional(v.number()),
  },
  returns: v.number(),
  handler: (ctx, a) =>
    metering.reset(ctx, a.meter, a.subjectRef, {
      period: a.period,
      scope: a.scope,
      batch: a.batch,
    }),
});

export const eraseSubject = mutation({
  args: { subjectRef: v.string(), scope: v.optional(v.string()), batch: v.optional(v.number()) },
  returns: v.number(),
  handler: (ctx, a) => metering.eraseSubject(ctx, a.subjectRef, { scope: a.scope, batch: a.batch }),
});

export const pruneRecords = mutation({
  args: { before: v.number(), batch: v.optional(v.number()) },
  returns: v.number(),
  handler: (ctx, a) => metering.pruneRecords(ctx, a.before, a.batch),
});

/** Minimal pruneRecords — omits batch to exercise the default page size. */
export const pruneRecordsDefaults = mutation({
  args: { before: v.number() },
  returns: v.number(),
  handler: (ctx, a) => metering.pruneRecords(ctx, a.before),
});

export const pruneSeen = mutation({
  args: { before: v.number(), batch: v.optional(v.number()) },
  returns: v.number(),
  handler: (ctx, a) => metering.pruneSeen(ctx, a.before, a.batch),
});

export const getMeter = query({
  args: { key: v.string(), scope: v.optional(v.string()) },
  returns: meterDef,
  handler: (ctx, a) => metering.getMeter(ctx, a.key, a.scope),
});

export const listMeters = query({
  args: { scope: v.optional(v.string()) },
  returns: v.array(meterObject),
  handler: (ctx, a) => metering.listMeters(ctx, a.scope),
});

export const usage = query({
  args: {
    meter: v.string(),
    subjectRef: v.string(),
    period: v.optional(v.string()),
    scope: v.optional(v.string()),
  },
  returns: usageProjection,
  handler: (ctx, a) =>
    metering.usage(ctx, a.meter, a.subjectRef, { period: a.period, scope: a.scope }),
});

export const listUsage = query({
  args: { meter: v.string(), subjectRef: v.string(), scope: v.optional(v.string()) },
  returns: usageEntries,
  handler: (ctx, a) => metering.listUsage(ctx, a.meter, a.subjectRef, a.scope),
});

export const listSubjectUsage = query({
  args: { subjectRef: v.string(), scope: v.optional(v.string()) },
  returns: subjectUsageEntries,
  handler: (ctx, a) => metering.listSubjectUsage(ctx, a.subjectRef, a.scope),
});

export const verify = query({
  args: {
    meter: v.string(),
    subjectRef: v.string(),
    period: v.optional(v.string()),
    scope: v.optional(v.string()),
  },
  returns: verifyResult,
  handler: (ctx, a) =>
    metering.verify(ctx, a.meter, a.subjectRef, { period: a.period, scope: a.scope }),
});

/** Scoped-client variants — exercise the `defaultScope` / `defaultPeriod` defaults. */
export const defineMeterScoped = mutation({
  args: { key: v.string() },
  returns: v.object({ created: v.boolean() }),
  handler: (ctx, a) => scoped.defineMeter(ctx, a.key),
});

export const recordScoped = mutation({
  args: { meter: v.string(), subjectRef: v.string(), quantity: v.number() },
  returns: recordResult,
  handler: (ctx, a) => scoped.record(ctx, a.meter, a.subjectRef, a.quantity),
});

export const usageScoped = query({
  args: { meter: v.string(), subjectRef: v.string() },
  returns: usageProjection,
  handler: (ctx, a) => scoped.usage(ctx, a.meter, a.subjectRef),
});

export const getMeterScoped = query({
  args: { key: v.string() },
  returns: meterDef,
  handler: (ctx, a) => scoped.getMeter(ctx, a.key),
});

export const listMetersScoped = query({
  args: {},
  returns: v.array(meterObject),
  handler: (ctx) => scoped.listMeters(ctx),
});

export const resetScoped = mutation({
  args: { meter: v.string(), subjectRef: v.string() },
  returns: v.number(),
  handler: (ctx, a) => scoped.reset(ctx, a.meter, a.subjectRef),
});

export const listUsageScoped = query({
  args: { meter: v.string(), subjectRef: v.string() },
  returns: usageEntries,
  handler: (ctx, a) => scoped.listUsage(ctx, a.meter, a.subjectRef),
});

export const listSubjectUsageScoped = query({
  args: { subjectRef: v.string() },
  returns: subjectUsageEntries,
  handler: (ctx, a) => scoped.listSubjectUsage(ctx, a.subjectRef),
});

export const eraseSubjectScoped = mutation({
  args: { subjectRef: v.string() },
  returns: v.number(),
  handler: (ctx, a) => scoped.eraseSubject(ctx, a.subjectRef),
});

export const verifyScoped = query({
  args: { meter: v.string(), subjectRef: v.string() },
  returns: verifyResult,
  handler: (ctx, a) => scoped.verify(ctx, a.meter, a.subjectRef),
});

export const closePeriodScoped = mutation({
  args: { meter: v.string(), subjectRef: v.string() },
  returns: v.boolean(),
  handler: (ctx, a) => scoped.closePeriod(ctx, a.meter, a.subjectRef),
});

export const adjustScoped = mutation({
  args: { meter: v.string(), subjectRef: v.string(), delta: v.number() },
  returns: recordResult,
  handler: (ctx, a) => scoped.adjust(ctx, a.meter, a.subjectRef, a.delta),
});

export const recordWithLimitScoped = mutation({
  args: { meter: v.string(), subjectRef: v.string(), quantity: v.number(), limit: v.number() },
  returns: limitResult,
  handler: (ctx, a) => scoped.recordWithLimit(ctx, a.meter, a.subjectRef, a.quantity, a.limit),
});

/**
 * Host-side billing — reads a period's usage from the component, multiplies by the
 * host's own rate, and writes an invoice to the host's own table. Demonstrates the
 * boundary: the component owns accurate usage; the host owns pricing.
 */
export const billFromUsage = mutation({
  args: { meter: v.string(), subjectRef: v.string(), period: v.string(), rate: v.number() },
  returns: v.union(v.null(), v.number()),
  handler: async (ctx, a) => {
    const used = await metering.usage(ctx, a.meter, a.subjectRef, { period: a.period });
    if (used === null) {
      return null;
    }
    const amount = used.value * a.rate;
    await ctx.db.insert("invoices", { subjectRef: a.subjectRef, period: a.period, amount });
    return amount;
  },
});

export const invoiceTotal = query({
  args: { subjectRef: v.string(), period: v.string() },
  returns: v.number(),
  handler: async (ctx, a) => {
    const rows = await ctx.db
      .query("invoices")
      .withIndex("by_subject_period", (q) =>
        q.eq("subjectRef", a.subjectRef).eq("period", a.period),
      )
      .collect();
    return rows.reduce((sum, row) => sum + row.amount, 0);
  },
});
