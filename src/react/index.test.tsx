// @vitest-environment jsdom

/**
 * Tests for the optional `./react` front-tooling layer. Runs under jsdom (per-file
 * pragma; the global vitest env is edge-runtime). `convex/react` is mocked so the
 * hooks are exercised as thin pass-throughs to `useQuery` with client-side derivation.
 */

import { renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { FunctionReference } from "convex/server";
import { useQuery } from "convex/react";
import { useUsage, useUsageList } from "./index.js";
import type { Usage, UsageEntry } from "../client/types.js";

vi.mock("convex/react", () => ({ useQuery: vi.fn() }));
const useQueryMock = vi.mocked(useQuery);

const usageRef = "metering.usage" as unknown as FunctionReference<
  "query",
  "public",
  { scope?: string; meter: string; subjectRef: string; period: string },
  Usage | null
>;
const listRef = "metering.listUsage" as unknown as FunctionReference<
  "query",
  "public",
  { scope?: string; meter: string; subjectRef: string },
  UsageEntry[]
>;

const args = { meter: "api", subjectRef: "o", period: "p" };

describe("useUsage", () => {
  test("loading → isLoading true, zeros", () => {
    useQueryMock.mockReturnValue(undefined);
    const { result } = renderHook(() => useUsage(usageRef, args));
    expect(useQueryMock).toHaveBeenCalledWith(usageRef, args);
    expect(result.current).toEqual({ isLoading: true, value: 0, count: 0, closed: false });
  });

  test("null usage → not loading, zeros", () => {
    useQueryMock.mockReturnValue(null);
    const { result } = renderHook(() => useUsage(usageRef, args));
    expect(result.current).toEqual({ isLoading: false, value: 0, count: 0, closed: false });
  });

  test("present, no limit → raw value/count/closed", () => {
    useQueryMock.mockReturnValue({ value: 8200, count: 5, closed: true });
    const { result } = renderHook(() => useUsage(usageRef, args));
    expect(result.current).toEqual({ isLoading: false, value: 8200, count: 5, closed: true });
  });

  test("with a limit → derives remaining / fraction / exceeded (under)", () => {
    useQueryMock.mockReturnValue({ value: 8200, count: 5, closed: false });
    const { result } = renderHook(() => useUsage(usageRef, args, { limit: 10000 }));
    expect(result.current).toMatchObject({
      value: 8200,
      limit: 10000,
      remaining: 1800,
      fraction: 0.82,
      exceeded: false,
    });
  });

  test("with a limit → exceeded when over", () => {
    useQueryMock.mockReturnValue({ value: 12000, count: 9, closed: false });
    const { result } = renderHook(() => useUsage(usageRef, args, { limit: 10000 }));
    expect(result.current).toMatchObject({ remaining: 0, exceeded: true });
  });

  test("limit of 0 → fraction 0", () => {
    useQueryMock.mockReturnValue({ value: 5, count: 1, closed: false });
    const { result } = renderHook(() => useUsage(usageRef, args, { limit: 0 }));
    expect(result.current).toMatchObject({ fraction: 0, exceeded: true });
  });
});

describe("useUsageList", () => {
  test("forwards to useQuery and returns its data", () => {
    const data: UsageEntry[] = [{ period: "2026-06", value: 3, count: 2, closed: false }];
    useQueryMock.mockReturnValue(data);
    const { result } = renderHook(() => useUsageList(listRef, { meter: "api", subjectRef: "o" }));
    expect(result.current).toBe(data);
  });
});
