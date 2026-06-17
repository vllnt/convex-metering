import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import type {
  Aggregation,
  DefineMeterOptions,
  MeterDefinition,
  MeteringOptions,
  RecordOptions,
  RecordOutcome,
  Usage,
  UsageEntry,
} from "./types.js";
import { DEFAULT_PERIOD, DEFAULT_PRUNE_BATCH, DEFAULT_SCOPE } from "../shared.js";

/**
 * The metering component's function references, as exposed on the host via
 * `components.metering`. All values are concrete (no opaque host data), so the
 * client is fully typed end to end.
 */
export interface MeteringComponent {
  mutations: {
    defineMeter: FunctionReference<
      "mutation",
      "internal",
      { scope: string; key: string; aggregation: Aggregation; unit: string },
      { created: boolean }
    >;
    record: FunctionReference<
      "mutation",
      "internal",
      {
        scope: string;
        meter: string;
        subjectRef: string;
        quantity: number;
        period: string;
        idempotencyKey?: string;
      },
      RecordOutcome
    >;
    reset: FunctionReference<
      "mutation",
      "internal",
      { scope: string; meter: string; subjectRef: string; period: string },
      boolean
    >;
    pruneRecords: FunctionReference<
      "mutation",
      "internal",
      { before: number; batch: number },
      number
    >;
  };
  queries: {
    getMeter: FunctionReference<
      "query",
      "internal",
      { scope: string; key: string },
      MeterDefinition | null
    >;
    usage: FunctionReference<
      "query",
      "internal",
      { scope: string; meter: string; subjectRef: string; period: string },
      Usage | null
    >;
    listUsage: FunctionReference<
      "query",
      "internal",
      { scope: string; meter: string; subjectRef: string },
      UsageEntry[]
    >;
  };
}

interface RunQueryCtx {
  runQuery<Q extends FunctionReference<"query", "internal">>(
    reference: Q,
    args: FunctionArgs<Q>,
  ): Promise<FunctionReturnType<Q>>;
}

interface RunMutationCtx {
  runMutation<M extends FunctionReference<"mutation", "internal">>(
    reference: M,
    args: FunctionArgs<M>,
  ): Promise<FunctionReturnType<M>>;
}

/**
 * Consumer-facing client for metered usage. The host owns meaning and auth; it
 * defines meters, records opaque `subjectRef` usage into host-supplied `period`
 * buckets, and reads per-period rollups for billing or limit checks. Distinct from
 * a rate-limiter (a gate), a wallet (a spendable balance), or a raw aggregate —
 * this is accurate, idempotent usage accounting with period boundaries.
 *
 * @example
 * ```ts
 * const metering = new Metering(components.metering);
 * await metering.defineMeter(ctx, "api_calls", { aggregation: "sum", unit: "requests" });
 * await metering.record(ctx, "api_calls", orgId, 1, {
 *   period: "2026-06",
 *   idempotencyKey: requestId, // a retry won't double-count
 * });
 * const used = await metering.usage(ctx, "api_calls", orgId, { period: "2026-06" });
 * if (used && used.value > planLimit) throw new Error("over plan limit");
 * ```
 */
export class Metering {
  private readonly defaultScope: string;
  private readonly defaultPeriod: string;

  constructor(
    private readonly component: MeteringComponent,
    options: MeteringOptions = {},
  ) {
    this.defaultScope = options.defaultScope ?? DEFAULT_SCOPE;
    this.defaultPeriod = options.defaultPeriod ?? DEFAULT_PERIOD;
  }

  private scopeOf(scope: string | undefined): string {
    return scope ?? this.defaultScope;
  }

  private periodOf(period: string | undefined): string {
    return period ?? this.defaultPeriod;
  }

  /**
   * Create or update a meter. `aggregation` defaults to `"sum"`, `unit` to `""`.
   * Returns `{ created }` — `false` when an existing meter was updated.
   */
  defineMeter(
    ctx: RunMutationCtx,
    key: string,
    opts: DefineMeterOptions = {},
  ): Promise<{ created: boolean }> {
    return ctx.runMutation(this.component.mutations.defineMeter, {
      scope: this.scopeOf(opts.scope),
      key,
      aggregation: opts.aggregation ?? "sum",
      unit: opts.unit ?? "",
    });
  }

  /**
   * Record `quantity` of usage for `subjectRef` against `meter`. Pass an
   * `idempotencyKey` to make a retried call a no-op. Returns the new period rollup
   * (`recorded: true`) or `{ recorded: false, reason: "duplicate" }`.
   */
  record(
    ctx: RunMutationCtx,
    meter: string,
    subjectRef: string,
    quantity: number,
    opts: RecordOptions = {},
  ): Promise<RecordOutcome> {
    return ctx.runMutation(this.component.mutations.record, {
      scope: this.scopeOf(opts.scope),
      meter,
      subjectRef,
      quantity,
      period: this.periodOf(opts.period),
      idempotencyKey: opts.idempotencyKey,
    });
  }

  /**
   * Clear a subject's usage for one `(meter, period)` — rollup and raw records.
   * Returns `true` when a rollup existed.
   */
  reset(
    ctx: RunMutationCtx,
    meter: string,
    subjectRef: string,
    opts: { period?: string; scope?: string } = {},
  ): Promise<boolean> {
    return ctx.runMutation(this.component.mutations.reset, {
      scope: this.scopeOf(opts.scope),
      meter,
      subjectRef,
      period: this.periodOf(opts.period),
    });
  }

  /**
   * Delete raw records older than `before` (absolute ms) in bounded batches,
   * oldest first; rollups are never touched. `before` is required — the host owns
   * its retention window. Returns the count removed in the first pass.
   */
  pruneRecords(
    ctx: RunMutationCtx,
    before: number,
    batch?: number,
  ): Promise<number> {
    return ctx.runMutation(this.component.mutations.pruneRecords, {
      before,
      batch: batch ?? DEFAULT_PRUNE_BATCH,
    });
  }

  /** The meter definition, or `null` if none exists. */
  getMeter(
    ctx: RunQueryCtx,
    key: string,
    scope?: string,
  ): Promise<MeterDefinition | null> {
    return ctx.runQuery(this.component.queries.getMeter, {
      scope: this.scopeOf(scope),
      key,
    });
  }

  /** A subject's rolled-up usage for one period, or `null` if none recorded. */
  usage(
    ctx: RunQueryCtx,
    meter: string,
    subjectRef: string,
    opts: { period?: string; scope?: string } = {},
  ): Promise<Usage | null> {
    return ctx.runQuery(this.component.queries.usage, {
      scope: this.scopeOf(opts.scope),
      meter,
      subjectRef,
      period: this.periodOf(opts.period),
    });
  }

  /** Every period's rolled-up usage for a subject on a meter. */
  listUsage(
    ctx: RunQueryCtx,
    meter: string,
    subjectRef: string,
    scope?: string,
  ): Promise<UsageEntry[]> {
    return ctx.runQuery(this.component.queries.listUsage, {
      scope: this.scopeOf(scope),
      meter,
      subjectRef,
    });
  }
}

export type {
  Aggregation,
  DefineMeterOptions,
  MeterDefinition,
  MeteringOptions,
  RecordOptions,
  RecordOutcome,
  Usage,
  UsageEntry,
};
