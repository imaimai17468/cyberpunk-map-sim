import type { RoadClass, Vec2 } from "@/entities/city";
import { ROAD_WIDTH_M } from "@/lib/citygen/constants";
import { scale } from "@/lib/citygen/geometry/vec";

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
 * three for each triangle of the fans that close a turn or an end.
 */
type Face = readonly Vec2[];

/**
 * How long a chord the rounded parts may be drawn with, in metres.
 *
 * Applies to the joint fans and the end caps, which are the only curved things
 * here. The sagitta of a chord `c` on radius `r` is about `c²/8r`, so this limit
 * leaves 0.09 m of flat on a street and 0.03 m on a highway.
 *
 * Below `r` = √2 it stops binding at all, because a quarter sweep's own chord is
 * already under 2 m: a 2 m alley's cap is two flat quarter turns, and their rims
 * sit `r(1 - cos 45°)` = 0.29 m inside the circle. That is the largest such gap
 * of the four classes, and still under a sixth of the road's own width.
 *
 * It costs almost nothing because it only ever applies to a rim. A cap is two
 * quarter sweeps, each a chord of `√2·r`, so it is `2·max(1, ⌈√2·r / 2⌉)`
 * triangles an end: 22 on a highway, 16 on an avenue, 8 on a street, 2 on an
 * alley. As a formula rather than four numbers, because four numbers rot one
 * road width at a time — the highway figure here read 24 until a reviewer
 * counted the triangles, and the alley figure read 4 until the class stopped
 * being 4 m wide.
 */
const RIM_CHORD_M = 2;

/** Unit vector `t` of the way from unit `a` to unit `b`, along the rim. */
const unitLerp = (a: Vec2, b: Vec2, t: number): Vec2 => {
  const x = a.x + (b.x - a.x) * t;
  const y = a.y + (b.y - a.y) * t;
  const length = Math.sqrt(x * x + y * y);
  return { x: x / length, y: y / length };
};

/**
 * Triangles sweeping the rim from unit direction `from` to unit direction `to`.
 *
 * Normalising a lerp rather than stepping an angle: the result is exactly on the
 * circle either way, and this needs no trigonometry and no angle to have been
 * taken.
 *
 * The caller must keep the sweep under half a turn. At exactly half, `from` and
 * `to` are antiparallel, the lerp passes through the zero vector, and dividing by
 * its length yields NaN corners — geometry that draws as nothing and reports no
 * error. This is stated rather than checked: both callers are provably inside the
 * bound (`capFaces` sweeps two fixed quarters; `jointFace`'s sweep is a road's own
 * turn, and it returns early on the reversal that would be 180 degrees), and a
 * guard for a case neither can reach would be a branch no test could honestly
 * cover. A third caller is what would change that — `roads that curve` is named
 * below as the next thing to build here, and it must either respect this or bring
 * the guard and its test with it.
 *
 * Wound `[centre, next, current]`, which is clockwise in the generator's axes and
 * therefore upward once `y` becomes three's `z`. Callers that need the other
 * handedness swap `from` and `to` rather than reversing the corners here.
 */
const rimFan = (centre: Vec2, from: Vec2, to: Vec2, radius: number): Face[] => {
  const chord =
    Math.sqrt(
      (to.x - from.x) * (to.x - from.x) + (to.y - from.y) * (to.y - from.y)
    ) * radius;
  const steps = Math.max(1, Math.ceil(chord / RIM_CHORD_M));
  return Array.from({ length: steps }, (_value, i) => [
    centre,
    offset(centre, unitLerp(from, to, (i + 1) / steps), radius),
    offset(centre, unitLerp(from, to, i / steps), radius),
  ]);
};

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
 * An arc rather than a mitre: a mitre spikes without bound as the turn approaches
 * a hairpin and then needs a limit and a fallback anyway. It is drawn as the fan
 * `rimFan` returns, which is SVG's `stroke-linejoin: round` and, at one triangle,
 * is exactly the flat bevel this used to draw — a turn whose rim chord is under
 * `RIM_CHORD_M` still gets that single triangle, and nothing about it changed.
 *
 * Most turns are now that case. Since the generator started rounding arterial
 * centrelines the median interior turn is 4.5 degrees, which on a highway sweeps
 * 1.2 m of rim, so the fan is one triangle and the bevel is what draws. What the
 * arc is for is the sharp remainder: the corners at junctions, which the generator
 * leaves unrounded because an edge ends there. The sharpest measured on the three
 * golden seeds at 2048 m and 512 cells is 42.7 degrees, on `akiba-01`.
 *
 * Streets and alleys never reach here — the generator gives them no interior
 * vertices — so this only ever runs on the two wide classes. Their corners are
 * between separate edges meeting at a block ring vertex, which is what `capFaces`
 * covers instead.
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
  const outward = cross > 0 ? -1 : 1;
  const from: Vec2 = scale(leftOf(d1), outward);
  const to: Vec2 = scale(leftOf(d2), outward);
  // Swept in the direction that comes out clockwise in the generator's axes, which
  // is what faces up once `y` becomes three's `z`. See `rimFan` and `emit`.
  return cross > 0
    ? rimFan(vertex, from, to, half)
    : rimFan(vertex, to, from, half);
};

/**
 * The half-disc that closes each end of a polyline: SVG's `stroke-linecap: round`.
 *
 * This is the one part of the ribbon that streets need. A street is always a
 * two-vertex straight — measured on the three golden seeds at 2048 m and 512 cells,
 * every one of the 2,587, 2,680 and 2,450 street edges has exactly two points — so
 * no joint fan can ever fire on one, while the cuts that produce them meet at block
 * ring corners in their thousands. Two butt ends at a shared corner leave the same
 * notch a bend leaves, and only a cap fills it. Alleys would be in the same position
 * and are not counted here: `ROAD_CLASSES` carries the class but no stage assigns
 * it, so there is nothing yet to have measured.
 *
 * It paves ground that was already reserved, wherever the corner is between two
 * roads. A lot is inset from its block boundary by half the carriageway bounding it,
 * and every point within `half` of the corner is within `half` of both edges meeting
 * there — the perpendicular distance to a line through a point cannot exceed the
 * distance to the point — so the quarter-disc lands in the strip no lot can occupy.
 * The exception is a corner where the other edge is `border` or `water`, which
 * `lots.ts` insets by nothing at all, there being no far side to reserve; a cap
 * there can reach ground a lot may hold. Not measured, and left alone: at the map
 * edge and the shoreline it is a rounded corner over ground nothing else is drawing.
 *
 * Where a street ends on an arterial, the cap reaches half a street past the
 * arterial's centreline and disappears under a carriageway wider than that in every
 * pairing the generator makes.
 *
 * Two quarters rather than one half, because `rimFan` normalises a lerp and a
 * half-turn passes through the zero vector. The outward direction is the seam.
 *
 * A polyline whose first or last segment has no direction gets no cap at that end.
 * The generator drops consecutive duplicates, so this is the fully degenerate run
 * — the one `ribbonOf` already draws nothing for.
 *
 * Fewer than two points gets nothing at all, and that guard is this function's own
 * rather than the caller's. `runFaces` and `jointFace` are reached through
 * `slice(...).flatMap(...)`, which quietly yields nothing on a short array; this one
 * indexes, so without the guard `polyline[1]` is `undefined` and `directionOf`
 * throws — taking the whole class's mesh with it, not just the one bad line.
 * Nothing produces such a polyline today: `polylinePoints` returns `[]` below two
 * points, and both sources of road edges are structurally at least two —
 * `splitIntoEdgeVertexLists` keeps only pieces with two distinct ends, and
 * `streetEdgesOf` writes exactly two points per cut. It is guarded because the
 * signature promises nothing of the sort, and because every other helper here
 * already treats degenerate input as an empty case instead of a crash.
 */
const capFaces = (polyline: readonly Vec2[], half: number): Face[] => {
  if (polyline.length < 2) return [];
  const head = directionOf(polyline[0], polyline[1]);
  const tail = directionOf(
    polyline[polyline.length - 2],
    polyline[polyline.length - 1]
  );
  const start =
    head === null
      ? []
      : [
          ...rimFan(polyline[0], leftOf(head), scale(head, -1), half),
          ...rimFan(
            polyline[0],
            scale(head, -1),
            scale(leftOf(head), -1),
            half
          ),
        ];
  const end =
    tail === null
      ? []
      : [
          ...rimFan(
            polyline[polyline.length - 1],
            scale(leftOf(tail), -1),
            tail,
            half
          ),
          ...rimFan(polyline[polyline.length - 1], tail, leftOf(tail), half),
        ];
  return [...start, ...end];
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
  // Caps last, so the index of every quad and every joint triangle is what it was
  // before caps existed. `roadRibbons.test.ts` reads specific triangles by index.
  return [...runs, ...joints, ...capFaces(polyline, half)];
};

interface TaggedFace {
  readonly face: Face;
  readonly line: number;
}

const emit = (
  tagged: readonly TaggedFace[],
  height: (p: Vec2, polylineIndex: number) => number
): RibbonMesh => {
  const faces = tagged.map((t) => t.face);
  const vertexCount = faces.reduce((n, f) => n + f.length, 0);
  if (vertexCount === 0) return EMPTY;
  const indexCount = faces.reduce((n, f) => n + (f.length === 4 ? 6 : 3), 0);
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);

  tagged.reduce(
    ({ v, i }, { face, line }) => {
      face.forEach((corner, c) => {
        const o = (v + c) * 3;
        positions[o] = corner.x;
        positions[o + 1] = height(corner, line);
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
  elevationAt: (p: Vec2, polylineIndex: number) => number,
  maxSpanM: number
): RibbonMesh => {
  const half = ROAD_WIDTH_M[cls] / 2;
  const span = maxSpanM > 0 ? maxSpanM : Number.POSITIVE_INFINITY;
  // Faces are tagged with the polyline they came from so `emit` can ask the right
  // road how high it is. A road carries its own graded profile (ADR-0028) rather
  // than reading the ground under each corner, which is what stops it riding the
  // bumps it was cut through — and it makes the surface level across its width,
  // since every corner of a face asks the same centreline.
  const tagged = polylines.flatMap((line, i) =>
    facesOf(line, half, span).map((face) => ({ face, line: i }))
  );
  return emit(tagged, elevationAt);
};
