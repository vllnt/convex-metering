/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  return convexTest({ schema, modules, transactionLimits: true });
}

type T = ReturnType<typeof setup>;

type Limits = { documentsWritten?: number; databaseQueries?: number };

async function closeLimited(t: T, limits: Limits): Promise<boolean> {
  return t.run(async (ctx) =>
    ctx.runMutation(
      api.mutations.closePeriod,
      { scope: "s", meter: "api", subjectRef: "o", period: "p" },
      { transactionLimits: limits },
    ),
  );
}

async function scheduledCount(t: T): Promise<number> {
  return t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).length);
}

async function seed(t: T, records: number, subjectRef = "o", meter = "api"): Promise<void> {
  await t.mutation(api.mutations.defineMeter, { scope: "s", key: meter, aggregation: "sum", unit: "" });
  for (let i = 0; i < records; i++) {
    await t.mutation(api.mutations.record, {
      scope: "s",
      meter,
      subjectRef,
      quantity: 1,
      period: "p",
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reset / eraseSubject schedule no trailing empty pass", () => {
  test("reset with fewer records than the batch drains in one call", async () => {
    const t = setup();
    await seed(t, 3);
    const removed = await t.mutation(api.mutations.reset, {
      scope: "s",
      meter: "api",
      subjectRef: "o",
      period: "p",
      batch: 10,
    });
    expect(removed).toBe(3);
    expect(await scheduledCount(t)).toBe(0);
    expect(
      await t.query(api.queries.usage, { scope: "s", meter: "api", subjectRef: "o", period: "p" }),
    ).toBeNull();
  });

  test("reset with a full batch schedules exactly one follow-up", async () => {
    const t = setup();
    await seed(t, 2);
    expect(
      await t.mutation(api.mutations.reset, {
        scope: "s",
        meter: "api",
        subjectRef: "o",
        period: "p",
        batch: 2,
      }),
    ).toBe(2);
    expect(await scheduledCount(t)).toBe(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await scheduledCount(t)).toBe(1);
    expect(
      await t.query(api.queries.usage, { scope: "s", meter: "api", subjectRef: "o", period: "p" }),
    ).toBeNull();
  });

  test("eraseSubject under the batch drains in one call", async () => {
    const t = setup();
    await seed(t, 2);
    await seed(t, 1, "o", "gb");
    expect(await t.mutation(api.mutations.eraseSubject, { scope: "s", subjectRef: "o", batch: 10 })).toBe(5);
    expect(await scheduledCount(t)).toBe(0);
    expect(await t.query(api.queries.listSubjectUsage, { scope: "s", subjectRef: "o" })).toEqual([]);
  });

  test("eraseSubject reschedules when the rollup page alone is full", async () => {
    const t = setup();
    await seed(t, 1);
    await t.mutation(api.mutations.reset, {
      scope: "s",
      meter: "api",
      subjectRef: "o",
      period: "p",
      batch: 1,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await seed(t, 1, "o", "gb");
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("records").collect();
      for (const row of rows) {
        await ctx.db.delete("records", row._id);
      }
    });
    const before = await scheduledCount(t);
    expect(await t.mutation(api.mutations.eraseSubject, { scope: "s", subjectRef: "o", batch: 1 })).toBe(1);
    expect(await scheduledCount(t)).toBe(before + 1);
  });
});

describe("closePeriod is idempotent", () => {
  test("a second close writes nothing and keeps the original freeze time", async () => {
    const t = setup();
    await seed(t, 1);
    vi.setSystemTime(1000);
    expect(await closeLimited(t, {})).toBe(true);
    vi.setSystemTime(5000);
    expect(await closeLimited(t, { documentsWritten: 0 })).toBe(true);
    const closedAt = await t.run(async (ctx) => (await ctx.db.query("rollups").first())?.closedAt);
    expect(closedAt).toBe(1000);
  });
});

describe("defineMeter skips unchanged writes", () => {
  test("an identical re-define writes nothing; a unit change still patches", async () => {
    const t = setup();
    const def = { scope: "s", key: "m", aggregation: "sum" as const, unit: "req" };
    await t.mutation(api.mutations.defineMeter, def);
    const noWrites = { transactionLimits: { documentsWritten: 0 } };
    expect(await t.run(async (ctx) => ctx.runMutation(api.mutations.defineMeter, def, noWrites))).toEqual({
      created: false,
    });
    await expect(
      t.run(async (ctx) => ctx.runMutation(api.mutations.defineMeter, { ...def, unit: "calls" }, noWrites)),
    ).rejects.toThrow();
    await t.mutation(api.mutations.defineMeter, { ...def, unit: "calls" });
    expect(await t.query(api.queries.getMeter, { scope: "s", key: "m" })).toMatchObject({ unit: "calls" });
  });

  test("listMeters keeps creation order", async () => {
    const t = setup();
    for (const key of ["b", "a", "c"]) {
      await t.mutation(api.mutations.defineMeter, { scope: "s", key, aggregation: "sum", unit: "" });
    }
    await t.mutation(api.mutations.defineMeter, { scope: "other", key: "z", aggregation: "sum", unit: "" });
    expect((await t.query(api.queries.listMeters, { scope: "s" })).map((m) => m.key)).toEqual(["b", "a", "c"]);
  });
});

describe("recordWithLimit with an idempotency key", () => {
  test("queries the seen ledger once per accepted keyed event and dedups the retry", async () => {
    const t = setup();
    await seed(t, 0);
    const args = {
      scope: "s",
      meter: "api",
      subjectRef: "o",
      quantity: 2,
      period: "p",
      limit: 10,
      idempotencyKey: "k",
    };
    const threeQueries = { transactionLimits: { databaseQueries: 3 } };
    expect(await t.run(async (ctx) => ctx.runMutation(api.mutations.recordWithLimit, args, threeQueries))).toEqual({
      recorded: true,
      value: 2,
      count: 1,
    });
    expect(await t.mutation(api.mutations.recordWithLimit, args)).toEqual({ recorded: false, reason: "duplicate" });
    expect(await t.run(async (ctx) => (await ctx.db.query("seen").collect()).length)).toBe(1);
  });
});

describe("records keep the audit fields", () => {
  test("record, recordWithLimit and adjust store actorRef and idempotencyKey; unset ones stay absent", async () => {
    const t = setup();
    await seed(t, 0);
    const base = { scope: "s", meter: "api", subjectRef: "o", period: "p" };
    await t.mutation(api.mutations.record, { ...base, quantity: 1, actorRef: "a-record", idempotencyKey: "k-record" });
    await t.mutation(api.mutations.recordWithLimit, {
      ...base,
      quantity: 1,
      limit: 10,
      actorRef: "a-limit",
      idempotencyKey: "k-limit",
    });
    await t.mutation(api.mutations.adjust, { ...base, delta: 1, actorRef: "a-adjust", idempotencyKey: "k-adjust" });
    await t.mutation(api.mutations.record, { ...base, quantity: 1 });
    const rows = await t.run(async (ctx) => ctx.db.query("records").collect());
    expect(rows.map((r) => ({ actorRef: r.actorRef, idempotencyKey: r.idempotencyKey }))).toEqual([
      { actorRef: "a-record", idempotencyKey: "k-record" },
      { actorRef: "a-limit", idempotencyKey: "k-limit" },
      { actorRef: "a-adjust", idempotencyKey: "k-adjust" },
      { actorRef: undefined, idempotencyKey: undefined },
    ]);
    expect(rows.map((r) => "actorRef" in r || "idempotencyKey" in r)).toEqual([true, true, true, false]);
  });
});
