import type { Vec2 } from "@/entities/city";
import { add, length, normalize, scale, sub } from "./vec";

/**
 * Rounding the corners off a polyline, without leaving the arithmetic the engine
 * is allowed to use.
 *
 * Arterials are Dijkstra paths over an 8-connected cost grid, so before this ran
 * they were lattice staircases that Douglas-Peucker had thinned rather than
 * straightened. Measured on the three golden seeds at the app's own extent
 * (2048 m, 512 cells): highways and avenues carried a vertex every 40 m turning a
 * median 39 degrees, p90 49-56, worst 79, with 87% to 93% of turns past 20
 * degrees. Nothing downstream disagreed with that — blocks chain these very
 * vertices into their face graph, lots inset from the result, buildings sweep the
 * same polyline — so the city was consistently built around a road that bent every
 * 40 m, and the corners were visible as corners.
 *
 * A circular fillet is the obvious instrument and is not available. ADR-0027 bans
 * `Math.sin/cos/tan/atan2/pow/hypot` and friends inside the engine so that output
 * cannot drift between JS engines, and `determinism.test.ts` scans for them; every
 * way of laying points along an arc wants one of them. A quadratic Bézier wants
 * none: de Casteljau is two lerps, it is tangent-continuous with the straight legs
 * it joins, and it is what SVG's `Q` draws, which is the shape this was asked to
 * look like in the first place.
 *
 * It also puts its own error in closed form, which an arc approximation would not.
 * Write `t` for the tangent length and `k = |d2 - d1| / 2`, which is `sin(θ/2)`
 * computed from the two unit directions rather than from an angle nobody here may
 * take. The curve leaves the original line only between its tangent points, both of
 * which lie on it, and both ends sit `t` from the control point, so the
 * configuration is symmetric about the bisector and the furthest departure is at
 * `u = 0.5`. That point stands `t·k/2` from the vertex, and `t·k·√(1-k²)/2` from
 * the legs themselves. Capping `t` at `2·maxDeviationM / k` therefore holds the
 * departure under `maxDeviationM` with the vertex figure standing in for the leg
 * one: the caller states how far the road may move and gets at most that, rather
 * than stating a radius and discovering afterwards how far the road moved.
 *
 * The other cap is what keeps two *adjacent* fillets from crossing each other. A
 * fillet takes `t` off each of its two segments, so the two that share a segment
 * would overlap unless each is held to half of it; held there, they meet at its
 * midpoint at worst, which is why a long shallow bend comes out as one continuous
 * curve rather than as arcs with straights between them.
 *
 * Only adjacent ones. Nothing here bounds a fillet against a distant part of the
 * same polyline, so a line that doubles back to within `2·maxDeviationM` of itself
 * could in principle be handed a crossing it did not have — the fillet bulges toward
 * the inside of its turn, which is the side a returning line would be on. It takes a
 * near-touch to do it, and shortest paths do not near-touch: scanned across every
 * arterial edge of the three golden seeds at 2048 m and 512 cells, comparing all
 * non-adjacent segment pairs of each smoothed polyline, there are none.
 * `pipeline.test.ts` pins that at the golden parameters so a change to
 * `maxDeviationM` or to the path builder cannot introduce one quietly.
 *
 * The budget is conservative by exactly the `√(1-k²)` above. Where it binds at a
 * right angle it gives 8.84 m of real departure for 12.5 m budgeted; where the
 * segments bind instead, `smooth.test.ts`'s 100 m legs give 50 m of tangent, 17.68 m
 * from the vertex and 12.5 m from the legs. Both pairs are pinned there. A caller
 * sizing this against a hazard, water or a bridge span, is never surprised by more
 * movement than it asked for, only by less.
 */

/** How the corner budget is spent. Both caps apply; the tighter one wins. */
export interface SmoothOptions {
  /** Furthest the curve may sit from the vertex it replaces, in metres. */
  readonly maxDeviationM: number;
  /** Longest straight chord the sampled curve may be drawn with, in metres. */
  readonly maxChordM: number;
}

/**
 * Below this two points are the same point.
 *
 * Matched to the filters in `blocks.ts` and `arterials.ts` rather than to
 * `normalize`'s own epsilon, which is far smaller: a leg this function keeps is
 * therefore always long enough to normalise, so no direction here is ever the
 * fallback zero vector.
 */
const DUPLICATE_M = 1e-6;

/** Below this `k` the two directions are one direction and there is no corner. */
const STRAIGHT_EPSILON = 1e-9;

/** Above this `k` — `sin(θ/2)` — the two directions are opposite. See `filletAt`. */
const OPPOSITE_EPSILON = 1e-9;

const dropDuplicates = (points: readonly Vec2[]): readonly Vec2[] =>
  points.filter(
    (p, i) => i === 0 || length(sub(p, points[i - 1])) > DUPLICATE_M
  );

const lerp = (a: Vec2, b: Vec2, u: number): Vec2 => ({
  x: a.x + (b.x - a.x) * u,
  y: a.y + (b.y - a.y) * u,
});

/** Quadratic Bézier at `u`, by de Casteljau: two lerps, no `**`, no trig. */
const quadraticAt = (p0: Vec2, control: Vec2, p2: Vec2, u: number): Vec2 =>
  lerp(lerp(p0, control, u), lerp(control, p2, u), u);

/**
 * One corner's replacement: the samples of its fillet, or the vertex itself.
 *
 * Two corners get no fillet. A straight run has none to cut. An exact reversal
 * has nowhere to put one: opposite directions place both tangent points on the
 * same ray, so the curve would run out from the vertex and fold back along
 * itself, which is a self-intersecting road where there was a hairpin. Neither is
 * live geometry — these polylines are shortest paths, and the sharpest interior
 * turn measured anywhere across the golden seeds was 79 degrees — so the second
 * branch pins a decision rather than handling a case, the same decision
 * `roadRibbons.ts` records for the wedge it declines to draw.
 *
 * The sample count comes from the control polygon, whose length is exactly `2t`.
 * A quadratic's speed is `2t·|(1-u)·d1 + u·d2|`, a convex combination of two unit
 * vectors scaled by `2t`, so it never exceeds `2t` — which makes `2t/steps` a true
 * bound on each chord and not an estimate.
 */
const filletAt = (
  prev: Vec2,
  vertex: Vec2,
  next: Vec2,
  options: SmoothOptions
): readonly Vec2[] => {
  const into = sub(vertex, prev);
  const outOf = sub(next, vertex);
  const d1 = normalize(into);
  const d2 = normalize(outOf);
  const k = length(sub(d2, d1)) / 2;
  if (k < STRAIGHT_EPSILON || k > 1 - OPPOSITE_EPSILON) return [vertex];

  const t = Math.min(
    length(into) / 2,
    length(outOf) / 2,
    (2 * options.maxDeviationM) / k
  );
  const p0 = sub(vertex, scale(d1, t));
  const p2 = add(vertex, scale(d2, t));
  const steps = Math.max(1, Math.ceil((2 * t) / options.maxChordM));
  return Array.from({ length: steps + 1 }, (_value, i) =>
    quadraticAt(p0, vertex, p2, i / steps)
  );
};

/**
 * `points` with every interior corner replaced by a tangent-continuous curve,
 * both endpoints exactly where they were.
 *
 * Endpoints are pinned because callers join these polylines to each other: an end
 * that moved would tear the network apart at its nodes, and in this generator it
 * would also move a bridge's land-to-water transition, which is the one vertex on
 * an arterial that means something physical.
 *
 * Duplicates are dropped on the way in and on the way out. On the way in because
 * a repeated vertex is a zero-length leg with no direction to turn through — the
 * generator produces a handful, which `blocks.ts` filters for the same reason. On
 * the way out because two fillets that each took half of the segment between them
 * meet exactly at its midpoint, and a zero-length link is what leaves
 * `comparePseudoAngle` with no angle to sort a node's half-edges by.
 */
export const smoothPolyline = (
  points: readonly Vec2[],
  options: SmoothOptions
): readonly Vec2[] => {
  if (points.length < 3) return points;
  const distinct = dropDuplicates(points);
  if (distinct.length < 3) return distinct;
  return dropDuplicates([
    distinct[0],
    ...distinct
      .slice(1, -1)
      .flatMap((vertex, i) =>
        filletAt(distinct[i], vertex, distinct[i + 2], options)
      ),
    distinct[distinct.length - 1],
  ]);
};
