import type { RoadClass, Vec2 } from "@/entities/city";
import { ROAD_WIDTH_M } from "@/lib/citygen/constants";

/**
 * Turning road centrelines into a surface of their real width.
 *
 * A `LineSegments` road is one device pixel wide however far you zoom in —
 * `linewidth` has no effect under WebGPU or WebGL2 — so a 30 m highway and a
 * 4 m alley drew identically. That was tolerable while the model had no widths.
 * It stopped being tolerable once the generator started reserving the actual
 * carriageway: blocks are inset by half of `ROAD_WIDTH_M` on every edge a road
 * bounds, so the space is there in the geometry, and a hairline down the middle
 * of it reads as a suspiciously wide empty gap rather than as a street.
 *
 * The widths come from the same constant the inset uses. That is the whole
 * point — two numbers would drift, and the gap between them would show up as
 * pavement that does not reach the buildings.
 */

/** A vertex buffer plus its triangle indices, ready for a `BufferGeometry`. */
export interface RibbonMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

const EMPTY: RibbonMesh = {
  positions: new Float32Array(0),
  indices: new Uint32Array(0),
};

/** Unit vector from `a` to `b`, or null when they coincide. */
const directionOf = (a: Vec2, b: Vec2): Vec2 | null => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  return length < 1e-6 ? null : { x: dx / length, y: dy / length };
};

const lengthOf = (a: Vec2, b: Vec2): number =>
  Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));

/** Left of `d`, in the generator's own axes. */
const leftOf = (d: Vec2): Vec2 => ({ x: -d.y, y: d.x });

const offset = (p: Vec2, n: Vec2, by: number): Vec2 => ({
  x: p.x + n.x * by,
  y: p.y + n.y * by,
});

/**
 * One flat face, given as its corners in order: four for a carriageway quad,
 * three for the wedge that closes a turn.
 */
type Face = readonly Vec2[];

/**
 * The quads for one straight run, cut so none is longer than `span`.
 *
 * Cutting is not cosmetic. A quad is flat between its corners while the ground
 * under it is not, so a segment longer than a terrain cell is a plank laid over
 * the relief. The median road segment is 65 m against a 16 m render cell at the
 * largest extent, so 95% of them were planks: measured across the three golden
 * seeds, the worst mid-quad dip was 31.1 m and a third of the sampled surface
 * sat below the drawn ground. Cutting to one render cell takes the worst to
 * around 8 m, for roughly five times the quads. Cutting further keeps paying
 * but not well — halving the span halves the dip and quadruples the geometry —
 * so the rest is left to the caller's lift, which is where the distribution and
 * its sampling caveat are written down.
 */
const runFaces = (a: Vec2, b: Vec2, half: number, span: number): Face[] => {
  const d = directionOf(a, b);
  if (d === null) return [];
  const n = leftOf(d);
  const steps = Math.max(1, Math.ceil(lengthOf(a, b) / span));
  const at = (f: number): Vec2 => ({
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
  });
  return Array.from({ length: steps }, (_v, i) => {
    const p = at(i / steps);
    const q = at((i + 1) / steps);
    return [
      offset(p, n, half),
      offset(p, n, -half),
      offset(q, n, half),
      offset(q, n, -half),
    ];
  });
};

/**
 * The wedge that closes the outside of a turn, if the turn opens one.
 *
 * Segment quads are built independently, so where a polyline bends they pivot
 * apart and leave a notch on the outside of the turn — the inside is covered
 * twice, which is invisible, but the outside is simply missing pavement. It was
 * dismissed once as "a couple of metres that reads as a corner"; measured on
 * `akiba-01` at the app's default extent it is nothing of the sort. Highways
 * turn a median 39 degrees, which bites a median 10.0 m out of a 30 m
 * carriageway and 18.5 m at the sharpest; avenues lose a median 7.0 m of 22 m.
 * Every highway joint loses more than 2 m and all but a few avenue ones do, so
 * the wide roads read as torn rather than as bent.
 *
 * Those medians are about a third of the carriageway either way, and the ratio
 * is the part to trust. Over the three golden seeds at three extents it stays
 * between 29% and 38%, and 96% to 100% of joints lose more than 2 m, while the
 * joint count itself swings from 25 to 130 — so a count quoted here would say
 * more about which map was measured than about the defect.
 *
 * Count the joints the same way this function does, or the numbers come out
 * wrong in a flattering direction. A quarter of the interior vertices on those
 * polylines have a zero-length segment on one side — 25 of highway's 96 — and
 * the guard below skips them, correctly, since nothing pivots there. Counting
 * them as joints that happen to lose nothing is what once made this look like a
 * three-quarters problem instead of an every-joint one.
 *
 * A bevel rather than a mitre: a mitre spikes without bound as the turn
 * approaches a hairpin and then needs a limit and a fallback anyway, and at
 * these widths the bevel's flat corner is indistinguishable from the mitre's
 * point. Streets and alleys never reach here — the generator gives them no
 * interior vertices — so this only ever runs on the two wide classes.
 *
 * One case is left undrawn on purpose. `cross` is the sine of the turn, so it
 * vanishes both for a straight run and for an exact reversal, and the guard
 * below returns nothing for either. That is right for the straight one and
 * arbitrary for the reversal, where "the outside of the turn" names nothing —
 * but a reversal has never been observed: these polylines are shortest paths,
 * which do not double back, and across nine seeds at three extents the sharpest
 * interior turn anywhere was exactly 90 degrees, with none above it in 27 runs.
 * `roadRibbons.test.ts` pins the no-wedge behaviour so a future change to the
 * path builder cannot reach this quietly.
 *
 * The real answer to sharp joints is not a better joint. It is roads that
 * curve, which is the next thing to build here; every wedge this draws is a
 * corner a curve would not have had.
 */
const jointFace = (
  prev: Vec2,
  vertex: Vec2,
  next: Vec2,
  half: number
): Face[] => {
  const d1 = directionOf(prev, vertex);
  const d2 = directionOf(vertex, next);
  if (d1 === null || d2 === null) return [];
  // Zero sine is a straight run or a reversal; neither gets a wedge. See above.
  const cross = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(cross) < 1e-9) return [];
  // Outside of the turn is the right hand of a left turn, and vice versa.
  const side = cross > 0 ? -half : half;
  const a = offset(vertex, leftOf(d1), side);
  const b = offset(vertex, leftOf(d2), side);
  // Wound to match the quads: clockwise in the generator's axes, which is what
  // faces up once `y` becomes three's `z`. See `emit` below.
  return [cross > 0 ? [vertex, b, a] : [vertex, a, b]];
};

// similarity-ignore: three lines of flatMap paired with field/blur.ts's boxBlur1D; no-loops leaves every small function that shape
const facesOf = (
  polyline: readonly Vec2[],
  half: number,
  span: number
): Face[] => {
  const runs = polyline
    .slice(0, -1)
    .flatMap((a, i) => runFaces(a, polyline[i + 1], half, span));
  const joints = polyline
    .slice(1, -1)
    .flatMap((v, i) => jointFace(polyline[i], v, polyline[i + 2], half));
  return [...runs, ...joints];
};

const emit = (
  faces: readonly Face[],
  height: (p: Vec2) => number
): RibbonMesh => {
  const vertexCount = faces.reduce((n, f) => n + f.length, 0);
  if (vertexCount === 0) return EMPTY;
  const indexCount = faces.reduce((n, f) => n + (f.length === 4 ? 6 : 3), 0);
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);

  faces.reduce(
    ({ v, i }, face) => {
      face.forEach((corner, c) => {
        const o = (v + c) * 3;
        positions[o] = corner.x;
        positions[o + 1] = height(corner);
        positions[o + 2] = corner.y;
      });
      // The winding is not obvious and was wrong first time, so it is worth
      // stating: the generator's `(x, y)` becomes three's `(x, z)` with `y` up,
      // and that mapping flips handedness. A ring that is counter-clockwise on
      // paper is therefore clockwise seen from above, which is a back face, and
      // the whole road network drew as nothing at all.
      const order = face.length === 4 ? [0, 2, 1, 1, 2, 3] : [0, 1, 2];
      order.forEach((k, t) => {
        indices[i + t] = v + k;
      });
      return { v: v + face.length, i: i + order.length };
    },
    { v: 0, i: 0 }
  );

  return { positions, indices };
};

/**
 * The surface for every polyline of one class.
 *
 * `elevationAt` is sampled per vertex, not per face, so a ribbon crossing a
 * slope follows it instead of hovering at one end.
 */
export const ribbonOf = (
  polylines: readonly (readonly Vec2[])[],
  cls: RoadClass,
  elevationAt: (p: Vec2) => number,
  maxSpanM: number
): RibbonMesh => {
  const half = ROAD_WIDTH_M[cls] / 2;
  const span = maxSpanM > 0 ? maxSpanM : Number.POSITIVE_INFINITY;
  return emit(
    polylines.flatMap((line) => facesOf(line, half, span)),
    elevationAt
  );
};
