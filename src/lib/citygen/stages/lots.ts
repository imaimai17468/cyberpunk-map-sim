import type {
  Block,
  BoundaryRef,
  DistrictKind,
  Frontage,
  PolygonPool,
  RoadGraph,
  Vec2,
} from "@/entities/city";
import {
  LOTS,
  LOT_TARGET_AREA_M2,
  MIN_BUILDABLE_BLOCK_M2,
  ROAD_WIDTH_M,
} from "../constants";
import { segmentIntersection } from "../geometry/intersect";
import { minimumAreaObb } from "../geometry/hull";
import {
  area as polygonArea,
  insetPolygonPerEdge,
  isSelfIntersecting,
  signedArea,
  type SplitLine,
  splitPolygon,
} from "../geometry/polygon";
import {
  add,
  blendLineTensors,
  directionFromLineTensor,
  length,
  normalize,
  perp,
  randomUnitVector,
  scale,
  sub,
  toLineTensor,
} from "../geometry/vec";
import type { RngStream } from "../rng/types";
import { appendSegmentRoads } from "./roadGeometry";
import type { Grid, LotLayer } from "./types";

/**
 * Stage 9 — closed-form building-count control followed by recursive OBB
 * bisection per block (design doc §3 stage 9, §2 flaw #8, §6). No retry
 * loop: the count-control scale is derived once, in closed form, from the
 * areas and (unscaled) target lot areas of every buildable block, then
 * applied to every district's target before any subdivision happens.
 */

/** Input the shared contracts file does not declare: this stage's own shape. */
export interface LotsInput {
  readonly blocks: readonly Block[];
  readonly blockPolygons: PolygonPool;
  /** Map extent, so the count target scales with area rather than being fixed. */
  readonly grid: Grid;
  /** Needed to read the class, and therefore the width, of each bounding road. */
  readonly roads: RoadGraph;
}

const ringFromPool = (
  pool: PolygonPool,
  ringIndex: number
): readonly Vec2[] => {
  const start = pool.starts[ringIndex];
  const end = pool.starts[ringIndex + 1];
  return Array.from({ length: end - start }, (_value, i) => ({
    x: pool.coords[(start + i) * 2],
    y: pool.coords[(start + i) * 2 + 1],
  }));
};

const ringEdges = (
  ring: readonly Vec2[]
): readonly (readonly [Vec2, Vec2])[] => {
  const n = ring.length;
  return ring.map((p, i) => [p, ring[(i + 1) % n]] as const);
};

const collinearOverlapLength = (
  a1: Vec2,
  a2: Vec2,
  b1: Vec2,
  b2: Vec2
): number => {
  const result = segmentIntersection(a1, a2, b1, b2);
  return result.kind === "collinear"
    ? length(sub(result.overlapEnd, result.overlapStart))
    : 0;
};

/**
 * A cut direction jittered toward a hashed random unit vector, blended in
 * "line tensor" space (undirected — a cut line has no meaningful sign) so
 * the blend is well-defined even when the two directions are near-antipodal.
 * Used only for slum blocks (design doc §6: "cut angles jittered - tangle").
 */
const jitterCutDirection = (
  dir: Vec2,
  jitterDraw: number,
  flipBit: boolean
): Vec2 => {
  const randomDir = randomUnitVector(jitterDraw, flipBit);
  const blended = blendLineTensors([
    { tensor: toLineTensor(dir), weight: 1 - LOTS.slumAngleJitter },
    { tensor: toLineTensor(randomDir), weight: LOTS.slumAngleJitter },
  ]);
  return directionFromLineTensor(blended);
};

/**
 * The bisecting line through the polygon's minimum-area OBB: perpendicular
 * to the box's long axis, offset from centre by `t` (a fraction of the long
 * axis, drawn from `cutStream`) within `[cutOffsetLo, cutOffsetHi]`. Slum
 * blocks additionally jitter the cut direction into a tangle.
 */
const cutLineFor = (
  ring: readonly Vec2[],
  isSlum: boolean,
  cutStream: RngStream
): SplitLine => {
  const obb = minimumAreaObb(ring);
  const longAxisIsFacing = obb.w >= obb.d;
  const axisDir = longAxisIsFacing ? obb.facing : perp(obb.facing);
  const axisExtent = longAxisIsFacing ? obb.w : obb.d;
  const t =
    LOTS.cutOffsetLo + (LOTS.cutOffsetHi - LOTS.cutOffsetLo) * cutStream.next();
  const offset = (t - 0.5) * axisExtent;
  const center: Vec2 = { x: obb.cx, y: obb.cy };
  const point = add(center, scale(axisDir, offset));
  const baseCutDir = perp(axisDir);
  const dir = isSlum
    ? jitterCutDirection(
        baseCutDir,
        cutStream.next(),
        cutStream.nextInt(2) === 1
      )
    : baseCutDir;
  return { point, dir };
};

/** A straight run of one cut, shared by the two regions either side of it. */
type Chord = readonly [Vec2, Vec2];

/**
 * The subdivision as it happened, rather than only what it left behind.
 *
 * The leaves alone are enough to cut lots from, and were all this stage kept
 * until alleys needed somewhere to come from. What the flat list loses is the
 * one property that makes an alley network possible: every cut's ends lie on
 * the ring of the region it divides, and that ring is either the block's own
 * outline or an ancestor's cut. So the cuts, taken together, are connected to
 * the block edge by construction — the same argument `blocks.ts` relies on to
 * publish its subdivision cuts as streets.
 *
 * @public the inter-function contract inside this stage; `leavesOf` and
 * `alleyChordsOf` are the two readers, and a third would be additive.
 */
export type CutTree =
  | { readonly kind: "leaf"; readonly ring: readonly Vec2[] }
  | {
      readonly kind: "split";
      readonly chords: readonly Chord[];
      readonly positive: CutTree;
      readonly negative: CutTree;
    };

/**
 * How far off the cut line a vertex may sit and still count as on it.
 *
 * A metre scale, not a floating-point one. `splitPolygon` builds its crossing
 * points by lerping along an edge, so they land on the line to within rounding,
 * while a vertex that merely passes near the line is centimetres away at the
 * closest — the gap between the two is enormous and anywhere inside it works.
 * The cut direction is a unit vector, so the side function is a signed distance
 * in metres and this reads as one.
 */
const ON_CHORD_EPSILON_M = 1e-6;

/**
 * The maximal runs of ring vertices lying on the cut line, as index lists.
 *
 * Read off the clipped child rather than recomputed from the line, so the chord
 * is by definition the geometry the two children actually share: intermediate
 * vertices of a run are collinear with its ends, which is what lets a run
 * collapse to the segment between its first and last.
 *
 * The rotation exists so the scan can treat the ring as a sequence: a run that
 * straddles index 0 would otherwise come back as two, and the alley would have
 * a gap in it exactly where the ring's numbering happens to start. Starting at a
 * vertex known to be off the line is what makes the wrap impossible; when there
 * is no such vertex the whole ring is on the cut, which is a degenerate region
 * with no interior to divide and no chord to take.
 */
const onLineRuns = (
  ring: readonly Vec2[],
  line: SplitLine
): readonly (readonly number[])[] => {
  const onLine = ring.map(
    (p) =>
      Math.abs(
        line.dir.x * (p.y - line.point.y) - line.dir.y * (p.x - line.point.x)
      ) <= ON_CHORD_EPSILON_M
  );
  const startAt = onLine.findIndex((flag) => !flag);
  if (startAt === -1) return [];
  return Array.from(
    { length: ring.length },
    (_value, k) => (startAt + k) % ring.length
  )
    .reduce<number[][]>(
      (runs, index) => {
        const open = runs[runs.length - 1];
        if (onLine[index]) {
          open.push(index);
          return runs;
        }
        return open.length === 0 ? runs : runs.concat([[]]);
      },
      [[]]
    )
    .filter((run) => run.length >= 2);
};

/**
 * The cut, as the segments the two children share.
 *
 * Usually one segment: a convex region crossed by a line gives a single chord.
 * A concave one can hand the line back more than once, and every run is a real
 * shared edge, so all of them are kept — taking only the extremes would draw an
 * alley across the notch between them, which is ground outside the region.
 *
 * Zero-length runs are dropped rather than published as roads with no
 * direction; `blocks.ts` reports that shape as a `zero-length-edge` discard, and
 * here it means two coincident vertices in a clip result rather than a cut
 * anyone chose.
 *
 * @public exported for its tests. `subdivideBlock` cannot hand this a ring lying
 * wholly on the cut line — `splitPolygon` returns null unless some vertex is
 * strictly on each side, and the strictly-positive one survives into the clip —
 * so the empty answer that input deserves is reachable only by calling directly
 */
export const chordsOf = (
  clipped: readonly Vec2[],
  line: SplitLine
): readonly Chord[] =>
  onLineRuns(clipped, line)
    .map((run): Chord => [clipped[run[0]], clipped[run[run.length - 1]]])
    .filter(([a, b]) => length(sub(b, a)) > 0);

/**
 * Recursive OBB bisection, terminating either when the polygon's area has
 * reached `target` or when the OBB-derived cut line fails to cross the
 * polygon's interior at all (a sliver whose OBB degenerates so far that no
 * bisection is possible — kept whole rather than looping forever). Depth is
 * bounded by `log2(startArea / target)`, per design doc §12.
 *
 * Returns the tree rather than the leaves; `leavesOf` recovers the flat list in
 * the order this used to return, which is the order lot ids are handed out in.
 */
export const subdivideBlock = (
  ring: readonly Vec2[],
  target: number,
  isSlum: boolean,
  blockId: number,
  depth: number,
  path: string,
  stream: RngStream
): CutTree => {
  if (polygonArea(ring) <= target) return { kind: "leaf", ring };
  const cutStream = stream.fork("lots", blockId, depth, path);
  const line = cutLineFor(ring, isSlum, cutStream);
  const split = splitPolygon(ring, line);
  if (split === null) return { kind: "leaf", ring };
  return {
    kind: "split",
    chords: chordsOf(split.positive, line),
    positive: subdivideBlock(
      split.positive,
      target,
      isSlum,
      blockId,
      depth + 1,
      `${path}0`,
      stream
    ),
    negative: subdivideBlock(
      split.negative,
      target,
      isSlum,
      blockId,
      depth + 1,
      `${path}1`,
      stream
    ),
  };
};

/** The leaf rings, positive side first — the order lot ids follow. */
export const leavesOf = (tree: CutTree): readonly (readonly Vec2[])[] =>
  tree.kind === "leaf"
    ? [tree.ring]
    : leavesOf(tree.positive).concat(leavesOf(tree.negative));

/**
 * The smallest connected set of cuts that reaches every leaf needing access.
 *
 * A subtree containing no such leaf contributes nothing; one that does
 * contributes its own cut as well as whatever its children contributed. The
 * result is the union of the root-to-leaf paths, and it is connected to the
 * block's edge because the root's cut ends on that edge and every deeper cut
 * ends on an ancestor's.
 *
 * That is also what makes the last cut above a landlocked leaf the alley it
 * fronts: the leaf is a direct child of that split, so the chord lies on the
 * leaf's own ring rather than merely near it.
 *
 * `needsAccess` is indexed in `leavesOf` order, which is why the walk threads a
 * cursor rather than taking an index: the tree is what knows how many leaves
 * each subtree owns.
 */
export const alleyChordsOf = (
  tree: CutTree,
  needsAccess: readonly boolean[],
  from = 0
): { readonly chords: readonly Chord[]; readonly next: number } => {
  if (tree.kind === "leaf") return { chords: [], next: from + 1 };
  const positive = alleyChordsOf(tree.positive, needsAccess, from);
  const negative = alleyChordsOf(tree.negative, needsAccess, positive.next);
  const owned = needsAccess.slice(from, negative.next);
  return {
    chords: owned.some((needed) => needed)
      ? [...tree.chords, ...positive.chords, ...negative.chords]
      : [],
    next: negative.next,
  };
};

const STREET_CAPABLE_PROVENANCES = new Set(["cut", "arterial"]);

/**
 * How much of the block one bounding edge gives up to its road.
 *
 * Half the carriageway, because the block boundary is the road's centreline and
 * the block on the other side gives up the other half. A subdivision cut is the
 * local street network, so it is priced as a street; the map border is not a
 * road and costs nothing.
 */
const halfWidthOf = (ref: BoundaryRef, roads: RoadGraph): number => {
  switch (ref.kind) {
    // Neither is a road: the map edge has nothing on the far side, and a
    // shoreline is where the block stops, not a carriageway to share.
    case "border":
    case "water":
      return 0;
    case "cut":
      return ROAD_WIDTH_M.street / 2;
    case "arterial": {
      const edge = roads.edges.find((e) => e.id === ref.refId);
      return ROAD_WIDTH_M[edge?.cls ?? "street"] / 2;
    }
    default: {
      // A switch rather than an if/else chain because `refId` means a
      // different thing per kind: a road-edge id for `arterial`, a cut id for
      // `cut`. An if/else that fell through to the arterial lookup would bill
      // a non-road boundary as a street, or collide with an unrelated edge
      // that happened to share the number — which is what it did for `water`
      // before this became exhaustive. `BoundaryProvenance` is documented as
      // the place new members are added, so this makes adding one a compile
      // error here rather than a silent mispricing.
      const unhandled: never = ref.kind;
      throw new Error(
        `halfWidthOf: unhandled boundary provenance ${String(unhandled)}`
      );
    }
  }
};

/**
 * The block minus the roadway around it: what is actually left to build on.
 *
 * Returns null when nothing usable survives — either the inset turned the ring
 * inside out (a block narrower than the roads bounding it) or what remains is
 * too small to be a plot. Both cases mean the space is roadway, and the honest
 * answer is no lots rather than a sliver of building laid over the tarmac.
 */
export const buildableRingOf = (
  ring: readonly Vec2[],
  boundary: readonly BoundaryRef[],
  roads: RoadGraph
): readonly Vec2[] | null => {
  const inset = insetPolygonPerEdge(
    ring,
    boundary.map((ref) => halfWidthOf(ref, roads))
  );
  // Order matters: a folded ring can still report an ordinary area, so the
  // shape has to be rejected before its area is trusted.
  if (isSelfIntersecting(inset)) return null;
  return polygonArea(inset) < MIN_BUILDABLE_BLOCK_M2 ? null : inset;
};

/**
 * The longest road the lot fronts among `roadEdges`, as its direction, or null
 * when none of them reaches `minFrontageM`.
 *
 * This is what the building on the lot is squared up to. Before it existed the
 * footprint took the lot's minimum-area box, whose angle comes from the
 * subdivision and the orientation field rather than from the street outside —
 * measured on akiba-01, facades sat a median of 24 degrees off the road they
 * faced, and a tenth of them were past 43 of a possible 45.
 *
 * Returning null is also how the caller learns there is no frontage of this
 * kind at all, which is why the classification below asks this rather than
 * testing the overlap a second time: a threshold applied in two places is a
 * threshold two callers can round differently, and this record disagreeing with
 * itself about whether a lot fronts a road is a bug this file has already had.
 */
const frontageDirectionOf = (
  roadEdges: readonly (readonly [Vec2, Vec2])[],
  lotEdges: readonly (readonly [Vec2, Vec2])[]
): Vec2 | null =>
  roadEdges.reduce<{ dir: Vec2 | null; best: number }>(
    (acc, [sa, sb]) =>
      lotEdges.reduce((inner, [a, b]) => {
        const overlap = collinearOverlapLength(sa, sb, a, b);
        return overlap >= inner.best
          ? { dir: normalize(sub(sb, sa)), best: overlap }
          : inner;
      }, acc),
    { dir: null, best: LOTS.minFrontageM }
  ).dir;

/** What a lot has to reach the network by, and the direction of that road. */
export interface LotFrontage {
  readonly frontage: Frontage;
  readonly dir: Vec2 | null;
}

/**
 * The lot minus the alley running along it.
 *
 * The same trade `buildableRingOf` makes one level up, for the same reason: a
 * block boundary is a street's centreline and the block gives up half the
 * carriageway, so an alley chord is a centreline too and the lots either side
 * give up half of that.
 *
 * Without it the parcel still reaches the middle of its own alley, and the only
 * thing keeping a shack off the tarmac is `clearOfRoads` shrinking the footprint
 * at massing time — which cannot recover a box whose *centre* landed in the
 * carriageway, because every smaller candidate shares that centre, and a slum
 * box is jittered off-centre on purpose. Measured on akiba-01 at 512 cells,
 * skipping the inset leaves 1,368 of 3,560 slum lots with no building against
 * 1,157 with it; at the golden 128 cells the map goes 1,065 buildings per km²
 * to 1,034.
 *
 * A lot too small to give up the width keeps its whole ring rather than a ruined
 * one, which leaves that massing-time clearance as its only defence — where
 * every lot was before this. It is rare: 43, 9 and 10 lots on the three fixture
 * seeds at the app's own extent still have an edge lying on an alley.
 *
 * Two ways to ruin it, and neither guard catches the other. A concave ring folds
 * once the inset exceeds what the concavity absorbs, which `isSelfIntersecting`
 * is there for. A convex one narrower than the alley does not fold at all — the
 * two sides pass through each other and the ring comes back simple, wound the
 * other way, enclosing the ground outside itself. `polygonArea` is the absolute
 * shoelace sum and reports that as ordinary area, so the winding is what has to
 * be read: rings here are counter-clockwise, and `blocks.ts` names the same shape
 * `inside-out-block` where its own subdivision produces one.
 *
 * @public exported for its tests, which is how this file already reaches
 * `expectedLotCount` and `unclampedAreaScale` — driving a specific fold through
 * a whole `lotsStage` fixture would test the fixture, not the guard
 */
export const insetForAlleys = (
  ring: readonly Vec2[],
  alleys: readonly Chord[]
): readonly Vec2[] => {
  const distances = ringEdges(ring).map(([a, b]) =>
    alleys.some(([p, q]) => collinearOverlapLength(p, q, a, b) > 0)
      ? ROAD_WIDTH_M.alley / 2
      : 0
  );
  if (distances.every((distance) => distance === 0)) return ring;
  const inset = insetPolygonPerEdge(ring, distances);
  return isSelfIntersecting(inset) || signedArea(inset) <= 0 ? ring : inset;
};

/**
 * Which of the block's bounding roads each leaf fronts, or null where none.
 *
 * Split out from the classification below because the two run either side of
 * the alleys: a cut is worth publishing as an alley exactly when some leaf has
 * no street, so this has to be known before `alleyChordsOf` is asked, and the
 * classification cannot be finished until the answer comes back.
 */
export const streetFrontageDirs = (
  blockRing: readonly Vec2[],
  boundary: readonly BoundaryRef[],
  leaves: readonly (readonly Vec2[])[]
): readonly (Vec2 | null)[] => {
  const streetEdges = ringEdges(blockRing).filter((_edge, i) =>
    STREET_CAPABLE_PROVENANCES.has(boundary[i].kind)
  );
  return leaves.map((ring) =>
    frontageDirectionOf(streetEdges, ringEdges(ring))
  );
};

/**
 * Frontage per leaf lot of one block (design doc §3 stage 9), in descending
 * order of access.
 *
 * A lot fronting a street/arterial-provenance block boundary segment — which is
 * what a non-null entry in `streetDirs` means — is `"street"`. Failing that, a
 * lot overlapping one of `alleyChords` by at least `minFrontageM` is `"alley"`;
 * this is the design's slum graft ("shared edges emit alley edges"), now
 * representable because `LotLayer` carries road output. Failing both, a lot in a
 * slum block is kept as `"landlocked"` (the slum exception — no merge);
 * elsewhere a lot that touches at least one `"street"` sibling in the same block
 * becomes `"landlocked-merged"`, and with no such sibling it falls back to
 * `"landlocked"`.
 *
 * Both remaining landlocked members stay reachable once alleys exist, because an
 * alley is not always offered and not always long enough: a block bounded by
 * nothing but water and the map border has no road for one to join, and a chord
 * can cross a sliver in under `minFrontageM`.
 */
export const classifyFrontages = (
  streetDirs: readonly (Vec2 | null)[],
  alleyChords: readonly Chord[],
  leaves: readonly (readonly Vec2[])[],
  isSlum: boolean
): readonly LotFrontage[] => {
  const leafEdgeLists = leaves.map((ring) => ringEdges(ring));
  const alleyDirs = leafEdgeLists.map((edges) =>
    frontageDirectionOf(alleyChords, edges)
  );
  const touches = (i: number, j: number): boolean =>
    leafEdgeLists[i].some(([a, b]) =>
      leafEdgeLists[j].some(([c, d]) => collinearOverlapLength(a, b, c, d) > 0)
    );
  return leaves.map((_ring, i) => {
    const street = streetDirs[i];
    if (street !== null) return { frontage: "street", dir: street } as const;
    const alley = alleyDirs[i];
    if (alley !== null) return { frontage: "alley", dir: alley } as const;
    if (isSlum) return { frontage: "landlocked", dir: null } as const;
    const hasMergeTarget = streetDirs.some(
      (dir, j) => dir !== null && touches(i, j)
    );
    return {
      frontage: hasMergeTarget ? "landlocked-merged" : "landlocked",
      dir: null,
    } as const;
  });
};

const prefixSums = (lengths: readonly number[]): number[] =>
  lengths.reduce<number[]>(
    (acc, len) => {
      acc.push(acc[acc.length - 1] + len);
      return acc;
    },
    [0]
  );

const buildPolygonPool = (
  rings: readonly (readonly Vec2[])[]
): PolygonPool => ({
  starts: Uint32Array.from(prefixSums(rings.map((ring) => ring.length))),
  coords: Float32Array.from(
    rings.flatMap((ring) => ring.flatMap((p) => [p.x, p.y]))
  ),
});

const baseTargetOf = (district: DistrictKind): number =>
  LOT_TARGET_AREA_M2[district];

/**
 * The closed-form count-control scale (design doc §2 flaw #8): a single
 * deterministic factor applied to every district's target lot area once, no
 * retry. Exported standalone so the clamp's two bounds are testable without
 * having to reverse-engineer a block-area fixture that lands exactly on
 * `expected`.
 */
/**
 * The predicted lot count: buildable block area over each district's unscaled
 * target lot area. This is the quantity the closed-form control scales.
 */
export const expectedLotCount = (
  input: LotsInput,
  /**
   * The buildable rings, when the caller has already computed them.
   *
   * `lotsStage` needs the same rings straight afterwards to cut lots from, and
   * deriving them twice means insetting and self-intersection-testing every
   * block on the map twice. Optional rather than required so the function stays
   * callable on its own, which is how the saturation test uses it.
   */
  precomputed?: ReadonlyMap<number, readonly Vec2[] | null>
): number =>
  input.blocks
    .filter((block) => !block.water)
    .reduce((sum, block) => {
      // The buildable ring, not the gross block: pricing the count control off
      // area that is now roadway would over-predict lots and drive the target
      // area down to compensate.
      const ring =
        precomputed?.get(block.id) ??
        buildableRingOf(
          ringFromPool(input.blockPolygons, block.ringIndex),
          block.boundary,
          input.roads
        );
      return ring === null
        ? sum
        : sum + polygonArea(ring) / baseTargetOf(block.district);
    }, 0);

/**
 * The count-control ratio *before* clamping.
 *
 * Exposed because the clamp still saturates for some (seed, extent, cells)
 * combinations, and when it does the closed-form control silently stops
 * governing. The density-band test cannot see that — it only sees the outcome,
 * which stays in band on the margin. This is what a test can assert against
 * directly so the saturation is caught if it ever worsens.
 */
export const unclampedAreaScale = (expected: number, areaKm2: number): number =>
  (expected * LOTS.subdivisionOvershoot) /
  (LOTS.targetBuildingDensityPerKm2 * areaKm2);

export const computeAreaScale = (expected: number, areaKm2: number): number =>
  Math.min(
    LOTS.areaScaleMax,
    Math.max(LOTS.areaScaleMin, unclampedAreaScale(expected, areaKm2))
  );

/** Map area in square kilometres, the denominator of the density target. */
const areaKm2Of = (grid: Grid): number => (grid.sizeM * grid.sizeM) / 1_000_000;

/**
 * Stage 9: assigns every buildable (non-water) block a per-district lot
 * target area — scaled once, in closed form, toward
 * `LOTS.targetBuildingDensityPerKm2` — then recursively bisects each block's polygon
 * down to that target. Megablocks are always a single lot (design doc §6).
 */
export const lotsStage = (input: LotsInput, stream: RngStream): LotLayer => {
  const buildableBlocks = input.blocks.filter((block) => !block.water);
  const ringOf = (block: Block): readonly Vec2[] =>
    ringFromPool(input.blockPolygons, block.ringIndex);

  // The roadway comes off before anything is subdivided, so every lot below is
  // carved out of what is left rather than out of the carriageway. Computed
  // once and shared with the count control, which needs the same rings.
  const buildableRings = new Map<number, readonly Vec2[] | null>(
    buildableBlocks.map((block) => [
      block.id,
      buildableRingOf(ringOf(block), block.boundary, input.roads),
    ])
  );

  const expected = expectedLotCount(input, buildableRings);
  const areaScale = computeAreaScale(expected, areaKm2Of(input.grid));
  const scaledTargetOf = (district: DistrictKind): number =>
    baseTargetOf(district) * areaScale;

  const perBlock = buildableBlocks.flatMap((block) => {
    const ring = buildableRings.get(block.id) ?? null;
    if (ring === null) return [];
    const isSlum = block.district === "slum";
    const tree: CutTree =
      block.district === "megablock"
        ? { kind: "leaf", ring }
        : subdivideBlock(
            ring,
            scaledTargetOf(block.district),
            isSlum,
            block.id,
            0,
            "",
            stream
          );
    const leaves = leavesOf(tree);
    // Inset preserves the vertex count, so `boundary[i]` still names the road
    // bounding edge `i` of the ring the lots were actually cut from.
    const streetDirs = streetFrontageDirs(ring, block.boundary, leaves);
    /**
     * An alley has to end on something. A block whose whole outline is
     * shoreline and map border has no road for one to join, so its cuts stay
     * cuts and its lots stay landlocked — which is the honest answer, and the
     * reason `landlocked` survives as a member rather than becoming dead
     * vocabulary the moment alleys exist.
     */
    const connectable = block.boundary.some((ref) =>
      STREET_CAPABLE_PROVENANCES.has(ref.kind)
    );
    const alleys = connectable
      ? alleyChordsOf(
          tree,
          streetDirs.map((dir) => dir === null)
        ).chords
      : [];
    return [
      {
        blockId: block.id,
        alleys,
        // Classified against the rings the cuts actually ran along, then handed
        // on inset: the frontage is a fact about which road the lot reaches,
        // and giving up the carriageway does not change that answer.
        frontages: classifyFrontages(streetDirs, alleys, leaves, isSlum),
        leaves: leaves.map((leaf) => insetForAlleys(leaf, alleys)),
      },
    ];
  });

  const flatRecords = perBlock.flatMap((entry) =>
    entry.leaves.map((ring, i) => ({
      blockId: entry.blockId,
      ring,
      frontage: entry.frontages[i].frontage,
      frontageDir: entry.frontages[i].dir,
    }))
  );

  return {
    lots: flatRecords.map((record, i) => ({
      id: i,
      blockId: record.blockId,
      ringIndex: i,
      frontage: record.frontage,
      frontageDir: record.frontageDir,
    })),
    polygons: buildPolygonPool(flatRecords.map((record) => record.ring)),
    // The alleys join the street network the block subdivision published, the
    // way those streets joined the arterials: this stage's road output is the
    // whole graph, so nothing downstream has to know there are two halves.
    roads: appendSegmentRoads(
      input.roads,
      perBlock.flatMap((entry) => entry.alleys),
      "alley"
    ),
  };
};
