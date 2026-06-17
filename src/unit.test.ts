import { describe, expect, test } from "vitest";
import { applyAggregation } from "./shared";

describe("applyAggregation", () => {
  test("sum accumulates the running value", () => {
    expect(applyAggregation("sum", 10, 5)).toBe(15);
    expect(applyAggregation("sum", 0, 0)).toBe(0);
  });

  test("max keeps the peak", () => {
    expect(applyAggregation("max", 10, 5)).toBe(10);
    expect(applyAggregation("max", 3, 9)).toBe(9);
  });

  test("last overwrites with the latest value", () => {
    expect(applyAggregation("last", 10, 5)).toBe(5);
    expect(applyAggregation("last", 99, 0)).toBe(0);
  });
});
