import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import type {
  Aggregation,
  DefineMeterOptions,
  LimitOutcome,
  MeterDefinition,
  MeteringOptions,
  RecordOptions,
  RecordOutcome,
  SubjectUsageEntry,
  Usage,
  UsageEntry,
  VerifyResult,
} from "./types.js";
import { DEFAULT_PERIOD, DEFAULT_PRUNE_BATCH, DEFAULT_SCOPE } from "../shared.js";

type RecordArgs = {
  scope: string;
  meter: string;
  subjectRef: string;
  quantity: number;
  period: string;
  idempotencyKey?: string;
  actorRef?: string;
};

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
    record: FunctionReference<"mutation", "internal", RecordArgs, RecordOutcome>;
    recordWithLimit: FunctionReference<
      "mutation",
      "internal",
      RecordArgs & { limit: number },
      LimitOutcome
    >;
    adjust: FunctionReference<
      "mutation",
      "internal",
      {
        scope: string;
        meter: string;
        subjectRef: string;
        delta: number;
        period: string;
        idempotencyKey?: string;
        actorRef?: string;
      },
      RecordOutcome
    >;
    closePeriod: FunctionReference<
      "mutation",
      "internal",
      { scope: string; meter: string; subjectRef: string; period: string },
      boolean
    >;
    reset: FunctionReference<
      "mutation",
      "internal",
      { scope: string; meter: string; subjectRef: string; period: string; batch: number },
      number
    >;
    eraseSubject: FunctionReference<
      "mutation",
      "internal",
      { scope: string; subjectRef: string; batch: number },
      number
    >;
    pruneRecords: FunctionReference<
      "mutation",
      "internal",
      { before: number; batch: number },
      number
    >;
    pruneSeen: FunctionReference<
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
    listMeters: FunctionReference<
      "query",
      "internal",
      { scope: string },
      MeterDefinition[]
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
    listSubjectUsage: FunctionReference<
      "query",
      "internal",
      { scope: string; subjectRef: string },
      SubjectUsageEntry[]
    >;
    verify: FunctionReference<
      "query",
      "internal",
      { scope: string; meter: string; subjectRef: string; period: string },
      VerifyResult
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
 * this is accurate, idempotent usage accounting with period boundaries, corrections
 * (`adjust`), period freeze (`closePeriod`), and reconciliation (`verify`).
 *
 * @example
 * ```ts
 * const metering = new Metering(components.metering);
 * await metering.defineMeter(ctx, "api_calls", { aggregation: "sum", unit: "requests" });
 * const r = await metering.recordWithLimit(ctx, "api_calls", orgId, 1, planLimit, {
 *   period: "2026-06",
 *   idempotencyKey: requestId, // a retry won't double-count
 * });
 * if (!r.recorded && r.reason === "limit_exceeded") throw new Error("over plan limit");
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
   * `unit` may change freely; `aggregation` is locked once usage exists (throws
   * `AGGREGATION_LOCKED`). Returns `{ created }`.
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
   * Record `quantity` of usage. Pass an `idempotencyKey` (sum meters only) to make
   * a retry a no-op — the dedup survives `pruneRecords`. Returns the new rollup or
   * `{ recorded: false, reason: "duplicate" }`.
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
      actorRef: opts.actorRef,
    });
  }

  /**
   * Record only if it would not push the period over `limit` — an atomic
   * check-and-record (no read-then-write race). Returns the rollup, `duplicate`, or
   * `{ recorded: false, reason: "limit_exceeded", value, limit }`.
   */
  recordWithLimit(
    ctx: RunMutationCtx,
    meter: string,
    subjectRef: string,
    quantity: number,
    limit: number,
    opts: RecordOptions = {},
  ): Promise<LimitOutcome> {
    return ctx.runMutation(this.component.mutations.recordWithLimit, {
      scope: this.scopeOf(opts.scope),
      meter,
      subjectRef,
      quantity,
      limit,
      period: this.periodOf(opts.period),
      idempotencyKey: opts.idempotencyKey,
      actorRef: opts.actorRef,
    });
  }

  /**
   * Post a signed correction to a **sum** meter (`delta` may be negative — a
   * refund/credit/void). The rollup stays equal to the sum of records and never
   * goes negative (`ADJUST_BELOW_ZERO` otherwise). Idempotent via `idempotencyKey`.
   */
  adjust(
    ctx: RunMutationCtx,
    meter: string,
    subjectRef: string,
    delta: number,
    opts: { period?: string; idempotencyKey?: string; actorRef?: string; scope?: string } = {},
  ): Promise<RecordOutcome> {
    return ctx.runMutation(this.component.mutations.adjust, {
      scope: this.scopeOf(opts.scope),
      meter,
      subjectRef,
      delta,
      period: this.periodOf(opts.period),
      idempotencyKey: opts.idempotencyKey,
      actorRef: opts.actorRef,
    });
  }

  /**
   * Freeze a `(meter, subject, period)` so its billed value is immutable
   * (`record`/`adjust` into it throw `PERIOD_CLOSED`). Returns `false` if no usage
   * exists for it.
   */
  closePeriod(
    ctx: RunMutationCtx,
    meter: string,
    subjectRef: string,
    opts: { period?: string; scope?: string } = {},
  ): Promise<boolean> {
    return ctx.runMutation(this.component.mutations.closePeriod, {
      scope: this.scopeOf(opts.scope),
      meter,
      subjectRef,
      period: this.periodOf(opts.period),
    });
  }

  /**
   * Clear a subject's usage for one `(meter, period)` — rollup + raw records, in
   * bounded self-rescheduling batches. Idempotency keys are kept, so a late replay
   * stays deduped. Returns the records removed this pass (0 once drained).
   */
  reset(
    ctx: RunMutationCtx,
    meter: string,
    subjectRef: string,
    opts: { period?: string; scope?: string; batch?: number } = {},
  ): Promise<number> {
    return ctx.runMutation(this.component.mutations.reset, {
      scope: this.scopeOf(opts.scope),
      meter,
      subjectRef,
      period: this.periodOf(opts.period),
      batch: opts.batch ?? DEFAULT_PRUNE_BATCH,
    });
  }

  /**
   * Erase a subject across every meter + period (records + rollups), bounded +
   * self-rescheduling. The GDPR right-to-erasure primitive. Returns the rows
   * removed this pass.
   */
  eraseSubject(
    ctx: RunMutationCtx,
    subjectRef: string,
    opts: { scope?: string; batch?: number } = {},
  ): Promise<number> {
    return ctx.runMutation(this.component.mutations.eraseSubject, {
      scope: this.scopeOf(opts.scope),
      subjectRef,
      batch: opts.batch ?? DEFAULT_PRUNE_BATCH,
    });
  }

  /**
   * Delete raw records older than `before` (absolute ms), bounded. Rollups and
   * idempotency keys are never touched. `before` is required. Returns the count
   * removed in the first pass.
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

  /**
   * Delete idempotency keys older than `before` (set it older than your longest
   * retry/redelivery window — pruning a key re-opens its replay). Bounded.
   */
  pruneSeen(
    ctx: RunMutationCtx,
    before: number,
    batch?: number,
  ): Promise<number> {
    return ctx.runMutation(this.component.mutations.pruneSeen, {
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

  /** Every meter defined in the scope — the discovery surface. */
  listMeters(ctx: RunQueryCtx, scope?: string): Promise<MeterDefinition[]> {
    return ctx.runQuery(this.component.queries.listMeters, {
      scope: this.scopeOf(scope),
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

  /** Every meter+period rollup for a subject across the scope (invoice line items). */
  listSubjectUsage(
    ctx: RunQueryCtx,
    subjectRef: string,
    scope?: string,
  ): Promise<SubjectUsageEntry[]> {
    return ctx.runQuery(this.component.queries.listSubjectUsage, {
      scope: this.scopeOf(scope),
      subjectRef,
    });
  }

  /**
   * Reconcile a `(meter, subject, period)` rollup against its surviving records.
   * `consistent` is trustworthy only when `recordsRemaining > 0`.
   */
  verify(
    ctx: RunQueryCtx,
    meter: string,
    subjectRef: string,
    opts: { period?: string; scope?: string } = {},
  ): Promise<VerifyResult> {
    return ctx.runQuery(this.component.queries.verify, {
      scope: this.scopeOf(opts.scope),
      meter,
      subjectRef,
      period: this.periodOf(opts.period),
    });
  }
}

export type {
  Aggregation,
  DefineMeterOptions,
  LimitOutcome,
  MeterDefinition,
  MeteringOptions,
  RecordOptions,
  RecordOutcome,
  SubjectUsageEntry,
  Usage,
  UsageEntry,
  VerifyResult,
};
