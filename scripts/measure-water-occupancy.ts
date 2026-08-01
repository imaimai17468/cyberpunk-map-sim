/**
 * Counts what the generator puts on water, so the figures quoted in
 * `blocks.ts` and `buildings.ts` can be re-derived rather than believed.
 *
 * Run with `bun run scripts/measure-water-occupancy.ts`. To see the numbers the
 * fix was written against, stash the working tree first — the comments cite the
 * pre-fix run at the app's own default extent and resolution, which is what
 * `PARAMS` below reproduces.
 *
 * Deliberately outside `src/`, so the no-loops rule that governs the engine
 * does not apply and this can read as ordinary measurement code.
 */
import type { CityModel, Vec2 } from "../src/entities/city";
import { generateCity } from "../src/lib/citygen/pipeline";

/** The app's defaults, which is where every quoted figure was taken. */
const PARAMS = { sizeM: 2048, cells: 512 } as const;
const SEEDS = ["akiba-01", "akiba-02", "akiba-03"] as const;

/** Nearest-cell water class at a world point. 0 is dry. */
const waterAt = (m: CityModel, p: Vec2): number => {
  const cells = m.terrain.elevation.cells;
  const cx = Math.min(
    cells - 1,
    Math.max(0, Math.floor((p.x / m.params.sizeM) * cells))
  );
  const cy = Math.min(
    cells - 1,
    Math.max(0, Math.floor((p.y / m.params.sizeM) * cells))
  );
  return m.terrain.waterMask[cy * cells + cx];
};

const corners = (o: CityModel["buildings"][number]["obb"]): Vec2[] => {
  const ax = o.facing.x * (o.w / 2);
  const ay = o.facing.y * (o.w / 2);
  const bx = -o.facing.y * (o.d / 2);
  const by = o.facing.x * (o.d / 2);
  return [
    { x: o.cx + ax + bx, y: o.cy + ay + by },
    { x: o.cx - ax + bx, y: o.cy - ay + by },
    { x: o.cx - ax - bx, y: o.cy - ay - by },
    { x: o.cx + ax - bx, y: o.cy + ay - by },
  ];
};

/** Every road segment in the graph, paired with the edge it came from. */
const segmentsOf = (m: CityModel) => {
  const { coords, starts } = m.roads.polylines;
  return m.roads.edges.flatMap((edge) => {
    const from = starts[edge.polylineIndex];
    const to = starts[edge.polylineIndex + 1];
    return Array.from({ length: Math.max(0, to - from - 1) }, (_v, k) => {
      const i = from + k;
      return {
        edge,
        a: { x: coords[i * 2], y: coords[i * 2 + 1] },
        b: { x: coords[(i + 1) * 2], y: coords[(i + 1) * 2 + 1] },
      };
    });
  });
};

const report = (seed: string): string => {
  const m = generateCity({ seed, ...PARAMS });

  // Centre only, which is how the pre-fix figures were taken; the corner test
  // below is the stricter one the fix is now measured against.
  const centreWet = m.buildings.filter((b) =>
    waterAt(m, { x: b.obb.cx, y: b.obb.cy })
  );
  const anyCornerWet = m.buildings.filter((b) =>
    [...corners(b.obb), { x: b.obb.cx, y: b.obb.cy }].some((p) => waterAt(m, p))
  );
  const byArchetype = centreWet.reduce<Record<string, number>>((acc, b) => {
    acc[b.archetype] = (acc[b.archetype] ?? 0) + 1;
    return acc;
  }, {});

  const segments = segmentsOf(m);
  const overWater = segments.filter(
    ({ edge, a, b }) =>
      edge.crossing !== "bridge" &&
      waterAt(m, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  );
  const wetStreets = overWater.filter(({ edge }) => edge.cls === "street");
  const bothEndsWet = overWater.filter(
    ({ a, b }) => waterAt(m, a) && waterAt(m, b)
  );

  return (
    `${seed} ${PARAMS.sizeM}m/${PARAMS.cells}: ` +
    `buildings=${m.buildings.length} centreOnWater=${centreWet.length} ` +
    `anyCornerOnWater=${anyCornerWet.length} ${JSON.stringify(byArchetype)} | ` +
    `segments=${segments.length} wetStreets=${wetStreets.length} ` +
    `bothEndsWet=${bothEndsWet.length}`
  );
};

// `process.stdout` rather than `console.log`: the no-console rule is about
// debug output left in shipped code, and suppressing it with a disable comment
// to print the one thing this file exists to print would be arguing with the
// rule rather than not tripping it.
process.stdout.write(`${SEEDS.map(report).join("\n")}\n`);
