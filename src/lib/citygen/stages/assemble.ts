import {
  BUILDING_ARCHETYPES,
  type Building,
  type BuildingArchetype,
  type InstanceBuffer,
} from "@/entities/city";

/**
 * Stage 11: pack buildings into per-archetype instance buffers.
 *
 * Matrices are composed here, in the worker, rather than in the renderer — the
 * renderer is a dumb consumer that uploads a buffer. Composition is trig-free:
 * a building's orientation is a `facing` unit vector, so the rotation about Y
 * is just that vector and its perpendicular dropped into the matrix columns.
 *
 * A megabuilding's tiers become additional instances in the same buffer, which
 * is why the instance count is not the building count.
 */

const FLOATS_PER_INSTANCE = 16;

interface PackedInstance {
  readonly blockId: number;
  readonly matrix: readonly number[];
}

/**
 * Column-major 4x4 for a unit box whose local origin sits at the centre of its
 * base. Local +X maps to `facing`, local +Z to its perpendicular, so no
 * trigonometry is involved.
 */
const instanceMatrix = (
  cx: number,
  cy: number,
  baseY: number,
  facingX: number,
  facingY: number,
  width: number,
  height: number,
  depth: number
): readonly number[] => [
  facingX * width,
  0,
  facingY * width,
  0,
  0,
  height,
  0,
  0,
  -facingY * depth,
  0,
  facingX * depth,
  0,
  cx,
  baseY,
  cy,
  1,
];

/** One instance per tier, stacked from the building's base upward. */
const instancesOf = (building: Building): readonly PackedInstance[] => {
  const { obb, heightM, baseZM, tiers } = building;
  return tiers.reduce<{ readonly out: PackedInstance[]; readonly y: number }>(
    (acc, tier) => {
      const tierHeight = heightM * tier.heightFrac;
      const scale = 1 - tier.insetFrac;
      acc.out.push({
        blockId: building.blockId,
        matrix: instanceMatrix(
          obb.cx,
          obb.cy,
          acc.y,
          obb.facing.x,
          obb.facing.y,
          obb.w * scale,
          tierHeight,
          obb.d * scale
        ),
      });
      return { out: acc.out, y: acc.y + tierHeight };
    },
    { out: [], y: baseZM }
  ).out;
};

const emptyBuffer = (): InstanceBuffer => ({
  count: 0,
  matrices: new Float32Array(0),
  blockRanges: new Map(),
});

/**
 * Contiguous instance ranges per block, recorded while packing. Unused by the
 * first slice; it is the hook LOD and streaming will need, and computing it
 * here is free because the instances are already block-sorted.
 */
const blockRangesOf = (
  instances: readonly PackedInstance[]
): ReadonlyMap<number, readonly [number, number]> => {
  const ranges = new Map<number, [number, number]>();
  instances.forEach((instance, index) => {
    const existing = ranges.get(instance.blockId);
    if (existing === undefined) {
      ranges.set(instance.blockId, [index, index + 1]);
      return;
    }
    existing[1] = index + 1;
  });
  return ranges;
};

const bufferFor = (
  buildings: readonly Building[],
  archetype: BuildingArchetype
): InstanceBuffer => {
  // Sorting by blockId (then by building id, for a total order) is what makes
  // the per-block ranges contiguous and the output order seed-stable.
  const packed = buildings
    .filter((building) => building.archetype === archetype)
    .toSorted((a, b) => a.blockId - b.blockId || a.id - b.id)
    .flatMap(instancesOf);

  if (packed.length === 0) return emptyBuffer();

  const matrices = new Float32Array(packed.length * FLOATS_PER_INSTANCE);
  packed.forEach((instance, index) => {
    matrices.set(instance.matrix, index * FLOATS_PER_INSTANCE);
  });

  return {
    count: packed.length,
    matrices,
    blockRanges: blockRangesOf(packed),
  };
};

export const packInstances = (
  buildings: readonly Building[]
): Readonly<Record<BuildingArchetype, InstanceBuffer>> => ({
  megabuilding: bufferFor(buildings, "megabuilding"),
  corpoTower: bufferFor(buildings, "corpoTower"),
  casino: bufferFor(buildings, "casino"),
  luxuryResidence: bufferFor(buildings, "luxuryResidence"),
  detachedHouse: bufferFor(buildings, "detachedHouse"),
  slumShack: bufferFor(buildings, "slumShack"),
});

/** Total instances across every archetype, for the invariant tests. */
export const totalInstanceCount = (
  instances: Readonly<Record<BuildingArchetype, InstanceBuffer>>
): number =>
  BUILDING_ARCHETYPES.reduce(
    (sum, archetype) => sum + instances[archetype].count,
    0
  );
