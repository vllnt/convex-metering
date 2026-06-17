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
      pruneRecords: FunctionReference<
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
          idempotencyKey?: string;
          meter: string;
          period: string;
          quantity: number;
          scope: string;
          subjectRef: string;
        },
        | { count: number; recorded: true; value: number }
        | {
            count: number;
            reason: "duplicate";
            recorded: false;
            value: number;
          },
        Name
      >;
      reset: FunctionReference<
        "mutation",
        "internal",
        { meter: string; period: string; scope: string; subjectRef: string },
        boolean,
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
      listUsage: FunctionReference<
        "query",
        "internal",
        { meter: string; scope: string; subjectRef: string },
        Array<{ count: number; period: string; value: number }>,
        Name
      >;
      usage: FunctionReference<
        "query",
        "internal",
        { meter: string; period: string; scope: string; subjectRef: string },
        null | { count: number; value: number },
        Name
      >;
    };
  };
