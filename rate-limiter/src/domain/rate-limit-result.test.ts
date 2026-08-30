import { RateLimitResult } from './rate-limit-result';

function result(allowed: boolean, limit: number, remaining: number): RateLimitResult {
  return new RateLimitResult(allowed, limit, remaining, 0);
}

describe('Given the ruling comparison of two rate limit results', () => {
  it('a denial beats an allowed verdict', () => {
    expect(result(false, 2, 0).isMoreRestrictiveThan(result(true, 1, 3))).toBe(true);
  });

  it('an allowed verdict never beats a denial', () => {
    expect(result(true, 1, 3).isMoreRestrictiveThan(result(false, 2, 0))).toBe(false);
  });

  it('among allowed verdicts, the lower remaining count wins', () => {
    expect(result(true, 3, 1).isMoreRestrictiveThan(result(true, 3, 2))).toBe(true);
    expect(result(true, 3, 2).isMoreRestrictiveThan(result(true, 3, 1))).toBe(false);
  });

  it('among denials, the smaller limit wins (remaining is always 0)', () => {
    expect(result(false, 2, 0).isMoreRestrictiveThan(result(false, 5, 0))).toBe(true);
    expect(result(false, 5, 0).isMoreRestrictiveThan(result(false, 2, 0))).toBe(false);
  });

  it('an identical verdict never wins, so the first rule keeps it', () => {
    expect(result(true, 3, 1).isMoreRestrictiveThan(result(true, 3, 1))).toBe(false);
    expect(result(false, 2, 0).isMoreRestrictiveThan(result(false, 2, 0))).toBe(false);
  });
});