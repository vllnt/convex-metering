/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  return convexTest(schema, modules);
}

type T = ReturnType<typeof setup>;

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
  test("a second close keeps the original freeze time", async () => {
    const t = setup();
    await seed(t, 1);
    const args = { scope: "s", meter: "api", subjectRef: "o", period: "p" };
    vi.setSystemTime(1000);
    expect(await t.mutation(api.mutations.closePeriod, args)).toBe(true);
    vi.setSystemTime(5000);
    expect(await t.mutation(api.mutations.closePeriod, args)).toBe(true);
    const closedAt = await t.run(async (ctx) => (await ctx.db.query("rollups").first())?.closedAt);
    expect(closedAt).toBe(1000);
  });
});

describe("defineMeter skips unchanged writes", () => {
  test("an identical re-define leaves the doc untouched; a unit change patches", async () => {
    const t = setup();
    const def = { scope: "s", key: "m", aggregation: "sum" as const, unit: "req" };
    await t.mutation(api.mutations.defineMeter, def);
    const first = await t.run(async (ctx) => ctx.db.query("meters").first());
    expect(await t.mutation(api.mutations.defineMeter, def)).toEqual({ created: false });
    expect(await t.run(async (ctx) => ctx.db.query("meters").first())).toEqual(first);
    await t.mutation(api.mutations.defineMeter, { ...def, unit: "calls" });
    expect(await t.query(api.queries.getMeter, { scope: "s", key: "m" })).toMatchObject({ unit: "calls" });
  });

  test("listMeters returns a scope's meters ordered by key", async () => {
    const t = setup();
    for (const key of ["b", "a", "c"]) {
      await t.mutation(api.mutations.defineMeter, { scope: "s", key, aggregation: "sum", unit: "" });
    }
    await t.mutation(api.mutations.defineMeter, { scope: "other", key: "z", aggregation: "sum", unit: "" });
    expect((await t.query(api.queries.listMeters, { scope: "s" })).map((m) => m.key)).toEqual(["a", "b", "c"]);
  });
});

describe("recordWithLimit with an idempotency key", () => {
  test("records once and dedups the retry", async () => {
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
    expect(await t.mutation(api.mutations.recordWithLimit, args)).toEqual({ recorded: true, value: 2, count: 1 });
    expect(await t.mutation(api.mutations.recordWithLimit, args)).toEqual({ recorded: false, reason: "duplicate" });
    expect(await t.run(async (ctx) => (await ctx.db.query("seen").collect()).length)).toBe(1);
  });
});

describe("string length caps", () => {
  const long = "x".repeat(257);
  const max = "x".repeat(256);

  test("a 256-character identifier is accepted", async () => {
    const t = setup();
    await t.mutation(api.mutations.defineMeter, { scope: "s", key: max, aggregation: "sum", unit: max });
    expect(
      await t.mutation(api.mutations.record, {
        scope: "s",
        meter: max,
        subjectRef: max,
        quantity: 1,
        period: max,
        idempotencyKey: max,
        actorRef: max,
      }),
    ).toMatchObject({ recorded: true });
  });

  test.each(["subjectRef", "period", "idempotencyKey", "actorRef"])(
    "record rejects a %s over 256 characters",
    async (field) => {
      const t = setup();
      await seed(t, 0);
      await expect(
        t.mutation(api.mutations.record, {
          scope: "s",
          meter: "api",
          subjectRef: "o",
          quantity: 1,
          period: "p",
          [field]: long,
        }),
      ).rejects.toThrow(/INVALID_ARGUMENT|at most 256/);
    },
  );

  test("defineMeter rejects an over-long key or unit", async () => {
    const t = setup();
    await expect(
      t.mutation(api.mutations.defineMeter, { scope: "s", key: long, aggregation: "sum", unit: "" }),
    ).rejects.toThrow(/at most 256/);
    await expect(
      t.mutation(api.mutations.defineMeter, { scope: "s", key: "k", aggregation: "sum", unit: long }),
    ).rejects.toThrow(/at most 256/);
  });

  test("recordWithLimit and adjust reject an over-long subjectRef", async () => {
    const t = setup();
    await seed(t, 0);
    const base = { scope: "s", meter: "api", subjectRef: long, period: "p" };
    await expect(
      t.mutation(api.mutations.recordWithLimit, { ...base, quantity: 1, limit: 5 }),
    ).rejects.toThrow(/at most 256/);
    await expect(t.mutation(api.mutations.adjust, { ...base, delta: 1 })).rejects.toThrow(/at most 256/);
  });
});
