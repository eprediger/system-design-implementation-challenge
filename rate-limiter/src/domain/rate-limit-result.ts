/**
 * Outcome of a rate limit check, mirrored into the HTTP response.
 *
 * A value object: it carries the comparison that decides which verdict wins a
 * multi-rule ruling, so the limiter orchestrates without reaching into fields.
 */
export class RateLimitResult {
  /**
   * @param allowed Whether the hit is allowed.
   * @param limit The ruling rule's budget (`maxRequests`).
   * @param remaining Hits still available in the current window (ceiled against
   *   the sliding usage so it never overstates availability; never negative).
   * @param reset Epoch time in **seconds** at which the current window resets.
   * @param retryAfter Seconds to wait before retrying; present only when throttled.
   */
  constructor(
    readonly allowed: boolean,
    readonly limit: number,
    readonly remaining: number,
    readonly reset: number,
    readonly retryAfter?: number,
  ) {}

  /**
   * Whether `this` should beat `other` for the ruling: a denying verdict wins
   * over an allowed one; among equally-standing verdicts the one with fewer
   * hits remaining wins; and since two denials always show `remaining` 0, a
   * denial with the smaller limit wins — it is the tightest budget. Equal
   * verdicts do not win, so the first rule keeps the ruling on an exact tie.
   */
  isMoreRestrictiveThan(other: RateLimitResult): boolean {
    return (
      (!this.allowed && other.allowed) ||
      (this.allowed === other.allowed && this.remaining < other.remaining) ||
      (!this.allowed && !other.allowed && this.limit < other.limit)
    );
  }
}