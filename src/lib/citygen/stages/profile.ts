/**
 * Holding a road's longitudinal profile to a gradient, by cutting.
 *
 * Roads here are drawn straight onto the natural ground, so their gradient is
 * whatever the terrain happens to do between two stations. Measured on the three
 * golden seeds at 2048 m and 512 cells, the median street run climbs 13.5% to
 * 15.7% and a third of all runs pass 20%; the worst reach past 100%, which is a
 * cliff rather than a road. Japan's 道路構造令 puts the maximum longitudinal
 * gradient of an urban road at 5% to 9% by design speed, 11% to 12% where the
 * terrain leaves no choice — so the median street is already beyond the absolute
 * legal limit, and this is the function that fixes it.
 *
 * Cut only, never fill. The result is at or below natural ground everywhere,
 * because filling would need a retaining structure the model has no way to draw,
 * and because a road that may only be cut can never end up hanging in the air.
 * The visible consequence is that a V-shaped valley keeps its floor and loses its
 * shoulders, which is what a cutting through a ridge actually looks like.
 *
 * The two passes are not an approximation. Taking `u[i] = min(z[i], u[i-1] + g·d)`
 * forward and then the same backward yields the greatest `g`-Lipschitz sequence
 * that is nowhere above `z`: each pass enforces the constraint in one direction
 * and neither can violate the other, since lowering a station only ever loosens
 * what its neighbours must satisfy. That is also why it is idempotent, and why it
 * cannot oscillate the way alternating cut-and-fill passes would.
 */

/**
 * `z` cut down until no run exceeds `maxGrade` (a rise over run ratio, so 0.06 is
 * 6%). `spacing[i]` is the horizontal distance from station `i` to `i + 1`.
 *
 * A zero-length run constrains nothing: two stations at the same place can be at
 * any two heights without any gradient between them, and dividing by that distance
 * is what would otherwise put an infinity into the field.
 *
 * `floor` bounds how deep each station may be cut, and it is applied **inside** both
 * passes rather than to the result. That placement is the whole point. Clamping
 * afterwards lifts an over-cut station back toward the ground without telling its
 * neighbours, so a station still cut to the floor beside it is left facing a step
 * that the cap had already removed — measured on the golden seeds, the post-hoc
 * version reintroduced violations on 1,436 of `akiba-01`'s segment pairs across
 * 1,060 of its 2,332 road edges. Folded in, each pass sees the floor its neighbour
 * actually landed on and propagates from there.
 *
 * It stays cut-only, terminating and idempotent: `Math.max` with the floor can only
 * raise a station toward `z`, never above it, since the caller's floor is itself
 * below `z`; and neither pass can then lower a station past a floor it has already
 * respected.
 */
export const cutToGrade = (
  z: readonly number[],
  spacing: readonly number[],
  maxGrade: number,
  floor?: readonly number[]
): readonly number[] => {
  if (z.length < 2) return z;
  const atLeast = (value: number, i: number): number =>
    floor === undefined ? value : Math.max(value, floor[i]);
  const forward = z.reduce<number[]>((acc, value, i) => {
    acc.push(
      atLeast(
        i === 0
          ? value
          : Math.min(value, acc[i - 1] + maxGrade * spacing[i - 1]),
        i
      )
    );
    return acc;
  }, []);
  return forward.reduceRight<number[]>((acc, value, i) => {
    const next = acc[0];
    acc.unshift(
      atLeast(
        next === undefined
          ? value
          : Math.min(value, next + maxGrade * spacing[i]),
        i
      )
    );
    return acc;
  }, []);
};
