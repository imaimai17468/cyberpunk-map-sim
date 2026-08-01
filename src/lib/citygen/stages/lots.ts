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

/**
 * Recursive OBB bisection, terminating either when the polygon's area has
 * reached `target` or when the OBB-derived cut line fails to cross the
 * polygon's interior at all (a sliver whose OBB degenerates so far that no
 * bisection is possible — kept whole rather than looping forever). Depth is
 * bounded by `log2(startArea / target)`, per design doc §12.
 */
export const subdivideBlock = (
  ring: readonly Vec2[],
  target: number,
  isSlum: boolean,
  blockId: number,
  depth: number,
  path: string,
  stream: RngStream
): readonly (readonly Vec2[])[] => {
  if (polygonArea(ring) <= target) return [ring];
  const cutStream = stream.fork("lots", blockId, depth, path);
  const line = cutLineFor(ring, isSlum, cutStream);
  const split = splitPolygon(ring, line);
  if (split === null) return [ring];
  const positives = subdivideBlock(
    split.positive,
    target,
    isSlum,
    blockId,
    depth + 1,
    `${path}0`,
    stream
  );
  const negatives = subdivideBlock(
    split.negative,
    target,
    isSlum,
    blockId,
    depth + 1,
    `${path}1`,
    stream
  );
  return positives.concat(negatives);
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
 * The direction of the longest street the lot fronts, or null when it fronts
 * none.
 *
 * This is what the building on the lot is squared up to. Before it existed the
 * footprint took the lot's minimum-area box, whose angle comes from the
 * subdivision and the orientation field rather than from the street outside —
 * measured on akiba-01, facades sat a median of 24 degrees off the road they
 * faced, and a tenth of them were past 43 of a possible 45.
 */
const frontageDirectionOf = (
  streetEdges: readonly (readonly [Vec2, Vec2])[],
  lotEdges: readonly (readonly [Vec2, Vec2])[]
): Vec2 | null =>
  streetEdges.reduce<{ dir: Vec2 | null; best: number }>(
    (acc, [sa, sb]) =>
      lotEdges.reduce((inner, [a, b]) => {
        const overlap = collinearOverlapLength(sa, sb, a, b);
        // `>=`, matching `classifyFrontages`. With `>` a lot whose best
        // overlap landed exactly on the minimum was called "street" by one and
        // handed a null direction by the other — the same record disagreeing
        // with itself about whether it fronts a road.
        return overlap >= inner.best
          ? { dir: normalize(sub(sb, sa)), best: overlap }
          : inner;
      }, acc),
    { dir: null, best: LOTS.minFrontageM }
  ).dir;

/**
 * Frontage per leaf lot of one block (design doc §3 stage 9): a lot with an
 * edge overlapping >= `minFrontageM` of a street/arterial-provenance block
 * boundary segment is `"street"`. A landlocked lot in a slum block is kept
 * as `"landlocked"` (the slum exception — no merge). Elsewhere, a landlocked
 * lot that touches at least one `"street"` sibling in the same block becomes
 * `"landlocked-merged"`; with no such sibling it falls back to
 * `"landlocked"`.
 *
 * The design's fuller slum graft ("shared edges emit alley edges") is a
 * road-graph change, and `LotLayer` carries no road output — only the
 * frontage-classification half is representable here; see the
 * implementation report.
 */
export const classifyFrontages = (
  blockRing: readonly Vec2[],
  boundary: readonly BoundaryRef[],
  leaves: readonly (readonly Vec2[])[],
  isSlum: boolean
): readonly Frontage[] => {
  const blockEdges = ringEdges(blockRing);
  const streetEdges = blockEdges.filter((_edge, i) =>
    STREET_CAPABLE_PROVENANCES.has(boundary[i].kind)
  );
  const leafEdgeLists = leaves.map((ring) => ringEdges(ring));
  const hasStreetFrontage = (
    edges: readonly (readonly [Vec2, Vec2])[]
  ): boolean =>
    streetEdges.some(([sa, sb]) =>
      edges.some(
        ([a, b]) => collinearOverlapLength(sa, sb, a, b) >= LOTS.minFrontageM
      )
    );
  const direct = leafEdgeLists.map(hasStreetFrontage);
  const touches = (i: number, j: number): boolean =>
    leafEdgeLists[i].some(([a, b]) =>
      leafEdgeLists[j].some(([c, d]) => collinearOverlapLength(a, b, c, d) > 0)
    );
  return leaves.map((_ring, i) => {
    if (direct[i]) return "street";
    if (isSlum) return "landlocked";
    const hasMergeTarget = direct.some(
      (isStreet, j) => isStreet && touches(i, j)
    );
    return hasMergeTarget ? "landlocked-merged" : "landlocked";
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
    const leaves =
      block.district === "megablock"
        ? [ring]
        : subdivideBlock(
            ring,
            scaledTargetOf(block.district),
            isSlum,
            block.id,
            0,
            "",
            stream
          );
    const frontages = classifyFrontages(ring, block.boundary, leaves, isSlum);
    // Inset preserves the vertex count, so `boundary[i]` still names the road
    // bounding edge `i` of the ring the lots were actually cut from.
    const streetEdges = ringEdges(ring).filter((_edge, i) =>
      STREET_CAPABLE_PROVENANCES.has(block.boundary[i].kind)
    );
    return [
      {
        blockId: block.id,
        leaves,
        frontages,
        directions: leaves.map((leaf) =>
          frontageDirectionOf(streetEdges, ringEdges(leaf))
        ),
      },
    ];
  });

  const flatRecords = perBlock.flatMap((entry) =>
    entry.leaves.map((ring, i) => ({
      blockId: entry.blockId,
      ring,
      frontage: entry.frontages[i],
      frontageDir: entry.directions[i],
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
  };
};
