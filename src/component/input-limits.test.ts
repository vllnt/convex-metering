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
