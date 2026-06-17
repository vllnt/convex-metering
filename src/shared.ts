/** Shared constants + the pure aggregation rule used by both `client/` and `component/`. */

export const COMPONENT_NAME = "metering";

/** Default namespace when the host does not scope a meter. */
export const DEFAULT_SCOPE = "global";

/**
 * Default period bucket when the host does not supply one. A `period` is an opaque
 * host-owned string (e.g. `"2026-06"`, `"2026-W24"`); the component never parses
 * dates, so the calendar/timezone choice stays entirely with the host.
 */
export const DEFAULT_PERIOD = "all";

/** Default page size for a `pruneRecords` pass before the sweep self-reschedules. */
export const DEFAULT_PRUNE_BATCH = 200;

/** How a meter rolls successive usage quantities into a single period value. */
export type Aggregation = "sum" | "max" | "last";

/**
 * Fold `quantity` into the running rollup `current` per the meter's aggregation:
 * `sum` accumulates, `max` keeps the peak, `last` overwrites with the latest.
 * Pure and total over the `Aggregation` union.
 */
export function applyAggregation(
  aggregation: Aggregation,
  current: number,
  quantity: number,
): number {
  if (aggregation === "sum") {
    return current + quantity;
  }
  if (aggregation === "max") {
    return Math.max(current, quantity);
  }
  return quantity; // "last"
}
