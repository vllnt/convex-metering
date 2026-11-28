/// <reference types="vite/client" />
import { componentsGeneric, defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Metering } from "./client/index.js";
import type { ComponentApi } from "./component/_generated/component.js";
import { register } from "./test.js";

/**
 * A host app's schema: its own tables, none of the component's. `register` must accept
 * the `convexTest` instance built from it; `pnpm typecheck:ci` fails if it does not.
 */
const hostSchema = defineSchema({
  notes: defineTable({ body: v.string() }),
});

const modules = import.meta.glob("./component/**/*.ts");

// What host codegen would emit as `components` for the two mounts registered below.
const components = componentsGeneric() as unknown as {
  metering: ComponentApi<"metering">;
  otherMetering: ComponentApi<"otherMetering">;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

test("register accepts a host app's convexTest instance and keeps its data model", async () => {
  const t = convexTest(hostSchema, modules);
  register(t);
  register(t, "otherMetering");

  const id = await t.run((ctx) => ctx.db.insert("notes", { body: "hello" }));
  const note = await t.run((ctx) => ctx.db.get(id));
  expect(note?.body).toBe("hello");

  // Both mounts are callable through the host instance and keep separate data.
  const metering = new Metering(components.metering);
  const other = new Metering(components.otherMetering);
  await t.run(async (ctx) => {
    await metering.defineMeter(ctx, "api");
    await metering.record(ctx, "api", "org", 3, { period: "p" });
  });
  expect(await t.run((ctx) => metering.usage(ctx, "api", "org", { period: "p" }))).toMatchObject({
    value: 3,
    count: 1,
  });
  expect(await t.run((ctx) => other.usage(ctx, "api", "org", { period: "p" }))).toBeNull();
});
