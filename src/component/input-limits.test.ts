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

const MAX = 256;
const atMax = "x".repeat(MAX);
const overMax = "x".repeat(MAX + 1);

/** The thrown `ConvexError` for an over-long `field` (any field when omitted). */
function rejected(field = "\\w+"): RegExp {
  return new RegExp(
    `INVALID_ARGUMENT.*"${field} must be at most ${String(MAX)} characters`,
  );
}

async function snapshot(t: T) {
  return t.run(async (ctx) => ({
    meters: await ctx.db.query("meters").collect(),
    records: await ctx.db.query("records").collect(),
    rollups: await ctx.db.query("rollups").collect(),
    seen: await ctx.db.query("seen").collect(),
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

const meterFields = ["scope", "key", "unit"] as const;
const usageFields = [
  "scope",
  "meter",
  "subjectRef",
  "period",
  "idempotencyKey",
  "actorRef",
] as const;
const usageCalls = ["record", "recordWithLimit", "adjust"] as const;
type UsageField = (typeof usageFields)[number];
type UsageCall = (typeof usageCalls)[number];

function defineArgs(field: (typeof meterFields)[number], value: string) {
  return {
    scope: "s",
    key: "m",
    aggregation: "sum" as const,
    unit: "",
    [field]: value,
  };
}

/** Call a usage write with `field` set to `value`, defining the meter it names first. */
async function callUsage(
  t: T,
  fn: UsageCall,
  field: UsageField,
  value: string,
) {
  const args = {
    scope: "s",
    meter: "m",
    subjectRef: "o",
    period: "p",
    [field]: value,
  };
  if (value.length <= MAX) {
    await t.mutation(api.mutations.defineMeter, {
      scope: args.scope,
      key: args.meter,
      aggregation: "sum",
      unit: "",
    });
  }
  if (fn === "record") {
    return t.mutation(api.mutations.record, { ...args, quantity: 1 });
  }
  if (fn === "recordWithLimit") {
    return t.mutation(api.mutations.recordWithLimit, {
      ...args,
      quantity: 1,
      limit: 10,
    });
  }
  return t.mutation(api.mutations.adjust, { ...args, delta: 1 });
}

describe("string arguments are capped at 256 UTF-16 code units", () => {
  test.each(meterFields)(
    "defineMeter accepts a 256-character %s",
    async (field) => {
      const t = setup();
      expect(
        await t.mutation(api.mutations.defineMeter, defineArgs(field, atMax)),
      ).toEqual({
        created: true,
      });
      const [meter] = (await snapshot(t)).meters;
      expect(meter?.[field]).toBe(atMax);
    },
  );

  test.each(meterFields)(
    "defineMeter rejects a 257-character %s and writes nothing",
    async (field) => {
      const t = setup();
      await expect(
        t.mutation(api.mutations.defineMeter, defineArgs(field, overMax)),
      ).rejects.toThrow(rejected(field));
      expect((await snapshot(t)).meters).toEqual([]);
    },
  );

  const cases = usageCalls.flatMap((fn) =>
    usageFields.map((field) => [fn, field] as const),
  );

  test.each(cases)("%s accepts a 256-character %s", async (fn, field) => {
    const t = setup();
    expect(await callUsage(t, fn, field, atMax)).toMatchObject({
      recorded: true,
      count: 1,
    });
    const [row] = (await snapshot(t)).records;
    const stored = field === "meter" ? row?.meterKey : row?.[field];
    expect(stored).toBe(atMax);
  });

  test.each(cases)(
    "%s rejects a 257-character %s and writes nothing",
    async (fn, field) => {
      const t = setup();
      await t.mutation(api.mutations.defineMeter, {
        scope: "s",
        key: "m",
        aggregation: "sum",
        unit: "",
      });
      const before = await snapshot(t);
      await expect(callUsage(t, fn, field, overMax)).rejects.toThrow(
        rejected(field),
      );
      expect(await snapshot(t)).toEqual(before);
    },
  );

  test("length counts UTF-16 code units: a 2-unit emoji counts as 2, a 2-byte character as 1", async () => {
    const t = setup();
    await t.mutation(api.mutations.defineMeter, {
      scope: "s",
      key: "m",
      aggregation: "sum",
      unit: "",
    });
    const base = { scope: "s", meter: "m", period: "p", quantity: 1 };
    const emoji = "\u{1F600}"; // 2 UTF-16 code units, 1 code point, 4 UTF-8 bytes
    const accented = "é"; // 1 UTF-16 code unit, 2 UTF-8 bytes
    expect(emoji.length).toBe(2);

    // 128 emoji = 256 code units (512 UTF-8 bytes): accepted, so the cap is not in bytes.
    expect(
      await t.mutation(api.mutations.record, {
        ...base,
        subjectRef: emoji.repeat(128),
      }),
    ).toMatchObject({ recorded: true });
    // 128 emoji + 1 letter = 257 code units but only 129 code points: rejected, so the cap is
    // not in code points.
    await expect(
      t.mutation(api.mutations.record, {
        ...base,
        subjectRef: `${emoji.repeat(128)}x`,
      }),
    ).rejects.toThrow(rejected("subjectRef"));
    // 256 two-byte characters = 256 code units (512 UTF-8 bytes): accepted; one more is rejected.
    expect(
      await t.mutation(api.mutations.record, {
        ...base,
        subjectRef: accented.repeat(256),
      }),
    ).toMatchObject({ recorded: true });
    await expect(
      t.mutation(api.mutations.record, {
        ...base,
        subjectRef: accented.repeat(257),
      }),
    ).rejects.toThrow(rejected("subjectRef"));
  });
});

describe("rows stored before the cap with longer values", () => {
  const long = "y".repeat(300);
  const other = "z".repeat(300);

  /** Write rows the way an older version could: every string field over the cap. */
  async function seedLegacy(t: T): Promise<void> {
    await t.run(async (ctx) => {
      await ctx.db.insert("meters", {
        scope: long,
        key: long,
        aggregation: "sum",
        unit: long,
        createdAt: 0,
      });
      for (const subjectRef of [long, other]) {
        await ctx.db.insert("records", {
          scope: long,
          meterKey: long,
          subjectRef,
          quantity: 5,
          period: long,
          idempotencyKey: `${subjectRef}-key`,
          actorRef: long,
          recordedAt: 0,
        });
        await ctx.db.insert("seen", {
          scope: long,
          meterKey: long,
          idempotencyKey: `${subjectRef}-key`,
          seenAt: 0,
        });
        await ctx.db.insert("rollups", {
          scope: long,
          meterKey: long,
          subjectRef,
          period: long,
          value: 5,
          count: 1,
          updatedAt: 0,
        });
      }
    });
  }

  const target = { scope: long, meter: long, subjectRef: long, period: long };

  test("queries still return them", async () => {
    const t = setup();
    await seedLegacy(t);
    expect(
      await t.query(api.queries.getMeter, { scope: long, key: long }),
    ).toMatchObject({ key: long, scope: long, unit: long, aggregation: "sum" });
    expect(await t.query(api.queries.listMeters, { scope: long })).toHaveLength(
      1,
    );
    expect(await t.query(api.queries.usage, target)).toEqual({
      value: 5,
      count: 1,
      closed: false,
    });
    expect(
      await t.query(api.queries.listUsage, {
        scope: long,
        meter: long,
        subjectRef: long,
      }),
    ).toEqual([{ period: long, value: 5, count: 1, closed: false }]);
    expect(
      await t.query(api.queries.listSubjectUsage, {
        scope: long,
        subjectRef: long,
      }),
    ).toEqual([
      { meter: long, period: long, value: 5, count: 1, closed: false },
    ]);
    expect(await t.query(api.queries.verify, target)).toMatchObject({
      consistent: true,
      recordsRemaining: 1,
    });
  });

  test("recording, adjusting or redefining into them throws INVALID_ARGUMENT and writes nothing", async () => {
    const t = setup();
    await seedLegacy(t);
    const before = await snapshot(t);
    await expect(
      t.mutation(api.mutations.record, { ...target, quantity: 1 }),
    ).rejects.toThrow(rejected());
    await expect(
      t.mutation(api.mutations.recordWithLimit, {
        ...target,
        quantity: 1,
        limit: 100,
      }),
    ).rejects.toThrow(rejected());
    await expect(
      t.mutation(api.mutations.adjust, { ...target, delta: -1 }),
    ).rejects.toThrow(rejected());
    await expect(
      t.mutation(api.mutations.defineMeter, {
        scope: long,
        key: long,
        aggregation: "sum",
        unit: "",
      }),
    ).rejects.toThrow(rejected());
    expect(await snapshot(t)).toEqual(before);
  });

  test("a long legacy subject on a short meter rejects new usage; a shorter subject records", async () => {
    const t = setup();
    await t.mutation(api.mutations.defineMeter, {
      scope: "s",
      key: "m",
      aggregation: "sum",
      unit: "",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("rollups", {
        scope: "s",
        meterKey: "m",
        subjectRef: long,
        period: "p",
        value: 5,
        count: 1,
        updatedAt: 0,
      });
    });
    const base = { scope: "s", meter: "m", period: "p", quantity: 1 };
    await expect(
      t.mutation(api.mutations.record, { ...base, subjectRef: long }),
    ).rejects.toThrow(rejected("subjectRef"));
    expect(
      await t.mutation(api.mutations.record, {
        ...base,
        subjectRef: long.slice(0, MAX),
      }),
    ).toMatchObject({ recorded: true, value: 1, count: 1 });
    expect(
      await t.query(api.queries.usage, {
        scope: "s",
        meter: "m",
        subjectRef: long,
        period: "p",
      }),
    ).toEqual({ value: 5, count: 1, closed: false });
  });

  test("closePeriod, reset, eraseSubject, pruneRecords and pruneSeen still work on them", async () => {
    const t = setup();
    await seedLegacy(t);

    expect(await t.mutation(api.mutations.closePeriod, target)).toBe(true);
    expect(await t.query(api.queries.usage, target)).toMatchObject({
      closed: true,
    });

    expect(
      await t.mutation(api.mutations.reset, { ...target, batch: 10 }),
    ).toBe(1);
    expect(await t.query(api.queries.usage, target)).toBeNull();

    expect(
      await t.mutation(api.mutations.eraseSubject, {
        scope: long,
        subjectRef: other,
        batch: 10,
      }),
    ).toBe(2);
    expect(
      await t.query(api.queries.listSubjectUsage, {
        scope: long,
        subjectRef: other,
      }),
    ).toEqual([]);

    await t.run(async (ctx) => {
      await ctx.db.insert("records", {
        scope: long,
        meterKey: long,
        subjectRef: long,
        quantity: 1,
        period: long,
        actorRef: long,
        recordedAt: 0,
      });
    });
    expect(
      await t.mutation(api.mutations.pruneRecords, { before: 1, batch: 10 }),
    ).toBe(1);
    expect(
      await t.mutation(api.mutations.pruneSeen, { before: 1, batch: 10 }),
    ).toBe(2);

    const after = await snapshot(t);
    expect(after.records).toEqual([]);
    expect(after.rollups).toEqual([]);
    expect(after.seen).toEqual([]);
  });
});
