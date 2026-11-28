import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components } from "./_generated/api";
import schema from "./schema";
import { Metering } from "../../src/client";
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
    ).rejects.toThrow(/INVALID_QUANTITY/);
    await expect(
      t.mutation(api.example.record, { meter: "m", subjectRef: "s", quantity: Infinity }),
    ).rejects.toThrow(/INVALID_QUANTITY/);
  });

  test("recording against an undefined meter is rejected", async () => {
    const t = setup();
    await expect(
      t.mutation(api.example.record, { meter: "ghost", subjectRef: "s", quantity: 1 }),
    ).rejects.toThrow(/METER_NOT_FOUND/);
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
    ).rejects.toThrow(/METER_NOT_FOUND/);
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    await expect(
      t.mutation(api.example.adjust, { meter: "api", subjectRef: "o", delta: Infinity, period: "p" }),
    ).rejects.toThrow(/INVALID_QUANTITY/);
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
        actorRef: "support-agent",
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
        actorRef: "worker-7",
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

  test("records a value that lands exactly on the limit and refuses one unit more", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    const call = { meter: "api", subjectRef: "o", limit: 10, period: "p" };
    await t.mutation(api.example.recordWithLimit, { ...call, quantity: 4 });
    // 4 + 6 = 10 is not over the limit (`<= limit`) → recorded
    expect(await t.mutation(api.example.recordWithLimit, { ...call, quantity: 6 })).toEqual({
      recorded: true,
      value: 10,
      count: 2,
    });
    // 10 + 1 = 11 is over it → refused, value unchanged
    expect(await t.mutation(api.example.recordWithLimit, { ...call, quantity: 1 })).toEqual({
      recorded: false,
      reason: "limit_exceeded",
      value: 10,
      limit: 10,
    });
  });

  test("a duplicate stays a duplicate even when the current projection exceeds its limit", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    const original = {
      meter: "api",
      subjectRef: "o",
      quantity: 3,
      limit: 10,
      period: "p",
      idempotencyKey: "same-delivery",
    };
    expect(await t.mutation(api.example.recordWithLimit, original)).toMatchObject({
      recorded: true,
    });
    await t.mutation(api.example.record, {
      meter: "api",
      subjectRef: "o",
      quantity: 7,
      period: "p",
    });
    expect(
      await t.mutation(api.example.recordWithLimit, { ...original, limit: 1 }),
    ).toEqual({ recorded: false, reason: "duplicate" });
  });

  test("recordWithLimit validates quantity, limit, meter, and the gauge guard", async () => {
    const t = setup();
    await expect(
      t.mutation(api.example.recordWithLimit, {
        meter: "ghost",
        subjectRef: "o",
        quantity: 1,
        limit: 10,
        period: "p",
      }),
    ).rejects.toThrow(/METER_NOT_FOUND/);
    await t.mutation(api.example.defineMeter, { key: "api", aggregation: "sum" });
    await expect(
      t.mutation(api.example.recordWithLimit, {
        meter: "api",
        subjectRef: "o",
        quantity: -1,
        limit: 10,
        period: "p",
      }),
    ).rejects.toThrow(/INVALID_QUANTITY/);
    for (const limit of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        t.mutation(api.example.recordWithLimit, {
          meter: "api",
          subjectRef: "o",
          quantity: 1,
          limit,
          period: "p",
        }),
      ).rejects.toThrow(/INVALID_LIMIT|non-negative finite/);
    }
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
    ).rejects.toThrow(/IDEMPOTENCY_NOT_SUPPORTED/);
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
    ).rejects.toThrow(/METER_NOT_FOUND/);
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

  test.each([0, -1, 1.5, 501, Number.NaN])("reset rejects invalid batch %s", async (batch) => {
    const t = setup();
    await expect(
      t.mutation(api.example.reset, {
        meter: "api",
        subjectRef: "o",
        period: "p",
        batch,
      }),
    ).rejects.toThrow(/INVALID_BATCH|integer between/);
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

  test("eraseSubject rejects an invalid batch", async () => {
    const t = setup();
    await expect(
      t.mutation(api.example.eraseSubject, { subjectRef: "o", batch: 0 }),
    ).rejects.toThrow(/INVALID_BATCH|integer between/);
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

  test("prune operations reject unsafe batches and non-finite cutoffs", async () => {
    const t = setup();
    await expect(
      t.mutation(api.example.pruneRecords, { before: 1, batch: 0 }),
    ).rejects.toThrow(/INVALID_BATCH|integer between/);
    await expect(
      t.mutation(api.example.pruneSeen, { before: 1, batch: 501 }),
    ).rejects.toThrow(/INVALID_BATCH|integer between/);
    await expect(
      t.mutation(api.example.pruneRecords, { before: Number.NaN, batch: 1 }),
    ).rejects.toThrow(/INVALID_BEFORE|finite/);
    await expect(
      t.mutation(api.example.pruneSeen, { before: Number.POSITIVE_INFINITY, batch: 1 }),
    ).rejects.toThrow(/INVALID_BEFORE|finite/);
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

describe("metering — counter correctness hardening", () => {
  test("a sum that would overflow to Infinity is rejected and leaves the rollup intact", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "m", aggregation: "sum" });
    const big = Number.MAX_VALUE;
    await t.mutation(api.example.record, { meter: "m", subjectRef: "s", quantity: big, period: "p" });
    await expect(
      t.mutation(api.example.record, { meter: "m", subjectRef: "s", quantity: big, period: "p" }),
    ).rejects.toThrow(/QUANTITY_OVERFLOW/);
    await expect(
      t.mutation(api.example.adjust, { meter: "m", subjectRef: "s", delta: big, period: "p" }),
    ).rejects.toThrow(/QUANTITY_OVERFLOW/);
    // recordWithLimit cannot be pushed to Infinity either: it reports limit_exceeded.
    expect(
      await t.mutation(api.example.recordWithLimit, {
        meter: "m",
        subjectRef: "s",
        quantity: big,
        limit: big,
        period: "p",
      }),
    ).toMatchObject({ recorded: false, reason: "limit_exceeded" });
    expect(await t.query(api.example.usage, { meter: "m", subjectRef: "s", period: "p" })).toEqual({
      value: big,
      count: 1,
      closed: false,
    });
  });

  test("NaN, Infinity and negative amounts never reach the rollup", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "m", aggregation: "sum" });
    for (const quantity of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      await expect(
        t.mutation(api.example.record, { meter: "m", subjectRef: "s", quantity, period: "p" }),
      ).rejects.toThrow(/INVALID_QUANTITY/);
    }
    for (const delta of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(
        t.mutation(api.example.adjust, { meter: "m", subjectRef: "s", delta, period: "p" }),
      ).rejects.toThrow(/INVALID_QUANTITY/);
    }
    expect(await t.query(api.example.usage, { meter: "m", subjectRef: "s", period: "p" })).toBeNull();
  });

  test("empty identifiers are rejected on writes", async () => {
    const t = setup();
    await expect(
      t.mutation(api.example.defineMeter, { key: "", aggregation: "sum" }),
    ).rejects.toThrow(/INVALID_ARGUMENT/);
    await t.mutation(api.example.defineMeter, { key: "m", aggregation: "sum" });
    const base = { meter: "m", subjectRef: "s", period: "p" };
    for (const bad of [{ subjectRef: "" }, { period: "" }, { meter: "" }, { idempotencyKey: "" }]) {
      await expect(
        t.mutation(api.example.record, { ...base, quantity: 1, ...bad }),
      ).rejects.toThrow(/INVALID_ARGUMENT/);
      await expect(
        t.mutation(api.example.recordWithLimit, { ...base, quantity: 1, limit: 5, ...bad }),
      ).rejects.toThrow(/INVALID_ARGUMENT/);
      await expect(
        t.mutation(api.example.adjust, { ...base, delta: 1, ...bad }),
      ).rejects.toThrow(/INVALID_ARGUMENT/);
    }
  });

  test("concurrent writes keep value and count exact; duplicate keys count once", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "m", aggregation: "sum" });
    await Promise.all([
      ...Array.from({ length: 20 }, () =>
        t.mutation(api.example.record, { meter: "m", subjectRef: "s", quantity: 2, period: "p" }),
      ),
      ...Array.from({ length: 5 }, () =>
        t.mutation(api.example.record, {
          meter: "m",
          subjectRef: "s",
          quantity: 100,
          period: "p",
          idempotencyKey: "same",
        }),
      ),
    ]);
    expect(await t.query(api.example.usage, { meter: "m", subjectRef: "s", period: "p" })).toEqual({
      value: 140,
      count: 21,
      closed: false,
    });
    expect(await t.query(api.example.verify, { meter: "m", subjectRef: "s", period: "p" })).toMatchObject({
      consistent: true,
      recordsRemaining: 21,
    });
  });

  test("concurrent recordWithLimit never overshoots the limit", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "m", aggregation: "sum" });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        t.mutation(api.example.recordWithLimit, {
          meter: "m",
          subjectRef: "s",
          quantity: 3,
          limit: 10,
          period: "p",
        }),
      ),
    );
    expect(results.filter((r) => r.recorded)).toHaveLength(3);
    expect(await t.query(api.example.usage, { meter: "m", subjectRef: "s", period: "p" })).toMatchObject({
      value: 9,
      count: 3,
    });
  });

  test("periods are independent buckets and closing one leaves the next open", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "m", aggregation: "sum" });
    const a = { meter: "m", subjectRef: "s" };
    await t.mutation(api.example.record, { ...a, quantity: 5, period: "2026-06" });
    await t.mutation(api.example.closePeriod, { ...a, period: "2026-06" });
    await t.mutation(api.example.record, { ...a, quantity: 7, period: "2026-07" });
    await expect(
      t.mutation(api.example.record, { ...a, quantity: 1, period: "2026-06" }),
    ).rejects.toThrow(/PERIOD_CLOSED/);
    expect(await t.query(api.example.listUsage, a)).toEqual([
      { period: "2026-06", value: 5, count: 1, closed: true },
      { period: "2026-07", value: 7, count: 1, closed: false },
    ]);
  });
});

describe("metering — documented limits and orderings", () => {
  test("idempotency keys are scoped to (scope, meter): another subject or period dedups, another meter or scope records", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api" });
    await t.mutation(api.example.defineMeter, { key: "gb" });
    await t.mutation(api.example.defineMeter, { key: "api", scope: "t2" });
    const keyed = { meter: "api", subjectRef: "o", quantity: 1, period: "p", idempotencyKey: "k" };
    expect(await t.mutation(api.example.record, keyed)).toMatchObject({ recorded: true });
    expect(await t.mutation(api.example.record, { ...keyed, subjectRef: "o2" })).toEqual({
      recorded: false,
      reason: "duplicate",
    });
    expect(await t.mutation(api.example.record, { ...keyed, period: "p2" })).toEqual({
      recorded: false,
      reason: "duplicate",
    });
    expect(await t.mutation(api.example.record, { ...keyed, meter: "gb" })).toMatchObject({
      recorded: true,
    });
    expect(await t.mutation(api.example.record, { ...keyed, scope: "t2" })).toMatchObject({
      recorded: true,
    });
  });

  test("keys survive reset and eraseSubject, so a replay stays a duplicate", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api" });
    const keyed = { meter: "api", subjectRef: "o", quantity: 1, period: "p", idempotencyKey: "k" };
    await t.mutation(api.example.record, keyed);
    await t.mutation(api.example.reset, { meter: "api", subjectRef: "o", period: "p" });
    expect(await t.mutation(api.example.record, keyed)).toEqual({ recorded: false, reason: "duplicate" });
    await t.mutation(api.example.record, { ...keyed, idempotencyKey: "k2" });
    await t.mutation(api.example.eraseSubject, { subjectRef: "o" });
    expect(await t.mutation(api.example.record, { ...keyed, idempotencyKey: "k2" })).toEqual({
      recorded: false,
      reason: "duplicate",
    });
    expect(await t.query(api.example.usage, { meter: "api", subjectRef: "o", period: "p" })).toBeNull();
  });

  test("PERIOD_CLOSED is checked before the duplicate check", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api" });
    const keyed = { meter: "api", subjectRef: "o", quantity: 1, period: "p", idempotencyKey: "k" };
    await t.mutation(api.example.record, keyed);
    await t.mutation(api.example.closePeriod, { meter: "api", subjectRef: "o", period: "p" });
    await expect(t.mutation(api.example.record, keyed)).rejects.toThrow(/PERIOD_CLOSED/);
    await expect(t.mutation(api.example.recordWithLimit, { ...keyed, limit: 100 })).rejects.toThrow(
      /PERIOD_CLOSED/,
    );
    await expect(
      t.mutation(api.example.adjust, { meter: "api", subjectRef: "o", delta: 1, period: "p", idempotencyKey: "k" }),
    ).rejects.toThrow(/PERIOD_CLOSED/);
  });

  test("limit_exceeded stores no key, so a retry under a higher limit records", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api" });
    const keyed = { meter: "api", subjectRef: "o", quantity: 5, period: "p", idempotencyKey: "k" };
    expect(await t.mutation(api.example.recordWithLimit, { ...keyed, limit: 4 })).toEqual({
      recorded: false,
      reason: "limit_exceeded",
      value: 0,
      limit: 4,
    });
    expect(await t.mutation(api.example.recordWithLimit, { ...keyed, limit: 10 })).toEqual({
      recorded: true,
      value: 5,
      count: 1,
    });
  });

  test("recordWithLimit projects the new peak for max and the new value for last", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "peak", aggregation: "max" });
    await t.mutation(api.example.defineMeter, { key: "gauge", aggregation: "last" });
    const peak = { meter: "peak", subjectRef: "o", period: "p", limit: 10 };
    await t.mutation(api.example.recordWithLimit, { ...peak, quantity: 8 });
    // max(8, 5) = 8 <= 10 → recorded, the peak stays 8
    expect(await t.mutation(api.example.recordWithLimit, { ...peak, quantity: 5 })).toEqual({
      recorded: true,
      value: 8,
      count: 2,
    });
    // max(8, 12) = 12 > 10 → refused
    expect(await t.mutation(api.example.recordWithLimit, { ...peak, quantity: 12 })).toEqual({
      recorded: false,
      reason: "limit_exceeded",
      value: 8,
      limit: 10,
    });
    const gauge = { meter: "gauge", subjectRef: "o", period: "p", limit: 5 };
    await t.mutation(api.example.record, { meter: "gauge", subjectRef: "o", period: "p", quantity: 8 });
    // last: the projection is the new value 3, not 8 or 8 + 3
    expect(await t.mutation(api.example.recordWithLimit, { ...gauge, quantity: 3 })).toEqual({
      recorded: true,
      value: 3,
      count: 2,
    });
    expect(await t.mutation(api.example.recordWithLimit, { ...gauge, quantity: 6 })).toEqual({
      recorded: false,
      reason: "limit_exceeded",
      value: 3,
      limit: 5,
    });
  });

  test("reset and eraseSubject delete closed periods", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api" });
    for (const subjectRef of ["a", "b"]) {
      await t.mutation(api.example.record, { meter: "api", subjectRef, quantity: 1, period: "p" });
      await t.mutation(api.example.closePeriod, { meter: "api", subjectRef, period: "p" });
    }
    expect(await t.mutation(api.example.reset, { meter: "api", subjectRef: "a", period: "p" })).toBe(1);
    expect(await t.query(api.example.usage, { meter: "api", subjectRef: "a", period: "p" })).toBeNull();
    expect(await t.mutation(api.example.eraseSubject, { subjectRef: "b" })).toBe(2);
    expect(await t.query(api.example.listSubjectUsage, { subjectRef: "b" })).toEqual([]);
  });

  test("eraseSubject stays in its scope; pruneRecords and pruneSeen span every scope", async () => {
    const t = setup();
    for (const scope of ["a", "b"]) {
      await t.mutation(api.example.defineMeter, { key: "api", scope });
      await t.mutation(api.example.record, {
        meter: "api",
        subjectRef: "o",
        quantity: 1,
        period: "p",
        scope,
        idempotencyKey: "k",
      });
    }
    expect(await t.mutation(api.example.eraseSubject, { subjectRef: "o", scope: "a" })).toBe(2);
    expect(await t.query(api.example.listSubjectUsage, { subjectRef: "o", scope: "a" })).toEqual([]);
    expect(await t.query(api.example.listSubjectUsage, { subjectRef: "o", scope: "b" })).toHaveLength(1);

    await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 1, period: "p", scope: "a" });
    vi.setSystemTime(1_000);
    expect(await t.mutation(api.example.pruneRecords, { before: 1_000 })).toBe(2);
    for (const scope of ["a", "b"]) {
      expect(
        (await t.query(api.example.verify, { meter: "api", subjectRef: "o", period: "p", scope }))
          .recordsRemaining,
      ).toBe(0);
    }
    expect(await t.mutation(api.example.pruneSeen, { before: 1_000 })).toBe(2);
    for (const scope of ["a", "b"]) {
      expect(
        await t.mutation(api.example.record, {
          meter: "api",
          subjectRef: "o",
          quantity: 1,
          period: "p",
          scope,
          idempotencyKey: "k",
        }),
      ).toMatchObject({ recorded: true });
    }
  });

  test("listUsage sorts by period string; unknown meters read as null or []", async () => {
    const t = setup();
    await t.mutation(api.example.defineMeter, { key: "api" });
    for (const period of ["2026-07", "2026-05", "2026-06"]) {
      await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 1, period });
    }
    expect(
      (await t.query(api.example.listUsage, { meter: "api", subjectRef: "o" })).map((e) => e.period),
    ).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(await t.query(api.example.listUsage, { meter: "ghost", subjectRef: "o" })).toEqual([]);
    expect(await t.query(api.example.usage, { meter: "ghost", subjectRef: "o", period: "p" })).toBeNull();
    expect(await t.query(api.example.getMeter, { key: "ghost" })).toBeNull();
  });

  test("listSubjectUsage returns rollups in creation order, and listMeters meters in definition order", async () => {
    const t = setup();
    for (const key of ["gb", "api"]) {
      await t.mutation(api.example.defineMeter, { key });
    }
    // re-defining keeps a meter's place
    await t.mutation(api.example.defineMeter, { key: "gb", unit: "GB" });
    expect((await t.query(api.example.listMeters, {})).map((m) => m.key)).toEqual(["gb", "api"]);

    const lines = async () =>
      (await t.query(api.example.listSubjectUsage, { subjectRef: "o" })).map((e) => `${e.meter}/${e.period}`);
    await t.mutation(api.example.record, { meter: "gb", subjectRef: "o", quantity: 1, period: "2026-07" });
    await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 1, period: "2026-06" });
    await t.mutation(api.example.record, { meter: "api", subjectRef: "o", quantity: 1, period: "2026-05" });
    // a later write to an existing rollup keeps its place
    await t.mutation(api.example.record, { meter: "gb", subjectRef: "o", quantity: 1, period: "2026-07" });
    expect(await lines()).toEqual(["gb/2026-07", "api/2026-06", "api/2026-05"]);
    // a period cleared by reset and recorded again is a new rollup, so it moves to the end
    await t.mutation(api.example.reset, { meter: "gb", subjectRef: "o", period: "2026-07" });
    await t.mutation(api.example.record, { meter: "gb", subjectRef: "o", quantity: 1, period: "2026-07" });
    expect(await lines()).toEqual(["api/2026-06", "api/2026-05", "gb/2026-07"]);
  });

  test("an empty defaultScope or defaultPeriod makes writes throw INVALID_ARGUMENT", async () => {
    const t = setup();
    const noScope = new Metering(components.metering, { defaultScope: "" });
    const noPeriod = new Metering(components.metering, { defaultPeriod: "" });
    const longPeriod = new Metering(components.metering, { defaultPeriod: "x".repeat(257) });
    await expect(t.run((ctx) => noScope.defineMeter(ctx, "api"))).rejects.toThrow(
      /INVALID_ARGUMENT.*scope must not be an empty string/,
    );
    await t.run((ctx) => noPeriod.defineMeter(ctx, "api"));
    await expect(t.run((ctx) => noPeriod.record(ctx, "api", "o", 1))).rejects.toThrow(
      /INVALID_ARGUMENT.*period must not be an empty string/,
    );
    await expect(t.run((ctx) => longPeriod.record(ctx, "api", "o", 1))).rejects.toThrow(
      /INVALID_ARGUMENT.*period must be at most 256 characters/,
    );
  });
});
