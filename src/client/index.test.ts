import type { FunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import { Metering, type MeteringComponent } from "./index.js";

/**
 * Unit tests of the client's argument forwarding, against a fake ctx that captures
 * what each method sends to the component. No component query exposes `actorRef`,
 * so these are what fail if the client stops forwarding it.
 */
function fakeCtx() {
  const calls: { ref: unknown; args: Record<string, unknown> }[] = [];
  const ctx = {
    runMutation: (ref: FunctionReference<"mutation", "internal">, args: Record<string, unknown>) => {
      calls.push({ ref, args });
      return Promise.resolve({ recorded: true, value: 0, count: 0 });
    },
  } as unknown as Parameters<Metering["record"]>[0];
  return { ctx, calls };
}

const component = {
  mutations: { record: "record", recordWithLimit: "recordWithLimit", adjust: "adjust" },
} as unknown as MeteringComponent;

describe("Metering forwards actorRef", () => {
  test("record, recordWithLimit and adjust send actorRef when set", async () => {
    const { ctx, calls } = fakeCtx();
    const metering = new Metering(component);
    await metering.record(ctx, "api", "o", 1, { actorRef: "a-record" });
    await metering.recordWithLimit(ctx, "api", "o", 1, 10, { actorRef: "a-limit" });
    await metering.adjust(ctx, "api", "o", -1, { actorRef: "a-adjust" });
    expect(calls.map((c) => [c.ref, c.args["actorRef"]])).toEqual([
      ["record", "a-record"],
      ["recordWithLimit", "a-limit"],
      ["adjust", "a-adjust"],
    ]);
  });

  test("an unset or undefined actorRef is omitted, not sent as undefined", async () => {
    const { ctx, calls } = fakeCtx();
    const metering = new Metering(component);
    await metering.record(ctx, "api", "o", 1);
    await metering.recordWithLimit(ctx, "api", "o", 1, 10, { actorRef: undefined });
    await metering.adjust(ctx, "api", "o", -1, { actorRef: undefined });
    expect(calls.map((c) => "actorRef" in c.args)).toEqual([false, false, false]);
  });
});
