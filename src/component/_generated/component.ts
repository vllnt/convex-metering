/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    mutations: {
      adjust: FunctionReference<
        "mutation",
        "internal",
        {
          actorRef?: string;
          delta: number;
          idempotencyKey?: string;
          meter: string;
          period: string;
          scope: string;
          subjectRef: string;
        },
        | { count: number; recorded: true; value: number }
        | { reason: "duplicate"; recorded: false },
        Name
      >;
      closePeriod: FunctionReference<
        "mutation",
        "internal",
        { meter: string; period: string; scope: string; subjectRef: string },
        boolean,
        Name
      >;
      defineMeter: FunctionReference<
        "mutation",
        "internal",
        {
          aggregation: "sum" | "max" | "last";
          key: string;
          scope: string;
          unit: string;
        },
        { created: boolean },
        Name
      >;
      eraseSubject: FunctionReference<
        "mutation",
        "internal",
        { batch: number; scope: string; subjectRef: string },
        number,
        Name
      >;
      pruneRecords: FunctionReference<
        "mutation",
        "internal",
        { batch: number; before: number },
        number,
        Name
      >;
      pruneSeen: FunctionReference<
        "mutation",
        "internal",
        { batch: number; before: number },
        number,
        Name
      >;
      record: FunctionReference<
        "mutation",
        "internal",
        {
          actorRef?: string;
          idempotencyKey?: string;
          meter: string;
          period: string;
          quantity: number;
          scope: string;
          subjectRef: string;
        },
        | { count: number; recorded: true; value: number }
        | { reason: "duplicate"; recorded: false },
        Name
      >;
      recordWithLimit: FunctionReference<
        "mutation",
        "internal",
        {
          actorRef?: string;
          idempotencyKey?: string;
          limit: number;
          meter: string;
          period: string;
          quantity: number;
          scope: string;
          subjectRef: string;
        },
        | { count: number; recorded: true; value: number }
        | { reason: "duplicate"; recorded: false }
        | {
            limit: number;
            reason: "limit_exceeded";
            recorded: false;
            value: number;
          },
        Name
      >;
      reset: FunctionReference<
        "mutation",
        "internal",
        {
          batch: number;
          meter: string;
          period: string;
          scope: string;
          subjectRef: string;
        },
        number,
        Name
      >;
    };
    queries: {
      getMeter: FunctionReference<
        "query",
        "internal",
        { key: string; scope: string },
        null | {
          aggregation: "sum" | "max" | "last";
          createdAt: number;
          key: string;
          scope: string;
          unit: string;
        },
        Name
      >;
      listMeters: FunctionReference<
        "query",
        "internal",
        { scope: string },
        Array<{
          aggregation: "sum" | "max" | "last";
          createdAt: number;
          key: string;
          scope: string;
          unit: string;
        }>,
        Name
      >;
      listSubjectUsage: FunctionReference<
        "query",
        "internal",
        { scope: string; subjectRef: string },
        Array<{
          closed: boolean;
          count: number;
          meter: string;
          period: string;
          value: number;
        }>,
        Name
      >;
      listUsage: FunctionReference<
        "query",
        "internal",
        { meter: string; scope: string; subjectRef: string },
        Array<{
          closed: boolean;
          count: number;
          period: string;
          value: number;
        }>,
        Name
      >;
      usage: FunctionReference<
        "query",
        "internal",
        { meter: string; period: string; scope: string; subjectRef: string },
        null | { closed: boolean; count: number; value: number },
        Name
      >;
      verify: FunctionReference<
        "query",
        "internal",
        { meter: string; period: string; scope: string; subjectRef: string },
        {
          consistent: boolean;
          recomputedValue: number;
          recordsRemaining: number;
          rollupCount: number;
          rollupValue: number;
        },
        Name
      >;
    };
  };
