/** Public TypeScript surface for the metering client. */

/** How a meter rolls successive quantities into a single period value. */
export type Aggregation = "sum" | "max" | "last";

/** Construction options for the {@link Metering} client. */
export interface MeteringOptions {
  /** Namespace applied when a call omits `scope`. Default `"global"`. */
  defaultScope?: string;
  /** Period bucket applied when a call omits `period`. Default `"all"`. */
  defaultPeriod?: string;
}

/** Per-call options for {@link Metering.defineMeter}. */
export interface DefineMeterOptions {
  /** Aggregation rule for this meter. Default `"sum"`. */
  aggregation?: Aggregation;
  /** Display unit label (e.g. `"requests"`, `"GB"`). Default `""`. */
  unit?: string;
  /** Namespace for this meter. Defaults to the client `defaultScope`. */
  scope?: string;
}

/** Per-call options for {@link Metering.record} / {@link Metering.recordWithLimit}. */
export interface RecordOptions {
  /** Period bucket (opaque host string). Defaults to the client `defaultPeriod`. */
  period?: string;
  /** Idempotency key — a repeat with the same key is a no-op (sum meters only). */
  idempotencyKey?: string;
  /** Opaque actor ref stored on the record for the billing audit trail. */
  actorRef?: string;
  /** Namespace. Defaults to the client `defaultScope`. */
  scope?: string;
}

/** A meter definition, as returned by {@link Metering.getMeter} / {@link Metering.listMeters}. */
export interface MeterDefinition {
  key: string;
  scope: string;
  aggregation: Aggregation;
  unit: string;
  /** Absolute ms timestamp the meter was first defined. */
  createdAt: number;
}

/**
 * Outcome of {@link Metering.record} / {@link Metering.adjust}. `recorded: true`
 * carries the new period rollup; `recorded: false` with `reason: "duplicate"` means
 * the `idempotencyKey` was already seen and nothing changed.
 */
export type RecordOutcome =
  | { recorded: true; value: number; count: number }
  | { recorded: false; reason: "duplicate" };

/**
 * Outcome of {@link Metering.recordWithLimit} — `RecordOutcome` plus a
 * `limit_exceeded` arm carrying the unchanged `value` and the `limit`.
 */
export type LimitOutcome =
  | { recorded: true; value: number; count: number }
  | { recorded: false; reason: "duplicate" }
  | { recorded: false; reason: "limit_exceeded"; value: number; limit: number };

/** A subject's rolled-up usage for one period, as returned by {@link Metering.usage}. */
export interface Usage {
  /** The aggregated value for the period (sum, max, or last, per the meter). */
  value: number;
  /** The number of usage events recorded in the period. */
  count: number;
  /** True once the period has been closed (frozen) for billing. */
  closed: boolean;
}

/** A subject's usage for one period, as returned in the {@link Metering.listUsage} array. */
export interface UsageEntry {
  period: string;
  value: number;
  count: number;
  closed: boolean;
}

/** A subject's usage on one meter+period, as returned in {@link Metering.listSubjectUsage}. */
export interface SubjectUsageEntry {
  meter: string;
  period: string;
  value: number;
  count: number;
  closed: boolean;
}

/** Reconciliation result, as returned by {@link Metering.verify}. */
export interface VerifyResult {
  rollupValue: number;
  rollupCount: number;
  recomputedValue: number;
  /** Records still present (recomputation is only authoritative when > 0). */
  recordsRemaining: number;
  /** `rollupValue === recomputedValue`. */
  consistent: boolean;
}
