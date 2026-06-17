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

describe("metering — defineMeter + aggregation lock", () => {
  test("first define inserts; re-define updates; defaults are sum/empty-unit", async () => {
    const t = setup();
    expect(
      await t.mutation(api.example.defineMeter, { key: "m", aggregation: "sum", unit: "u" }),
    ).toEqual({ created: true });
    expect(
      await t.mutation(api.example.defineMeter, { key: "m", aggregation: "sum", unit: "u2" }),
    ).toEqual({ created: false });
    await t.mutation(api.example.defineMeterDefaults, { key: "d" });
    const def = await t.query(api.example.getMeter, { key: "d" });
    expect(def).toMatchObject({ aggregation: "sum", unit: "" });
  });

  test("aggregation change is allowed before usage, locked after", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "m", aggregation: "sum" });
    // no usage yet → may change
    expect(
      await t.mutation(api.example.defineMeter, { key: "m", aggregation: "max" }),
    ).toEqual({ created: false });
    // record some usage, then a change is locked
    await t.mutation(api.example.record, { meter: "m", subjectRef: "s", quantity: 5, period: "p" });
    await expect(
      t.mutation(api.example.defineMeter, { key: "m", aggregation: "last" }),
    ).rejects.toThrow(/AGGREGATION_LOCKED|immutable/);
  });
});

describe("metering — record validation + gauge guard", () => {
  test("negative / non-finite quantity is rejected", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "m" });
    await expect(
      t.mutation(api.example.record, { meter: "m", subjectRef: "s", quantity: -1 }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.example.record, { meter: "m", subjectRef: "s", quantity: Infinity }),
    ).rejects.toThrow();
  });

  test("recording against an undefined meter is rejected", async () => {
    const t = setup();
    await expect(
      t.mutation(api.example.record, { meter: "ghost", subjectRef: "s", quantity: 1 }),
    ).rejects.toThrow();
  });

  test("an idempotencyKey on a non-sum gauge meter is rejected", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "gauge", aggregation: "max" });
    await expect(
      t.mutation(api.example.record, {
        meter: "gauge",
        subjectRef: "s",
        quantity: 1,
        period: "p",
        idempotencyKey: "k",
      }),
    ).rejects.toThrow(/IDEMPOTENCY_NOT_SUPPORTED|gauge/);
  });
});

describe("metering — record + rollup (sum / max / last)", () => {
  test("first record inserts the rollup; subsequent records sum", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    expect(
      await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 3, period: "p" }),
    ).toEqual({ recorded: true, value: 3, count: 1 });
    expect(
      await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 4, period: "p" }),
    ).toEqual({ recorded: true, value: 7, count: 2 });
    expect(
      await t.query(api.example.usage, { meter: "api", subjectRef: "o", period: "p" }),
    ).toEqual({ value: 7, count: 2, closed: false });
  });

  test("record defaults use the client default period", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api" });
    await t.mutation(api.example.recordDefaults, { meter: "api", subjectRef: "o", quantity: 5 });
    expect(await t.query(api.example.usage, { meter: "api", subjectRef: "o" })).toMatchObject({
      value: 5,
      count: 1,
    });
  });

  test("max keeps the peak, last overwrites", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "peak", aggregation: "max" });
    await t.mutation(api.example.record, { meter: "peak", subjectRef: "s", quantity: 10, period: "p" });
    expect(
      await t.mutation(api.example.record, { meter: "peak", subjectRef: "s", quantity: 4, period: "p" }),
    ).toEqual({ recorded: true, value: 10, count: 2 });
    await t.mutation(api.example.defineMeter, { key: "gauge", aggregation: "last" });
    await t.mutation(api.example.record, { meter: "gauge", subjectRef: "s", quantity: 10, period: "p" });
    expect(
      await t.mutation(api.example.record, { meter: "gauge", subjectRef: "s", quantity: 4, period: "p" }),
    ).toEqual({ recorded: true, value: 4, count: 2 });
  });
});

describe("metering — idempotency decoupled from prune (the blocker fix)", () => {
  test("a repeat record with the same key is a no-op, and stays deduped AFTER pruning records", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    expect(
      await t.mutation(api.example.record, {
        meter: "api",
        subjectRef: "o",
        quantity: 2,
        period: "p",
        idempotencyKey: "evt_1",
        actorRef: "worker-7",
      }),
    ).toEqual({ recorded: true, value: 2, count: 1 });
    expect(
      await t.mutation(api.example.record, {
        meter: "api",
        subjectRef: "o",
        quantity: 2,
        period: "p",
        idempotencyKey: "evt_1",
      }),
    ).toEqual({ recorded: false, reason: "duplicate" });

    // prune ALL raw records (rollup + seen survive)
    vi.setSystemTime(1_000);
    expect(await t.mutation(api.example.pruneRecords, { before: 1_000 })).toBe(1);
    // a redelivered event with the SAME key still dedups (no double-count)
    expect(
      await t.mutation(api.example.record, {
        meter: "api",
        subjectRef: "o",
        quantity: 2,
        period: "p",
        idempotencyKey: "evt_1",
      }),
    ).toEqual({ recorded: false, reason: "duplicate" });
    expect(
      await t.query(api.example.usage, { meter: "api", subjectRef: "o", period: "p" }),
    ).toMatchObject({ value: 2, count: 1 });
  });

  test("concurrent records with the same key yield exactly one recorded", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    const results = await Promise.all([
      t.mutation(api.example.record, {
        meter: "api",
        subjectRef: "o",
        quantity: 1,
        period: "p",
        idempotencyKey: "race",
      }),
      t.mutation(api.example.record, {
        meter: "api",
        subjectRef: "o",
        quantity: 1,
        period: "p",
        idempotencyKey: "race",
      }),
    ]);
    expect(results.filter((r) => r.recorded === true)).toHaveLength(1);
    expect(
      await t.query(api.example.usage, { meter: "api", subjectRef: "o", period: "p" }),
    ).toMatchObject({ value: 1, count: 1 });
  });

  test("pruneSeen removes old idempotency keys", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    await t.mutation(api.example.record, {
      meter: "api",
      subjectRef: "o",
      quantity: 1,
      period: "p",
      idempotencyKey: "old",
    });
    vi.setSystemTime(1_000);
    expect(await t.mutation(api.example.pruneSeen, { before: 1_000 })).toBe(1);
    // key gone → the same key now counts again
    expect(
      await t.mutation(api.example.record, {
        meter: "api",
        subjectRef: "o",
        quantity: 1,
        period: "p",
        idempotencyKey: "old",
      }),
    ).toMatchObject({ recorded: true });
  });
});

describe("metering — closePeriod (freeze)", () => {
  test("closing a period freezes it; record/adjust then throw PERIOD_CLOSED", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 5, period: "p" });
    expect(
      await t.mutation(api.example.closePeriod, { meter: "api", subjectRef: "o", period: "p" }),
    ).toBe(true);
    expect(
      await t.query(api.example.usage, { meter: "api", subjectRef: "o", period: "p" }),
    ).toMatchObject({ closed: true });
    await expect(
      t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 1, period: "p" }),
    ).rejects.toThrow(/PERIOD_CLOSED|closed/);
    await expect(
      t.mutation(api.example.adjust, { meter: "api", subjectRef: "o", delta: -1, period: "p" }),
    ).rejects.toThrow(/PERIOD_CLOSED|closed/);
  });

  test("closing a period with no usage returns false", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api" });
    expect(
      await t.mutation(api.example.closePeriod, { meter: "api", subjectRef: "nobody", period: "p" }),
    ).toBe(false);
  });
});

describe("metering — adjust (signed corrections, sum-only)", () => {
  test("adjust corrects a sum rollup up and down, never below zero", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    // adjust with no prior rollup (positive) seeds it
    expect(
      await t.mutation(api.example.adjust, { meter: "api", subjectRef: "o", delta: 10, period: "p" }),
    ).toEqual({ recorded: true, value: 10, count: 1 });
    // negative correction
    expect(
      await t.mutation(api.example.adjust, { meter: "api", subjectRef: "o", delta: -3, period: "p" }),
    ).toEqual({ recorded: true, value: 7, count: 2 });
    // verify the rollup still equals the sum of records
    expect(
      (await t.query(api.example.verify, { meter: "api", subjectRef: "o", period: "p" })).consistent,
    ).toBe(true);
    // an over-correction is rejected
    await expect(
      t.mutation(api.example.adjust, { meter: "api", subjectRef: "o", delta: -100, period: "p" }),
    ).rejects.toThrow(/ADJUST_BELOW_ZERO|negative/);
  });

  test("adjust rejects a non-finite delta, an undefined meter, and a non-sum meter", async () => {
    const t = setup();
    await expect(
      t.mutation(api.example.adjust, { meter: "ghost", subjectRef: "o", delta: 1, period: "p" }),
    ).rejects.toThrow();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    await expect(
      t.mutation(api.example.adjust, { meter: "api", subjectRef: "o", delta: Infinity, period: "p" }),
    ).rejects.toThrow();
    await t.mutation(api.example.defineMeter, { key: "gauge", aggregation: "max" });
    await expect(
      t.mutation(api.example.adjust, { meter: "gauge", subjectRef: "o", delta: 1, period: "p" }),
    ).rejects.toThrow(/ADJUST_REQUIRES_SUM|sum/);
  });

  test("adjust is idempotent via idempotencyKey", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 5, period: "p" });
    expect(
      await t.mutation(api.example.adjust, {
        meter: "api",
        subjectRef: "o",
        delta: -2,
        period: "p",
        idempotencyKey: "refund_1",
      }),
    ).toEqual({ recorded: true, value: 3, count: 2 });
    expect(
      await t.mutation(api.example.adjust, {
        meter: "api",
        subjectRef: "o",
        delta: -2,
        period: "p",
        idempotencyKey: "refund_1",
      }),
    ).toEqual({ recorded: false, reason: "duplicate" });
  });
});

describe("metering — recordWithLimit (atomic enforcement)", () => {
  test("records under the limit, refuses over it, and dedups", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    // first call seeds the rollup (under limit) — rollup-null branch
    expect(
      await t.mutation(api.example.recordWithLimit, {
        meter: "api",
        subjectRef: "o",
        quantity: 3,
        limit: 10,
        period: "p",
        idempotencyKey: "a",
      }),
    ).toEqual({ recorded: true, value: 3, count: 1 });
    // duplicate key, still under the limit (3+3=6 ≤ 10) → duplicate
    expect(
      await t.mutation(api.example.recordWithLimit, {
        meter: "api",
        subjectRef: "o",
        quantity: 3,
        limit: 10,
        period: "p",
        idempotencyKey: "a",
      }),
    ).toEqual({ recorded: false, reason: "duplicate" });
    // a big event would cross the limit (3+20 > 10) → refused, value unchanged
    expect(
      await t.mutation(api.example.recordWithLimit, {
        meter: "api",
        subjectRef: "o",
        quantity: 20,
        limit: 10,
        period: "p",
      }),
    ).toEqual({ recorded: false, reason: "limit_exceeded", value: 3, limit: 10 });
    // a small event still fits (3+2=5 ≤ 10) — rollup-present branch
    expect(
      await t.mutation(api.example.recordWithLimit, {
        meter: "api",
        subjectRef: "o",
        quantity: 2,
        limit: 10,
        period: "p",
      }),
    ).toMatchObject({ recorded: true, value: 5 });
  });

  test("recordWithLimit validates quantity, meter, and the gauge guard", async () => {
    const t = setup();
    await expect(
      t.mutation(api.example.recordWithLimit, {
        meter: "ghost",
        subjectRef: "o",
        quantity: 1,
        limit: 10,
        period: "p",
      }),
    ).rejects.toThrow();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    await expect(
      t.mutation(api.example.recordWithLimit, {
        meter: "api",
        subjectRef: "o",
        quantity: -1,
        limit: 10,
        period: "p",
      }),
    ).rejects.toThrow();
    await t.mutation(api.example.defineMeter, { key: "gauge", aggregation: "max" });
    await expect(
      t.mutation(api.example.recordWithLimit, {
        meter: "gauge",
        subjectRef: "o",
        quantity: 1,
        limit: 10,
        period: "p",
        idempotencyKey: "k",
      }),
    ).rejects.toThrow();
  });

  test("recordWithLimit refuses recording into a closed period", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 1, period: "p" });
    await t.mutation(api.example.closePeriod, { meter: "api", subjectRef: "o", period: "p" });
    await expect(
      t.mutation(api.example.recordWithLimit, {
        meter: "api",
        subjectRef: "o",
        quantity: 1,
        limit: 100,
        period: "p",
      }),
    ).rejects.toThrow(/PERIOD_CLOSED|closed/);
  });
});

describe("metering — usage / listUsage / listMeters / verify reads", () => {
  test("usage is null for an unmetered subject; listMeters lists the scope", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum", unit: "req" });
    expect(
      await t.query(api.example.usage, { meter: "api", subjectRef: "nobody", period: "p" }),
    ).toBeNull();
    expect((await t.query(api.example.listMeters, {})).map((m) => m.key)).toEqual(["api"]);
    expect(await t.query(api.example.listMeters, { scope: "empty" })).toEqual([]);
  });

  test("listUsage + listSubjectUsage report a subject's periods/meters", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    await t.mutation(api.example.defineMeter, { key: "gb", aggregation: "sum" });
    await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 1, period: "2026-05" });
    await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 2, period: "2026-06" });
    await t.mutation(api.example.record, { meter: "gb", subjectRef: "o", quantity: 9, period: "2026-06" });
    expect(await t.query(api.example.listUsage, { meter: "api", subjectRef: "o" })).toHaveLength(2);
    expect(await t.query(api.example.listSubjectUsage, { subjectRef: "o" })).toHaveLength(3);
    expect(await t.query(api.example.listSubjectUsage, { subjectRef: "nobody" })).toEqual([]);
  });

  test("verify reconciles, flags inconsistency after a prune, and rejects an unknown meter", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    // no usage yet → consistent zeros (rollup null branch)
    expect(await t.query(api.example.verify, { meter: "api", subjectRef: "o", period: "p" })).toEqual({
      rollupValue: 0,
      rollupCount: 0,
      recomputedValue: 0,
      recordsRemaining: 0,
      consistent: true,
    });
    await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 2, period: "p" });
    await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 3, period: "p" });
    const ok = await t.query(api.example.verify, { meter: "api", subjectRef: "o", period: "p" });
    expect(ok).toMatchObject({ rollupValue: 5, recomputedValue: 5, recordsRemaining: 2, consistent: true });
    // prune records → rollup survives but can't be recomputed → inconsistent
    vi.setSystemTime(1_000);
    await t.mutation(api.example.pruneRecords, { before: 1_000 });
    const pruned = await t.query(api.example.verify, { meter: "api", subjectRef: "o", period: "p" });
    expect(pruned).toMatchObject({ rollupValue: 5, recordsRemaining: 0, consistent: false });
    await expect(
      t.query(api.example.verify, { meter: "ghost", subjectRef: "o", period: "p" }),
    ).rejects.toThrow();
  });
});

describe("metering — reset (batched)", () => {
  test("reset clears a period's records + rollup in self-rescheduling batches", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 1, period: "p" });
    }
    const firstPass = await t.mutation(api.example.reset, {
      meter: "api",
      subjectRef: "o",
      period: "p",
      batch: 2,
    });
    expect(firstPass).toBe(2);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await t.query(api.example.usage, { meter: "api", subjectRef: "o", period: "p" }),
    ).toBeNull();
  });

  test("reset on a period with no usage returns 0", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api" });
    expect(
      await t.mutation(api.example.reset, { meter: "api", subjectRef: "o", period: "p", batch: 200 }),
    ).toBe(0);
  });
});

describe("metering — eraseSubject (GDPR)", () => {
  test("erases a subject across every meter + period", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    await t.mutation(api.example.defineMeter, { key: "gb", aggregation: "sum" });
    await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 1, period: "p1" });
    await t.mutation(api.example.record, { meter: "gb", subjectRef: "o", quantity: 9, period: "p1" });
    const firstPass = await t.mutation(api.example.eraseSubject, { subjectRef: "o", batch: 1 });
    expect(firstPass).toBeGreaterThan(0);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.example.listSubjectUsage, { subjectRef: "o" })).toEqual([]);
  });

  test("erasing an unknown subject removes nothing (0)", async () => {
    const t = setup();
    expect(await t.mutation(api.example.eraseSubject, { subjectRef: "ghost", batch: 200 })).toBe(0);
  });
});

describe("metering — pruneRecords / pruneSeen (bounded, self-rescheduling)", () => {
  test("prune with the default batch on an empty table returns 0", async () => {
    const t = setup();
    expect(await t.mutation(api.example.pruneRecordsDefaults, { before: 9_999 })).toBe(0);
  });

  test("pruneRecords self-reschedules on a full batch and clears the tail", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    for (let i = 0; i < 3; i++) {
      await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 1, period: "p" });
    }
    vi.setSystemTime(1_000);
    expect(await t.mutation(api.example.pruneRecords, { before: 1_000, batch: 2 })).toBe(2);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      (await t.query(api.example.verify, { meter: "api", subjectRef: "o", period: "p" }))
        .recordsRemaining,
    ).toBe(0);
  });

  test("pruneSeen self-reschedules on a full batch and clears the tail", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    for (const k of ["k1", "k2", "k3"]) {
      await t.mutation(api.example.record, {
        meter: "api",
        subjectRef: "o",
        quantity: 1,
        period: "p",
        idempotencyKey: k,
      });
    }
    vi.setSystemTime(1_000);
    expect(await t.mutation(api.example.pruneSeen, { before: 1_000, batch: 2 })).toBe(2);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // all keys pruned → "k1" counts again
    expect(
      await t.mutation(api.example.record, {
        meter: "api",
        subjectRef: "o",
        quantity: 1,
        period: "p",
        idempotencyKey: "k1",
      }),
    ).toMatchObject({ recorded: true });
  });
});

describe("metering — scoped client (defaultScope + defaultPeriod)", () => {
  test("scoped client meters + records + reads in its default scope/period", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeterScoped, { key: "seats" });
    expect(await t.query(api.example.getMeter, { key: "seats" })).toBeNull();
    expect((await t.query(api.example.getMeterScoped, { key: "seats" }))?.scope).toBe("tenant");
    expect((await t.query(api.example.listMetersScoped, {})).map((m) => m.key)).toEqual(["seats"]);
    await t.mutation(api.example.recordScoped, { meter: "seats", subjectRef: "o", quantity: 3 });
    expect(await t.query(api.example.usageScoped, { meter: "seats", subjectRef: "o" })).toMatchObject({
      value: 3,
      count: 1,
    });
    expect(await t.query(api.example.listUsageScoped, { meter: "seats", subjectRef: "o" })).toHaveLength(1);
    expect(await t.query(api.example.listSubjectUsageScoped, { subjectRef: "o" })).toHaveLength(1);
    expect(
      (await t.query(api.example.verifyScoped, { meter: "seats", subjectRef: "o" })).consistent,
    ).toBe(true);
    expect(
      await t.mutation(api.example.recordWithLimitScoped, {
        meter: "seats",
        subjectRef: "o",
        quantity: 1,
        limit: 100,
      }),
    ).toMatchObject({ recorded: true });
    expect(
      await t.mutation(api.example.adjustScoped, { meter: "seats", subjectRef: "o", delta: -1 }),
    ).toMatchObject({ recorded: true });
    expect(await t.mutation(api.example.closePeriodScoped, { meter: "seats", subjectRef: "o" })).toBe(true);
    // reset removes the period's records (returns the count this pass), then drains
    expect(await t.mutation(api.example.resetScoped, { meter: "seats", subjectRef: "o" })).toBeGreaterThan(0);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // nothing left for the subject → erase removes 0
    expect(await t.mutation(api.example.eraseSubjectScoped, { subjectRef: "o" })).toBe(0);
  });
});

describe("metering — host-side billing (boundary)", () => {
  test("the host turns a period's usage into a bill at its own rate", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum", unit: "requests" });
    await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 1000, period: "2026-06" });
    const amount = await t.mutation(api.example.billFromUsage, {
      meter: "api",
      subjectRef: "o",
      period: "2026-06",
      rate: 0.002,
    });
    expect(amount).toBe(2);
    expect(await t.query(api.example.invoiceTotal, { subjectRef: "o", period: "2026-06" })).toBe(2);
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
