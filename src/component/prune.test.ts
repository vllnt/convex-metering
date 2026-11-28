/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { DEFAULT_PRUNE_BATCH } from "../shared.js";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  return convexTest(schema, modules);
}

type T = ReturnType<typeof setup>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => {
  vi.useRealTimers();
});

async function recordsLeft(t: T): Promise<number> {
  return t.run(async (ctx) => (await ctx.db.query("records").collect()).length);
}

/**
 * Write three records in one host mutation (one transaction), then read the rows and
 * return the one `recordedAt` they share.
 */
async function seedThreeAtOneTime(t: T): Promise<number> {
  await t.mutation(api.mutations.defineMeter, { scope: "s", key: "api", aggregation: "sum", unit: "" });
  await t.run(async (ctx) => {
    for (const subjectRef of ["a", "b", "c"]) {
      await ctx.runMutation(api.mutations.record, {
        scope: "s",
        meter: "api",
        subjectRef,
        quantity: 1,
        period: "p",
      });
    }
  });
  const times = await t.run(async (ctx) =>
    (await ctx.db.query("records").collect()).map((row) => row.recordedAt),
  );
  expect(times).toHaveLength(3);
  const [recordedAt] = times;
  if (recordedAt === undefined) {
    throw new Error("no record written");
  }
  expect(times).toEqual([recordedAt, recordedAt, recordedAt]);
  return recordedAt;
}

describe("pruneRecords on records that share one recordedAt", () => {
  test.each([
    ["the default batch", DEFAULT_PRUNE_BATCH],
    ["batch 1", 1],
    ["batch 2", 2],
  ])(
    "with %s, before = recordedAt deletes none and before = recordedAt + 1 deletes all three",
    async (_label, batch) => {
      const t = setup();
      const recordedAt = await seedThreeAtOneTime(t);

      // `before` is exclusive: a record stamped exactly `before` stays.
      expect(await t.mutation(api.mutations.pruneRecords, { before: recordedAt, batch })).toBe(0);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await recordsLeft(t)).toBe(3);

      // One ms later every record of that instant goes, across the rescheduled passes.
      expect(
        await t.mutation(api.mutations.pruneRecords, { before: recordedAt + 1, batch }),
      ).toBe(Math.min(3, batch));
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await recordsLeft(t)).toBe(0);
      // The billable rollups are untouched.
      expect(await t.query(api.queries.listSubjectUsage, { scope: "s", subjectRef: "a" })).toEqual([
        { meter: "api", period: "p", value: 1, count: 1, closed: false },
      ]);
    },
  );

  test("the largest batch (500) is accepted", async () => {
    const t = setup();
    const recordedAt = await seedThreeAtOneTime(t);
    expect(await t.mutation(api.mutations.pruneRecords, { before: recordedAt + 1, batch: 500 })).toBe(3);
    expect(await t.mutation(api.mutations.pruneSeen, { before: recordedAt + 1, batch: 500 })).toBe(0);
  });
});
