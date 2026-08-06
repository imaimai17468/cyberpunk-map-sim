import type { Building, InstanceBuffer, Vec2 } from "@/entities/city";
import { blockRangesOf } from "@/lib/citygen/stages/assemble";
import type { KitPart } from "./manifest";

/**
 * One building into the instances of its kit parts (ADR-0029).
 *
 * Pure, and deliberately so: it takes the part sizes as a parameter rather than
 * reading them from an asset, so the whole of it is testable against numbers a
 * test can write down, and the asset stays the single source of those numbers at
 * run time. `kitMeshes.ts` is the half that touches THREE and the network.
 */

/** What the loaded kit measures, in metres, as authored. */
export interface KitMetrics {
  readonly partHeights: Readonly<Record<KitPart, number>>;
  /**
   * The kit's overall footprint — the widest part on each axis, not the shaft's.
   *
   * One factor for every part is what keeps the parts' authored proportions to
   * each other: a plinth authored 5% proud of the shaft stays 5% proud at every
   * tower width. Taking the widest is what keeps the assembly inside the OBB,
   * which `buildings.ts` already shrank to fit the lot and clear the roads — the
   * shaft then sits a little inside its plot, and nothing oversails it.
   */
  readonly footprint: { readonly x: number; readonly z: number };
}

/**
 * How many floors, and what each part's height is multiplied by.
 *
 * Three scales rather than one because the correction belongs to the shaft: the
 * base and the crown are authored at the height they should be and keep it,
 * while the floor stack absorbs whatever rounding to a whole number of storeys
 * left over. The exception is the degenerate case below, where all three move
 * together.
 */
export interface KitAssembly {
  readonly floors: number;
  readonly baseScale: number;
  readonly floorScale: number;
  readonly crownScale: number;
}

/**
 * The assembly that reaches exactly `heightM`.
 *
 * `heightM` keeps one authority (ADR-0029). Rounding the shaft to whole storeys
 * would otherwise leave the drawn tower a fraction of a floor away from the
 * model's own height, and a building drawn at a height nothing decided is the
 * float ADR-0028 exists to remove — so the floor stack is scaled to close the
 * gap rather than the gap being tolerated.
 *
 * Below one storey of kit the parts cannot each keep their authored height at
 * all: subtracting a base and a crown from the height leaves nothing, or less
 * than nothing, for the shaft. Scaling all three together is the graceful
 * answer — a squat tower — rather than a crown driven down through its own base,
 * which is what correcting only the shaft would produce. corpoTower never
 * reaches here on the fixture seeds — 2 of its 398 towers on akiba-01 and none
 * on the other two — but the next archetype to take a kit would live here.
 *
 * `heightM` must be greater than zero, which is the caller's to guarantee and
 * not checked: `corpoMassing` clamps to `BUILDINGS.corpo.minM`, so nothing
 * reaches here with a height that would turn the scale negative and mirror every
 * part. A future archetype pointed at this function owes the same guarantee.
 */
export const assemblyFor = (
  heightM: number,
  partHeights: KitMetrics["partHeights"]
): KitAssembly => {
  const natural = partHeights.base + partHeights.floor + partHeights.crown;
  if (heightM <= natural) {
    const scale = heightM / natural;
    return {
      floors: 1,
      baseScale: scale,
      floorScale: scale,
      crownScale: scale,
    };
  }
  const shaft = heightM - partHeights.base - partHeights.crown;
  // No clamp to one floor, because reaching here already guarantees it: the
  // branch above took every `heightM` up to `natural`, so `shaft` exceeds one
  // floor's height and the rounding cannot land on zero. A `Math.max(1, ...)`
  // here read as defensive and was unreachable — a guard no test can honestly
  // cover.
  const floors = Math.round(shaft / partHeights.floor);
  return {
    floors,
    baseScale: 1,
    floorScale: shaft / (floors * partHeights.floor),
    crownScale: 1,
  };
};

/**
 * Column-major 4x4 for a part standing on `baseY`, turned to `facing`.
 *
 * The same construction `assemble.ts` uses for the box — local +X onto `facing`,
 * local +Z onto its perpendicular, no trigonometry — but the scales here are
 * ratios against the authored mesh rather than absolute metres, because the
 * geometry already has a size.
 */
// similarity-ignore: shares the trig-free rotation-from-facing shape with assemble.ts's instanceMatrix and must, since both feed the same instance buffers; the two differ in what the scales mean and merging them would make one caller's units the other's business
const instanceMatrix = (
  centre: Vec2,
  baseY: number,
  facing: Vec2,
  scaleX: number,
  scaleY: number,
  scaleZ: number
): readonly number[] => [
  facing.x * scaleX,
  0,
  facing.y * scaleX,
  0,
  0,
  scaleY,
  0,
  0,
  -facing.y * scaleZ,
  0,
  facing.x * scaleZ,
  0,
  centre.x,
  baseY,
  centre.y,
  1,
];

interface PartInstance {
  readonly part: KitPart;
  readonly blockId: number;
  readonly matrix: readonly number[];
}

const instancesOf = (
  building: Building,
  metrics: KitMetrics
): readonly PartInstance[] => {
  const { obb, heightM, baseZM, blockId } = building;
  const assembly = assemblyFor(heightM, metrics.partHeights);
  const scaleX = obb.w / metrics.footprint.x;
  const scaleZ = obb.d / metrics.footprint.z;
  const centre: Vec2 = { x: obb.cx, y: obb.cy };
  const at = (baseY: number, scaleY: number): readonly number[] =>
    instanceMatrix(centre, baseY, obb.facing, scaleX, scaleY, scaleZ);

  const shaftBase = baseZM + metrics.partHeights.base * assembly.baseScale;
  const rise = metrics.partHeights.floor * assembly.floorScale;
  return [
    { part: "base", blockId, matrix: at(baseZM, assembly.baseScale) },
    ...Array.from({ length: assembly.floors }, (_value, i) => ({
      part: "floor" as const,
      blockId,
      matrix: at(shaftBase + rise * i, assembly.floorScale),
    })),
    {
      part: "crown",
      blockId,
      matrix: at(shaftBase + rise * assembly.floors, assembly.crownScale),
    },
  ];
};

const bufferOf = (instances: readonly PartInstance[]): InstanceBuffer => ({
  count: instances.length,
  matrices: Float32Array.from(instances.flatMap((entry) => entry.matrix)),
  blockRanges: blockRangesOf(instances),
});

/**
 * Every building of one archetype, as one instance buffer per kit part.
 *
 * Sorted by blockId then id, the order `assemble.ts` packs its boxes in, so each
 * part's buffer is block-contiguous the same way and `blockRanges` means the same
 * thing on both sides — which is what lets a future LOD swap a block's kit
 * ranges for its box range.
 */
export const expandKit = (
  buildings: readonly Building[],
  metrics: KitMetrics
): Readonly<Record<KitPart, InstanceBuffer>> => {
  const instances = buildings
    .toSorted((a, b) => a.blockId - b.blockId || a.id - b.id)
    .flatMap((building) => instancesOf(building, metrics));
  const partBuffer = (part: KitPart): InstanceBuffer =>
    bufferOf(instances.filter((entry) => entry.part === part));
  // Written out rather than built from `KIT_PARTS`, so a new part is a compile
  // error here instead of a key that silently never appears.
  return {
    base: partBuffer("base"),
    floor: partBuffer("floor"),
    crown: partBuffer("crown"),
  };
};
