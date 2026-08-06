import type { Building, InstanceBuffer, Vec2 } from "@/entities/city";
import { blockRangesOf } from "@/lib/citygen/stages/assemble";
import { fnv1a32, splitmix32 } from "@/lib/citygen/rng/hash";
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
   * each other: a sky lobby authored to oversail the shaft stays oversailing at
   * every tower width. Taking the widest is what keeps the assembly inside the
   * OBB, which `buildings.ts` already shrank to fit the lot and clear the roads
   * — the shaft then sits a little inside its plot, and nothing oversails it.
   */
  readonly footprint: { readonly x: number; readonly z: number };
}

/**
 * How one tower is stacked.
 *
 * Sections are the stepped masses, bottom first, each `taper` narrower than the
 * one below and separated from it by a roof terrace. Every `mechEvery`-th storey
 * across the whole tower is a plant floor instead of an office one; zero means
 * none. The two scales are the height correction, and they are separate because
 * they answer different questions: `storeyScale` closes the gap between whole
 * storeys and the model's height, while `fixedScale` only leaves 1 in the
 * degenerate case where nothing else can.
 */
export interface TowerProfile {
  readonly sections: readonly number[];
  readonly taper: number;
  readonly mechEvery: number;
  readonly belt: boolean;
  readonly mast: boolean;
  readonly storeyScale: number;
  readonly fixedScale: number;
}

/** Draw counts, so the grammar's knobs are named rather than inline literals. */
const GRAMMAR = {
  maxSections: 3,
  taperLo: 0.84,
  taperSpan: 0.1,
  /** Zero is a real choice: some towers run unbroken glass to the crown. */
  mechIntervals: [6, 8, 10, 0],
  beltChance: 0.55,
  mastChance: 0.45,
} as const;

const TWO_32 = 4294967296;

/**
 * The draws for one tower, in a fixed order.
 *
 * Seeded from the building id through the engine's own hashing rather than a
 * local one: `fnv1a32` and `splitmix32` are integer-only and reproducible across
 * engines, which is what makes a screenshot of a seed reproducible — the same
 * tower is stacked the same way on every machine and every reload. The state is
 * threaded through a local closure; nothing outside this call can observe it.
 */
const drawsFor = (buildingId: number): (() => number) => {
  const state = { value: fnv1a32(`corpoTower-kit:${buildingId}`) };
  return () => {
    const step = splitmix32(state.value);
    state.value = step.state;
    return step.value / TWO_32;
  };
};

/** The parts a profile always carries, at their authored heights. */
const fixedHeight = (
  partHeights: KitMetrics["partHeights"],
  sections: number,
  belt: boolean,
  mast: boolean
): number =>
  partHeights.podium +
  partHeights.crown +
  (belt ? partHeights.belt : 0) +
  (mast ? partHeights.mast : 0) +
  (sections - 1) * partHeights.setback;

interface Candidate {
  readonly sections: number;
  readonly belt: boolean;
  readonly mast: boolean;
}

/**
 * How one tower is stacked, and the profile that reaches exactly `heightM`.
 *
 * `heightM` keeps one authority (ADR-0029). Rounding the shaft to whole storeys
 * would otherwise leave the drawn tower a fraction of a floor away from the
 * model's own height, and a building drawn at a height nothing decided is the
 * float ADR-0028 exists to remove — so the storeys are scaled to close the gap
 * rather than the gap being tolerated.
 *
 * The drawn profile is not always affordable: a short tower cannot hold a
 * podium, a crown, a mast, a sky lobby and three stepped sections and still have
 * height left for storeys. So the draws propose and a ladder disposes — the mast
 * goes first, then the sky lobby, then the steps — and the first candidate whose
 * shaft can still give every section a storey is the one built. Under that
 * ladder the whole kit is what shrinks, and only when even a podium, one storey
 * and a crown do not fit.
 *
 * `heightM` must be greater than zero, which is the caller's to guarantee and
 * not checked: `corpoMassing` clamps to `BUILDINGS.corpo.minM`, so nothing
 * reaches here with a height that would turn the scales negative and mirror
 * every part. A future archetype pointed at this function owes the same
 * guarantee.
 */
export const profileFor = (
  buildingId: number,
  heightM: number,
  partHeights: KitMetrics["partHeights"]
): TowerProfile => {
  const draw = drawsFor(buildingId);
  const drawnSections = 1 + Math.floor(draw() * GRAMMAR.maxSections);
  const taper = GRAMMAR.taperLo + draw() * GRAMMAR.taperSpan;
  // No `?? 0`: `mechIntervals` is `as const`, so it types as a fixed-length
  // tuple and indexing it with a number already excludes `undefined`. A
  // fallback here would be a branch nothing can reach and no test could cover.
  const mechEvery =
    GRAMMAR.mechIntervals[Math.floor(draw() * GRAMMAR.mechIntervals.length)];
  const drawnBelt = draw() < GRAMMAR.beltChance;
  const drawnMast = draw() < GRAMMAR.mastChance;

  // Ordered by what a tower can most afford to lose: the mast is decoration,
  // the sky lobby is one band, and the steps are the silhouette itself.
  const candidates: readonly Candidate[] = [
    { sections: drawnSections, belt: drawnBelt, mast: drawnMast },
    { sections: drawnSections, belt: drawnBelt, mast: false },
    { sections: drawnSections, belt: false, mast: false },
    { sections: 1, belt: false, mast: false },
  ];
  const affordable = candidates.find(
    (candidate) =>
      heightM -
        fixedHeight(
          partHeights,
          candidate.sections,
          candidate.belt,
          candidate.mast
        ) >=
      candidate.sections * partHeights.floor
  );

  if (affordable === undefined) {
    // Not even a podium, one storey and a crown fit at their authored heights.
    const natural = partHeights.podium + partHeights.floor + partHeights.crown;
    return {
      sections: [1],
      taper,
      mechEvery: 0,
      belt: false,
      mast: false,
      storeyScale: 1,
      fixedScale: heightM / natural,
    };
  }

  const shaft =
    heightM -
    fixedHeight(
      partHeights,
      affordable.sections,
      affordable.belt,
      affordable.mast
    );
  // At least `sections` storeys, because that is what `affordable` tested.
  const storeys = Math.round(shaft / partHeights.floor);
  const per = Math.floor(storeys / affordable.sections);
  const extra = storeys % affordable.sections;
  return {
    // Bottom-heavy: the remainder goes to the lower sections, which is the way
    // a stepped tower is massed and the way the eye expects to read it.
    sections: Array.from(
      { length: affordable.sections },
      (_value, i) => per + (i < extra ? 1 : 0)
    ),
    taper,
    mechEvery,
    belt: affordable.belt,
    mast: affordable.mast,
    storeyScale: shaft / (storeys * partHeights.floor),
    fixedScale: 1,
  };
};

/** One part placed in the stack: which mesh, how wide, how tall. */
interface StackEntry {
  readonly part: KitPart;
  readonly width: number;
  readonly height: number;
}

/**
 * The parts of one tower, bottom to top, before they are given a position.
 *
 * Built as a list rather than emitted while walking, so the running height is a
 * single fold at the end and no part has to know what came before it.
 */
export const stackOf = (
  profile: TowerProfile,
  partHeights: KitMetrics["partHeights"]
): readonly StackEntry[] => {
  const fixedEntry = (part: KitPart, width: number): StackEntry => ({
    part,
    width,
    height: partHeights[part] * profile.fixedScale,
  });
  const storeyEntry = (part: KitPart, width: number): StackEntry => ({
    part,
    width,
    height: partHeights[part] * profile.fixedScale * profile.storeyScale,
  });
  const topWidth = profile.taper ** (profile.sections.length - 1);

  // The plant floors are counted across the whole tower rather than per
  // section, so the rhythm carries through a step instead of restarting at it.
  const storeysBelow = profile.sections.map((_count, i) =>
    profile.sections.slice(0, i).reduce((sum, count) => sum + count, 0)
  );

  return [
    fixedEntry("podium", 1),
    ...(profile.belt ? [fixedEntry("belt", 1)] : []),
    ...profile.sections.flatMap((count, i) => {
      const width = profile.taper ** i;
      const storeys = Array.from({ length: count }, (_value, k) => {
        const index = storeysBelow[i] + k + 1;
        const isMech = profile.mechEvery > 0 && index % profile.mechEvery === 0;
        return storeyEntry(isMech ? "mech" : "floor", width);
      });
      const isLast = i === profile.sections.length - 1;
      return isLast ? storeys : [...storeys, fixedEntry("setback", width)];
    }),
    fixedEntry("crown", topWidth),
    ...(profile.mast ? [fixedEntry("mast", topWidth)] : []),
  ];
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
  const { obb, heightM, baseZM, blockId, id } = building;
  const profile = profileFor(id, heightM, metrics.partHeights);
  const stack = stackOf(profile, metrics.partHeights);
  const scaleX = obb.w / metrics.footprint.x;
  const scaleZ = obb.d / metrics.footprint.z;
  const centre: Vec2 = { x: obb.cx, y: obb.cy };

  return stack.reduce<{ readonly out: PartInstance[]; readonly y: number }>(
    (acc, entry) => {
      const authored = metrics.partHeights[entry.part];
      acc.out.push({
        part: entry.part,
        blockId,
        matrix: instanceMatrix(
          centre,
          acc.y,
          obb.facing,
          scaleX * entry.width,
          // The mesh already has its authored height, so the scale is the ratio
          // the profile asked for, not the height itself.
          authored === 0 ? 0 : entry.height / authored,
          scaleZ * entry.width
        ),
      });
      return { out: acc.out, y: acc.y + entry.height };
    },
    { out: [], y: baseZM }
  ).out;
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
    podium: partBuffer("podium"),
    floor: partBuffer("floor"),
    mech: partBuffer("mech"),
    belt: partBuffer("belt"),
    setback: partBuffer("setback"),
    crown: partBuffer("crown"),
    mast: partBuffer("mast"),
  };
};
