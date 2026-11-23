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

describe("string length caps", () => {
  const long = "x".repeat(257);
  const max = "x".repeat(256);

  async function snapshot(t: T) {
    return t.run(async (ctx) => ({
      meters: await ctx.db.query("meters").collect(),
      records: await ctx.db.query("records").collect(),
      rollups: await ctx.db.query("rollups").collect(),
      seen: await ctx.db.query("seen").collect(),
    }));
  }

  test("256-character strings are accepted on every write path", async () => {
    const t = setup();
    await t.mutation(api.mutations.defineMeter, { scope: max, key: max, aggregation: "sum", unit: max });
    const base = { scope: max, meter: max, subjectRef: max, period: max, actorRef: max };
    expect(
      await t.mutation(api.mutations.record, { ...base, quantity: 1, idempotencyKey: max }),
    ).toMatchObject({ recorded: true });
    expect(
      await t.mutation(api.mutations.recordWithLimit, { ...base, quantity: 1, limit: 10, idempotencyKey: `${max.slice(1)}a` }),
    ).toMatchObject({ recorded: true });
    expect(
      await t.mutation(api.mutations.adjust, { ...base, delta: -1, idempotencyKey: `${max.slice(1)}b` }),
    ).toMatchObject({ recorded: true });
  });

  test.each(["scope", "key", "unit"])("defineMeter rejects a 257-character %s and writes nothing", async (field) => {
    const t = setup();
    await seed(t, 1);
    const before = await snapshot(t);
    await expect(
      t.mutation(api.mutations.defineMeter, { scope: "s", key: "k", aggregation: "sum", unit: "", [field]: long }),
    ).rejects.toThrow(/at most 256/);
    expect(await snapshot(t)).toEqual(before);
  });

  const usageFields = ["scope", "meter", "subjectRef", "period", "idempotencyKey", "actorRef"];
  const usageCalls = [
    ["record", { quantity: 1 }],
    ["recordWithLimit", { quantity: 1, limit: 10 }],
    ["adjust", { delta: 1 }],
  ] as const;

  test.each(usageCalls.flatMap(([fn, extra]) => usageFields.map((field) => [fn, field, extra] as const)))(
    "%s rejects a 257-character %s and writes nothing",
    async (fn, field, extra) => {
      const t = setup();
      await seed(t, 1);
      const before = await snapshot(t);
      const args = { scope: "s", meter: "api", subjectRef: "o", period: "p", ...extra, [field]: long };
      const call =
        fn === "record"
          ? t.mutation(api.mutations.record, args)
          : fn === "recordWithLimit"
            ? t.mutation(api.mutations.recordWithLimit, { limit: 10, ...args })
            : t.mutation(api.mutations.adjust, { delta: 1, ...args });
      await expect(call).rejects.toThrow(/INVALID_ARGUMENT|at most 256/);
      expect(await snapshot(t)).toEqual(before);
    },
  );
});
