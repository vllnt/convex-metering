import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { register } from "../../src/test";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("metering — defineMeter", () => {
  test("first define inserts (created:true) with server-stamped createdAt", async () => {
    const t = setup();
    expect(
      await t.mutation(api.example.defineMeter, {
        key: "api_calls",
        aggregation: "sum",
        unit: "requests",
      }),
    ).toEqual({ created: true });
    const def = await t.query(api.example.getMeter, { key: "api_calls" });
    expect(def).toEqual({
      key: "api_calls",
      scope: "global",
      aggregation: "sum",
      unit: "requests",
      createdAt: 0,
    });
  });

  test("re-define updates (created:false)", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "m", aggregation: "sum" });
    expect(
      await t.mutation(api.example.defineMeter, {
        key: "m",
        aggregation: "max",
        unit: "peak",
      }),
    ).toEqual({ created: false });
    const def = await t.query(api.example.getMeter, { key: "m" });
    expect(def?.aggregation).toBe("max");
    expect(def?.unit).toBe("peak");
  });

  test("defineMeter defaults — sum aggregation, empty unit", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeterDefaults, { key: "d" });
    const def = await t.query(api.example.getMeter, { key: "d" });
    expect(def?.aggregation).toBe("sum");
    expect(def?.unit).toBe("");
  });
});

describe("metering — record validation", () => {
  test("a negative quantity is rejected (INVALID_QUANTITY)", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "m" });
    await expect(
      t.mutation(api.example.record, { meter: "m", subjectRef: "s", quantity: -1 }),
    ).rejects.toThrow();
  });

  test("a non-finite (Infinity) quantity is rejected", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "m" });
    await expect(
      t.mutation(api.example.record, {
        meter: "m",
        subjectRef: "s",
        quantity: Infinity,
      }),
    ).rejects.toThrow();
  });

  test("recording against an undefined meter is rejected (METER_NOT_FOUND)", async () => {
    const t = setup();
    await expect(
      t.mutation(api.example.record, {
        meter: "ghost",
        subjectRef: "s",
        quantity: 1,
      }),
    ).rejects.toThrow();
  });
});

describe("metering — record + sum rollup", () => {
  test("first record inserts a rollup (value:quantity, count:1); subsequent records sum", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    expect(
      await t.mutation(api.example.record, {
        meter: "api",
        subjectRef: "org_1",
        quantity: 3,
        period: "2026-06",
      }),
    ).toEqual({ recorded: true, value: 3, count: 1 });
    expect(
      await t.mutation(api.example.record, {
        meter: "api",
        subjectRef: "org_1",
        quantity: 4,
        period: "2026-06",
      }),
    ).toEqual({ recorded: true, value: 7, count: 2 });
    expect(
      await t.query(api.example.usage, {
        meter: "api",
        subjectRef: "org_1",
        period: "2026-06",
      }),
    ).toEqual({ value: 7, count: 2 });
  });

  test("record defaults — uses the client default period", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    await t.mutation(api.example.recordDefaults, {
      meter: "api",
      subjectRef: "org_2",
      quantity: 5,
    });
    // default period is "all"
    expect(
      await t.query(api.example.usage, { meter: "api", subjectRef: "org_2" }),
    ).toEqual({ value: 5, count: 1 });
  });
});

describe("metering — aggregation rules (max / last)", () => {
  test("max keeps the peak across records", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "peak", aggregation: "max" });
    await t.mutation(api.example.record, { meter: "peak", subjectRef: "s", quantity: 10, period: "p" });
    const r = await t.mutation(api.example.record, { meter: "peak", subjectRef: "s", quantity: 4, period: "p" });
    expect(r).toEqual({ recorded: true, value: 10, count: 2 });
    const r2 = await t.mutation(api.example.record, { meter: "peak", subjectRef: "s", quantity: 25, period: "p" });
    expect(r2).toEqual({ recorded: true, value: 25, count: 3 });
  });

  test("last overwrites with the latest value", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "gauge", aggregation: "last" });
    await t.mutation(api.example.record, { meter: "gauge", subjectRef: "s", quantity: 10, period: "p" });
    const r = await t.mutation(api.example.record, { meter: "gauge", subjectRef: "s", quantity: 4, period: "p" });
    expect(r).toEqual({ recorded: true, value: 4, count: 2 });
  });
});

describe("metering — idempotency", () => {
  test("a repeat record with the same idempotencyKey is a no-op", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    expect(
      await t.mutation(api.example.record, {
        meter: "api",
        subjectRef: "org",
        quantity: 2,
        period: "p",
        idempotencyKey: "evt_1",
      }),
    ).toEqual({ recorded: true, value: 2, count: 1 });
    // retry with the same key — not counted again
    expect(
      await t.mutation(api.example.record, {
        meter: "api",
        subjectRef: "org",
        quantity: 2,
        period: "p",
        idempotencyKey: "evt_1",
      }),
    ).toEqual({ recorded: false, reason: "duplicate" });
    expect(
      await t.query(api.example.usage, { meter: "api", subjectRef: "org", period: "p" }),
    ).toEqual({ value: 2, count: 1 });
    // a different key counts
    expect(
      await t.mutation(api.example.record, {
        meter: "api",
        subjectRef: "org",
        quantity: 3,
        period: "p",
        idempotencyKey: "evt_2",
      }),
    ).toEqual({ recorded: true, value: 5, count: 2 });
  });
});

describe("metering — usage / listUsage reads", () => {
  test("usage returns null for an unmetered subject", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    expect(
      await t.query(api.example.usage, { meter: "api", subjectRef: "nobody", period: "p" }),
    ).toBeNull();
  });

  test("listUsage returns every period for a subject, [] when none", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    expect(
      await t.query(api.example.listUsage, { meter: "api", subjectRef: "org" }),
    ).toEqual([]);
    await t.mutation(api.example.record, { meter: "api", subjectRef: "org", quantity: 1, period: "2026-05" });
    await t.mutation(api.example.record, { meter: "api", subjectRef: "org", quantity: 2, period: "2026-06" });
    const list = await t.query(api.example.listUsage, { meter: "api", subjectRef: "org" });
    expect(list).toHaveLength(2);
    expect(list).toContainEqual({ period: "2026-05", value: 1, count: 1 });
    expect(list).toContainEqual({ period: "2026-06", value: 2, count: 1 });
  });

  test("getMeter returns null for an undefined meter", async () => {
    const t = setup();
    expect(await t.query(api.example.getMeter, { key: "absent" })).toBeNull();
  });
});

describe("metering — reset", () => {
  test("reset clears a period's rollup and records (true); absent → false", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    await t.mutation(api.example.record, { meter: "api", subjectRef: "org", quantity: 5, period: "p" });
    expect(
      await t.mutation(api.example.reset, { meter: "api", subjectRef: "org", period: "p" }),
    ).toBe(true);
    expect(
      await t.query(api.example.usage, { meter: "api", subjectRef: "org", period: "p" }),
    ).toBeNull();
    // resetting again (nothing there) returns false
    expect(
      await t.mutation(api.example.reset, { meter: "api", subjectRef: "org", period: "p" }),
    ).toBe(false);
  });
});

describe("metering — pruneRecords (bounded, rollups preserved)", () => {
  test("prune removes only records older than the cutoff, leaving rollups intact", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    await t.mutation(api.example.record, { meter: "api", subjectRef: "org", quantity: 1, period: "p" }); // recordedAt 0
    vi.setSystemTime(1_000);
    await t.mutation(api.example.record, { meter: "api", subjectRef: "org", quantity: 1, period: "p" }); // recordedAt 1000
    // prune records older than 500 → removes the first only
    expect(await t.mutation(api.example.pruneRecords, { before: 500, batch: 200 })).toBe(1);
    // rollup is untouched (still value 2, count 2)
    expect(
      await t.query(api.example.usage, { meter: "api", subjectRef: "org", period: "p" }),
    ).toEqual({ value: 2, count: 2 });
  });

  test("prune above the batch size self-reschedules and clears the whole tail", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.example.record, { meter: "api", subjectRef: "org", quantity: 1, period: "p" });
    }
    vi.setSystemTime(1_000);
    // batch 2 < 5 records → first pass removes 2 and self-reschedules
    expect(await t.mutation(api.example.pruneRecords, { before: 1_000, batch: 2 })).toBe(2);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // all raw records gone, rollup preserved
    expect(
      await t.query(api.example.usage, { meter: "api", subjectRef: "org", period: "p" }),
    ).toEqual({ value: 5, count: 5 });
  });

  test("pruneRecords defaults — omitting batch uses the default page size", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    await t.mutation(api.example.record, { meter: "api", subjectRef: "org", quantity: 1, period: "p" });
    vi.setSystemTime(1_000);
    expect(await t.mutation(api.example.pruneRecordsDefaults, { before: 500 })).toBe(1);
  });
});

describe("metering — scopes (independent namespaces)", () => {
  test("the same meter key in different scopes is independent", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum", scope: "a" });
    // scope "b" has no meter → record rejected
    await expect(
      t.mutation(api.example.record, { meter: "api", subjectRef: "s", quantity: 1, scope: "b" }),
    ).rejects.toThrow();
    expect(await t.query(api.example.getMeter, { key: "api", scope: "b" })).toBeNull();
    // scope "a" records fine
    await t.mutation(api.example.record, { meter: "api", subjectRef: "s", quantity: 1, period: "p", scope: "a" });
    expect(
      await t.query(api.example.usage, { meter: "api", subjectRef: "s", period: "p", scope: "a" }),
    ).toEqual({ value: 1, count: 1 });
  });
});

describe("metering — scoped client (defaultScope + defaultPeriod)", () => {
  test("scoped client meters + records in its default scope and period", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeterScoped, { key: "seats" });
    // landed in "tenant" scope, not "global"
    expect(await t.query(api.example.getMeter, { key: "seats" })).toBeNull();
    expect((await t.query(api.example.getMeterScoped, { key: "seats" }))?.scope).toBe("tenant");

    await t.mutation(api.example.recordScoped, { meter: "seats", subjectRef: "org", quantity: 3 });
    // default period "2026-Q2"
    expect(
      await t.query(api.example.usageScoped, { meter: "seats", subjectRef: "org" }),
    ).toEqual({ value: 3, count: 1 });
    const list = await t.query(api.example.listUsageScoped, { meter: "seats", subjectRef: "org" });
    expect(list).toEqual([{ period: "2026-Q2", value: 3, count: 1 }]);
    expect(
      await t.mutation(api.example.resetScoped, { meter: "seats", subjectRef: "org" }),
    ).toBe(true);
  });
});

describe("metering — host-side billing (boundary)", () => {
  test("the host turns a period's usage into a bill at its own rate", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum", unit: "requests" });
    await t.mutation(api.example.record, { meter: "api", subjectRef: "org", quantity: 1000, period: "2026-06" });
    // bill at 0.002 per request
    const amount = await t.mutation(api.example.billFromUsage, {
      meter: "api",
      subjectRef: "org",
      period: "2026-06",
      rate: 0.002,
    });
    expect(amount).toBe(2);
    expect(
      await t.query(api.example.invoiceTotal, { subjectRef: "org", period: "2026-06" }),
    ).toBe(2);
    // a subject with no usage cannot be billed
    expect(
      await t.mutation(api.example.billFromUsage, {
        meter: "api",
        subjectRef: "no_usage",
        period: "2026-06",
        rate: 0.002,
      }),
    ).toBeNull();
  });
});
