import type {
  Block,
  BoundaryRef,
  DistrictKind,
  Frontage,
  PolygonPool,
  Vec2,
} from "@/entities/city";
import { LOTS, LOT_TARGET_AREA_M2 } from "../constants";
import { segmentIntersection } from "../geometry/intersect";
import { minimumAreaObb } from "../geometry/hull";
import {
  area as polygonArea,
  type SplitLine,
  splitPolygon,
} from "../geometry/polygon";
import {
  add,
  blendLineTensors,
  directionFromLineTensor,
  length,
  perp,
  randomUnitVector,
  scale,
  sub,
  toLineTensor,
} from "../geometry/vec";
import type { RngStream } from "../rng/types";
import type { LotLayer } from "./types";

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
export const computeAreaScale = (expected: number): number =>
  Math.min(
    LOTS.areaScaleMax,
    Math.max(LOTS.areaScaleMin, expected / LOTS.targetBuildingCount)
  );

/**
 * Stage 9: assigns every buildable (non-water) block a per-district lot
 * target area — scaled once, in closed form, toward
 * `LOTS.targetBuildingCount` — then recursively bisects each block's polygon
 * down to that target. Megablocks are always a single lot (design doc §6).
 */
export const lotsStage = (input: LotsInput, stream: RngStream): LotLayer => {
  const buildableBlocks = input.blocks.filter((block) => !block.water);
  const ringOf = (block: Block): readonly Vec2[] =>
    ringFromPool(input.blockPolygons, block.ringIndex);

  const expected = buildableBlocks.reduce(
    (sum, block) =>
      sum + polygonArea(ringOf(block)) / baseTargetOf(block.district),
    0
  );
  const areaScale = computeAreaScale(expected);
  const scaledTargetOf = (district: DistrictKind): number =>
    baseTargetOf(district) * areaScale;

  const perBlock = buildableBlocks.map((block) => {
    const ring = ringOf(block);
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
    return { blockId: block.id, leaves, frontages };
  });

  const flatRecords = perBlock.flatMap((entry) =>
    entry.leaves.map((ring, i) => ({
      blockId: entry.blockId,
      ring,
      frontage: entry.frontages[i],
    }))
  );

  return {
    lots: flatRecords.map((record, i) => ({
      id: i,
      blockId: record.blockId,
      ringIndex: i,
      frontage: record.frontage,
    })),
    polygons: buildPolygonPool(flatRecords.map((record) => record.ring)),
  };
};
