/**
 * Optional, tree-shakeable React front-tooling for `@vllnt/convex-metering`.
 *
 * Thin reactive hooks over `useQuery` from `convex/react`. Each takes the HOST's
 * re-exported query reference plus its args — the component never imports the host
 * `api`. `react` and `convex/react` are optional peer deps: a backend-only consumer
 * pulls none of this code.
 *
 * NO-LEAK CONTRACT: these hooks expose only the caller's own usage metadata
 * (value/count/closed) — non-secret, the subject's own numbers. There is no secret
 * or cross-subject payload.
 */

import type { FunctionReference } from "convex/server";
import { useQuery } from "convex/react";
import type { Usage, UsageEntry } from "../client/types.js";

/** A live usage view for a "8,200 / 10,000 this period" meter, derived against an optional `limit`. */
export interface UsageView {
  /** True until the query returns its first result. */
  isLoading: boolean;
  /** The period value; `0` while loading or when nothing is recorded. */
  value: number;
  /** The period's record count; `0` while loading or when nothing is recorded. */
  count: number;
  /** True once the period is closed; `false` while loading. */
  closed: boolean;
  /** The supplied `limit`. Present only when a `limit` was supplied. */
  limit?: number;
  /** `max(0, limit - value)`. Present only when a `limit` was supplied. */
  remaining?: number;
  /** `min(1, value / limit)`, or `0` when `limit <= 0`. Present only with a `limit`. */
  fraction?: number;
  /** `value > limit`. Present only when a `limit` was supplied. */
  exceeded?: boolean;
}

/**
 * Reactive usage for a `(meter, subject, period)` — wraps the host's re-exported
 * `usage` query. Pass `{ limit }` to derive `remaining` / `fraction` (0..1, for a
 * progress bar) / `exceeded` client-side. `value`/`count` are 0 while loading or
 * when nothing is recorded.
 */
export function useUsage(
  usageRef: FunctionReference<
    "query",
    "public",
    { scope?: string | undefined; meter: string; subjectRef: string; period: string },
    Usage | null
  >,
  args: { scope?: string | undefined; meter: string; subjectRef: string; period: string },
  opts: { limit?: number | undefined } = {},
): UsageView {
  const raw = useQuery(usageRef, args);
  const view: UsageView = {
    isLoading: raw === undefined,
    value: raw?.value ?? 0,
    count: raw?.count ?? 0,
    closed: raw?.closed ?? false,
  };
  if (opts.limit === undefined) {
    return view;
  }
  const limit = opts.limit;
  return {
    ...view,
    limit,
    remaining: Math.max(0, limit - view.value),
    fraction: limit > 0 ? Math.min(1, view.value / limit) : 0,
    exceeded: view.value > limit,
  };
}

/**
 * Reactive per-period usage history for a subject on a meter (a sparkline / table)
 * — wraps the host's re-exported `listUsage` query. `undefined` while loading.
 */
export function useUsageList(
  listUsageRef: FunctionReference<
    "query",
    "public",
    { scope?: string | undefined; meter: string; subjectRef: string },
    UsageEntry[]
  >,
  args: { scope?: string | undefined; meter: string; subjectRef: string },
): UsageEntry[] | undefined {
  return useQuery(listUsageRef, args);
}
