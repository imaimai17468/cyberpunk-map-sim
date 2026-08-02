import { generateCity } from "@/lib/citygen/pipeline";
import { describe, expect, it } from "vitest";
import {
  createTerrainMesh,
  groundHeightAt,
  renderCellSizeM,
} from "./terrainMesh";

/**
 * `groundHeightAt` answers "how high is the ground the user is looking at", and
 * the only thing that makes that answer true is agreeing with the triangles
 * `createTerrainMesh` emits. Nothing else in the app compares the two: roads are
 * positioned by the sampler and drawn against the mesh, so if the mesh's quad
 * diagonal or vertex sampling changed, roads would silently sink and every test
 * that only exercised the sampler against itself would still pass.
 *
 * So these tests read the real emitted buffers. The containing triangle is found
 * by testing both halves of the quad for barycentric containment rather than by
 * assuming which way the diagonal runs — assuming it would re-implement the very
 * thing under test.
 */

const MODEL = generateCity({ seed: "akiba-01", sizeM: 1024, cells: 128 });

interface Tri {
  readonly ax: number;
  readonly az: number;
  readonly ay: number;
  readonly bx: number;
  readonly bz: number;
  readonly by: number;
  readonly cx: number;
  readonly cz: number;
  readonly cy: number;
}

const CELL = renderCellSizeM(MODEL);
const DIVISIONS = MODEL.params.sizeM / CELL;

const { mesh } = createTerrainMesh(MODEL);
const position = mesh.geometry.getAttribute("position");
const index = mesh.geometry.getIndex();
if (index === null) throw new Error("terrain geometry must be indexed");

const triangleAt = (t: number): Tri => {
  const v = (k: number) => index.getX(t * 3 + k);
  const [ia, ib, ic] = [v(0), v(1), v(2)];
  return {
    ax: position.getX(ia),
    ay: position.getY(ia),
    az: position.getZ(ia),
    bx: position.getX(ib),
    by: position.getY(ib),
    bz: position.getZ(ib),
    cx: position.getX(ic),
    cy: position.getY(ic),
    cz: position.getZ(ic),
  };
};

/** Height at (x, z) inside `tri`, or null when the point is outside it. */
// similarity-ignore: other half of the createRoadLines pair — see the note there
const heightIn = (tri: Tri, x: number, z: number): number | null => {
  const d =
    (tri.bz - tri.cz) * (tri.ax - tri.cx) +
    (tri.cx - tri.bx) * (tri.az - tri.cz);
  if (Math.abs(d) < 1e-12) return null;
  const wa =
    ((tri.bz - tri.cz) * (x - tri.cx) + (tri.cx - tri.bx) * (z - tri.cz)) / d;
  const wb =
    ((tri.cz - tri.az) * (x - tri.cx) + (tri.ax - tri.cx) * (z - tri.cz)) / d;
  const wc = 1 - wa - wb;
  const inside = wa >= -1e-9 && wb >= -1e-9 && wc >= -1e-9;
  return inside ? wa * tri.ay + wb * tri.by + wc * tri.cy : null;
};

/** The mesh's own height at (x, z), found by scanning the containing quad. */
const meshHeightAt = (x: number, z: number): number => {
  const qx = Math.min(DIVISIONS - 1, Math.floor(x / CELL));
  const qy = Math.min(DIVISIONS - 1, Math.floor(z / CELL));
  const quad = qy * DIVISIONS + qx;
  const hit = [quad * 2, quad * 2 + 1]
    .map((t) => heightIn(triangleAt(t), x, z))
    .find((h) => h !== null);
  if (hit === undefined) throw new Error(`no triangle covers (${x}, ${z})`);
  return hit;
};

/**
 * A quad whose two triangles disagree, which most of them do not.
 *
 * Vertices are sampled nearest-cell, so neighbours frequently land in the same
 * field cell and the quad comes out flat — and over a flat quad every sampler
 * agrees, including a wrong one. Targeted cases pinned to an arbitrary quad
 * therefore passed with the diagonal deliberately reversed. This picks the
 * steepest quad on the map so the two halves genuinely differ.
 */
const ROUGH = Array.from({ length: DIVISIONS * DIVISIONS }, (_v, quad) => {
  const heights = [quad * 2, quad * 2 + 1].flatMap((t) => {
    const tri = triangleAt(t);
    return [tri.ay, tri.by, tri.cy];
  });
  return {
    qx: quad % DIVISIONS,
    qy: Math.floor(quad / DIVISIONS),
    relief: Math.max(...heights) - Math.min(...heights),
  };
}).reduce((a, b) => (b.relief > a.relief ? b : a));

describe("groundHeightAt", () => {
  it("should have relief in the sampled quad when picking the steepest one", () => {
    expect(ROUGH.relief).toBeGreaterThan(1);
  });

  it("should match the mesh's own vertex height when asked at a grid corner", () => {
    const x = CELL * ROUGH.qx;
    const z = CELL * ROUGH.qy;
    expect(groundHeightAt(MODEL, { x, y: z })).toBeCloseTo(
      meshHeightAt(x, z),
      4
    );
  });

  it.each([
    ["a lower-half point", 0.2, 0.3],
    ["an upper-half point", 0.8, 0.7],
    ["a point beside the diagonal", 0.49, 0.49],
    ["a point past the diagonal", 0.51, 0.51],
    ["a point on an edge", 0.0, 0.6],
  ])(
    "should match the drawn triangle when sampling %s inside a quad",
    (_label, ds, dt) => {
      const x = CELL * (ROUGH.qx + ds);
      const z = CELL * (ROUGH.qy + dt);
      expect(groundHeightAt(MODEL, { x, y: z })).toBeCloseTo(
        meshHeightAt(x, z),
        4
      );
    }
  );

  it("should match the drawn surface when swept across the whole map", () => {
    const cells = 23;
    const worst = Array.from({ length: cells * cells }, (_v, k) => {
      const i = k % cells;
      const j = Math.floor(k / cells);
      // Irrational-ish offsets so the sweep lands inside quads, not on corners.
      const x = ((i + 0.371) / cells) * MODEL.params.sizeM;
      const z = ((j + 0.629) / cells) * MODEL.params.sizeM;
      return Math.abs(groundHeightAt(MODEL, { x, y: z }) - meshHeightAt(x, z));
    }).reduce((a, b) => Math.max(a, b), 0);
    expect(worst).toBeLessThan(1e-3);
  });

  it("should stay on the mesh when asked at the far corner of the map", () => {
    const edge = MODEL.params.sizeM;
    expect(Number.isFinite(groundHeightAt(MODEL, { x: edge, y: edge }))).toBe(
      true
    );
  });
});
