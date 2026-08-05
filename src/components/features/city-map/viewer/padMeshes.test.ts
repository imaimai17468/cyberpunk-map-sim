import { describe, expect, it } from "vitest";
import { GOLDEN_PARAMS } from "@/lib/citygen/golden";
import { generateCity } from "@/lib/citygen/pipeline";
import { PAD_LIFT_M, padMeshOf } from "./padMeshes";
import { groundHeightAt } from "./terrainMesh";

/**
 * Built against a real city rather than a fixture. The mesh is a function of the
 * lot rings, the pad levels and the drawn terrain all at once, and a hand-made
 * model that satisfied all three would be the generator.
 */
const city = generateCity({ seed: "akiba-01", ...GOLDEN_PARAMS });
const mesh = padMeshOf(city);

const vertexCount = mesh.positions.length / 3;
const heightAt = (v: number): number => mesh.positions[v * 3 + 1];

describe("padMeshOf", () => {
  it("should emit geometry when the city has graded lots", () => {
    const padded = city.grading.padded.reduce((n, v) => n + v, 0);
    // The count travels with the assertion so this cannot pass by the city
    // happening to grade nothing.
    expect([mesh.indices.length > 0, padded > 0]).toEqual([true, true]);
  });

  it("should index every vertex it emits when building the mesh", () => {
    expect(mesh.indices.length).toBe(vertexCount);
  });

  it("should colour every vertex in both views when building the mesh", () => {
    expect([mesh.colors["2d"].length, mesh.colors["3d"].length]).toEqual([
      vertexCount * 3,
      vertexCount * 3,
    ]);
  });

  /**
   * Every vertex is on a platform or on the ground, and nothing is in between.
   *
   * That is the shape of the whole mesh: a level top at some lot's pad height, and
   * a skirt whose feet are on the drawn terrain. A vertex at neither would be a
   * platform that is not level or a skirt that stops in mid-air, and both would
   * read as the floating this stage exists to remove.
   */
  it("should place every vertex on a pad top or on the ground when building the mesh", () => {
    const tops = new Set(
      Array.from(city.grading.padZ, (z, i) =>
        city.grading.padded[i] === 1 ? (z + PAD_LIFT_M).toFixed(2) : null
      ).filter((z): z is string => z !== null)
    );
    const stray = Array.from({ length: vertexCount }, (_v, i) => i).filter(
      (i) => {
        const z = heightAt(i);
        if (tops.has(z.toFixed(2))) return false;
        const ground = groundHeightAt(city, {
          x: mesh.positions[i * 3],
          y: mesh.positions[i * 3 + 2],
        });
        return Math.abs(z - ground) > 1e-3;
      }
    );
    expect(stray).toEqual([]);
  });

  it("should reach down to the ground with its skirt when a pad stands above it", () => {
    const lowest = Array.from({ length: vertexCount }, (_v, i) =>
      heightAt(i)
    ).reduce((m, z) => Math.min(m, z), Number.POSITIVE_INFINITY);
    const padLow = city.grading.padZ.reduce(
      (m, z, i) => (city.grading.padded[i] === 1 ? Math.min(m, z) : m),
      Number.POSITIVE_INFINITY
    );
    // A skirt foot is on natural ground, which is below the lowest pad wherever
    // the pad was filled — so the mesh must descend past the lowest platform.
    expect(lowest).toBeLessThan(padLow);
  });

  it("should return an empty mesh when no lot was graded", () => {
    const ungraded = padMeshOf({
      ...city,
      grading: {
        ...city.grading,
        padded: new Uint8Array(city.grading.padded.length),
      },
    });
    expect([
      ungraded.indices.length,
      ungraded.positions.length,
      ungraded.colors["2d"].length,
    ]).toEqual([0, 0, 0]);
  });

  it("should contain no NaN when building the mesh", () => {
    expect(mesh.positions.some((v) => Number.isNaN(v))).toBe(false);
  });
});
