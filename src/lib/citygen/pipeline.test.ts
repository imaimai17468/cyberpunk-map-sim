import { describe, expect, it } from "vitest";
import {
  DISTRICT_KINDS,
  type DistrictKind,
  type Discard,
  type GenerationParams,
  PROGRESS_STEPS,
  type PolygonPool,
  type Vec2,
} from "@/entities/city";
import { isSelfIntersecting } from "./geometry/polygon";
import { GOLDEN_CITIES, GOLDEN_PARAMS } from "./golden";
import { generateCity, zoningStageBytes } from "./pipeline";
import { expectedLotCount, unclampedAreaScale } from "./stages/lots";
import { gridOf } from "./stages/types";
import { totalInstanceCount } from "./stages/assemble";

/**
 * End-to-end pipeline invariants.
 *
 * Runs at a reduced grid so the suite stays fast; the properties asserted are
 * scale-independent. Golden hashes live in `golden.ts` and are asserted below;
 * they were withheld until the tuning they freeze had been looked at on screen.
 */

const params = (
  overrides: Partial<GenerationParams> = {}
): GenerationParams => ({
  seed: "akiba-01",
  sizeM: 2048,
  cells: 128,
  ...overrides,
});

const city = generateCity(params());

describe("generateCity", () => {
  it("should produce buildings when run on a fixture seed", () => {
    expect(city.buildings.length).toBeGreaterThan(0);
  });

  it("should produce blocks when run on a fixture seed", () => {
    expect(city.blocks.length).toBeGreaterThan(0);
  });

  it("should produce roads when run on a fixture seed", () => {
    expect(city.roads.edges.length).toBeGreaterThan(0);
  });

  it("should produce lots when run on a fixture seed", () => {
    expect(city.lots.length).toBeGreaterThan(0);
  });

  it("should pack an instance for every building tier when assembling", () => {
    const tierTotal = city.buildings.reduce((n, b) => n + b.tiers.length, 0);
    expect(totalInstanceCount(city.instances)).toBe(tierTotal);
  });

  it("should carve a coastline when the sea level percentile is applied", () => {
    const wet = city.terrain.waterMask.reduce((n, v) => (v > 0 ? n + 1 : n), 0);
    expect(wet).toBeGreaterThan(0);
  });

  it("should produce real relief when terrain is generated", () => {
    const data = city.terrain.elevation.data;
    const spread =
      data.reduce((m, v) => Math.max(m, v), -Infinity) -
      data.reduce((m, v) => Math.min(m, v), Infinity);
    expect(spread).toBeGreaterThan(50);
  });

  it("should contain no NaN in the instance buffers when assembling", () => {
    const bad = Object.values(city.instances).some((buffer) =>
      buffer.matrices.some((v) => Number.isNaN(v))
    );
    expect(bad).toBe(false);
  });
});

/**
 * Progress covers every step, including the one that used to be silent.
 *
 * `assemble` runs after `buildings` and was never reported, so the last thing a
 * caller heard was "buildings started" while instance packing and ten hashes over
 * the full field data still ran. Asserted as the exact index sequence rather than
 * as a count, because the property that matters is that each step is announced
 * once, in order, and that the indices address `PROGRESS_STEPS`.
 */
describe("progress reporting", () => {
  it("should announce every step once in order when generating", () => {
    const steps: number[] = [];
    generateCity(params(), { onProgress: (i) => steps.push(i) });
    expect(steps).toEqual(PROGRESS_STEPS.map((_step, index) => index));
  });

  it("should name assemble as the last reported step when generating", () => {
    const steps: number[] = [];
    generateCity(params(), { onProgress: (i) => steps.push(i) });
    expect(PROGRESS_STEPS[steps[steps.length - 1]]).toBe("assemble");
  });
});

describe("determinism", () => {
  it("should produce an identical content hash when run twice with one seed", () => {
    expect(generateCity(params()).contentHash).toBe(city.contentHash);
  });

  it("should produce a different content hash when the seed differs", () => {
    expect(generateCity(params({ seed: "akiba-02" })).contentHash).not.toBe(
      city.contentHash
    );
  });

  it("should produce an identical per-stage hash set when run twice", () => {
    expect(generateCity(params()).stageHashes).toEqual(city.stageHashes);
  });

  it("should reject params when the grid is out of range", () => {
    expect(() => generateCity(params({ cells: 4 }))).toThrow(/cells/i);
  });
});

describe("district composition", () => {
  it("should assign every block a known district when zoning runs", () => {
    const unknown = city.blocks.filter(
      (b) => !DISTRICT_KINDS.includes(b.district)
    );
    expect(unknown).toEqual([]);
  });

  it("should place more than one kind of district when the map is generated", () => {
    expect(new Set(city.blocks.map((b) => b.district)).size).toBeGreaterThan(1);
  });
});

const bytesOf = (districts: readonly DistrictKind[]): string =>
  [...zoningStageBytes(districts.map((district) => ({ district })))].join(",");

/**
 * Regression for the zoning stage hash.
 *
 * The encoder previously used the district *name length*, which made the
 * three six-character districts indistinguishable. The whole point of a
 * per-stage hash is that a golden failure names the stage that diverged, so a
 * collision here silently costs that diagnostic.
 */
describe("zoningStageBytes", () => {
  it("should differ when two same-length districts are swapped", () => {
    expect(bytesOf(["casino", "luxury"])).not.toBe(
      bytesOf(["luxury", "casino"])
    );
  });

  it("should differ when a block moves between two nine-character districts", () => {
    expect(bytesOf(["corporate"])).not.toBe(bytesOf(["megablock"]));
  });

  it.each([
    ["casino", "luxury"],
    ["luxury", "suburb"],
    ["casino", "suburb"],
  ] as const)(
    "should encode %s and %s differently when both are six characters",
    (a, b) => {
      expect(bytesOf([a])).not.toBe(bytesOf([b]));
    }
  );

  it("should produce identical bytes when the district sequence is unchanged", () => {
    expect(bytesOf(["slum", "corporate"])).toBe(bytesOf(["slum", "corporate"]));
  });
});

/**
 * The design's own district-coverage invariant.
 *
 * Zoning is a relative argmax, so nothing structurally guarantees all six
 * districts appear — the guarantee is empirical, over the fixture seeds. It
 * failed before the affinity weights were calibrated (slum took 57-61% of
 * blocks and luxury and suburb were 0-3%), which is exactly the regression
 * this pins.
 */
describe("district coverage on fixture seeds", () => {
  it.each(["akiba-01", "akiba-02", "akiba-03"])(
    "should place every district and land in the count band when generating seed %s",
    (seed) => {
      const generated = generateCity(params({ seed, cells: 256 }));
      const present = new Set(generated.blocks.map((b) => b.district));
      const count = generated.buildings.length;
      // Asserted as one object so both invariants share a single pipeline run
      // and a single expect (arch-rules/single-expect).
      expect({
        missing: DISTRICT_KINDS.filter((k) => !present.has(k)),
        inBand: count >= 3000 && count <= 8000,
      }).toEqual({ missing: [], inBand: true });
    }
  );

  /**
   * The count control targets a density, so the invariant that generalises is
   * buildings per km2 — not an absolute total, which is only meaningful at the
   * design's ~4 km2 extent. Before the target became a density this failed:
   * the upper clamp saturated above the default size, so 4096 m produced about
   * 20,000 buildings whether or not the overshoot correction was applied.
   */
  it.each([1024, 2048, 4096])(
    "should hold the building density when the extent is %s m",
    (sizeM) => {
      // cells:128 — the property under test is invariance with respect to
      // *area*, not field resolution, and 128 exercises it at a third of the
      // cost (the suite went 7.3s -> 11.3s when this ran at 256).
      const generated = generateCity(params({ sizeM, cells: 128 }));
      const perKm2 = generated.buildings.length / ((sizeM * sizeM) / 1_000_000);
      expect(perKm2 > 1000 && perKm2 < 1800).toBe(true);
    }
  );
});

/**
 * Clamp-saturation guard.
 *
 * The count control's clamp still saturates for some (seed, extent, cells)
 * combinations, and where it does the closed-form control stops governing and
 * the residual is absorbed silently. The density band above cannot see that —
 * it only sees the outcome, which stays in band on the margin, which is how
 * this hid through two earlier fixes. This asserts the pre-clamp ratio
 * directly, so the accepted bound is pinned and any worsening fails.
 *
 * Measured maximum at the time of writing: 1.9055 (akiba-01, 4096 m, 128
 * cells). The ceiling below is that plus headroom, not an aspiration.
 */
describe("count-control clamp saturation", () => {
  const MAX_ACCEPTED_UNCLAMPED = 2;

  it.each([
    ["akiba-01", 1024],
    ["akiba-01", 4096],
    ["akiba-02", 4096],
    ["akiba-03", 4096],
  ])(
    "should keep the pre-clamp scale under the accepted bound for %s at %s m",
    (seed, sizeM) => {
      const generated = generateCity(params({ seed, sizeM, cells: 128 }));
      const ratio = unclampedAreaScale(
        expectedLotCount({
          blocks: generated.blocks,
          blockPolygons: generated.blockPolygons,
          grid: gridOf(generated.params),
          roads: generated.roads,
        }),
        (sizeM * sizeM) / 1_000_000
      );
      expect(ratio < MAX_ACCEPTED_UNCLAMPED).toBe(true);
    }
  );
});

/**
 * Golden hashes. See `golden.ts` for why they exist and when to regenerate.
 *
 * The per-stage assertion is the useful one: it names every stage whose hash
 * diverged, rather than reporting only that the city changed. It does not rank
 * them — vitest lists mismatched keys alphabetically, not in pipeline order —
 * so when several diverge together, cross-reference `STAGE_NAMES` to find the
 * upstream one. The whole-model hash is asserted separately so a serialisation
 * change that leaves every stage intact still fails.
 */
/** The ring the pool holds at `index`, as points. */
const ringAt = (pool: PolygonPool, index: number): readonly Vec2[] => {
  const start = pool.starts[index];
  const end = pool.starts[index + 1];
  return Array.from({ length: end - start }, (_value, i) => ({
    x: pool.coords[(start + i) * 2],
    y: pool.coords[(start + i) * 2 + 1],
  }));
};

describe("golden hashes", () => {
  // Memoised: the stage-hash and content-hash assertions are separate tests
  // (single-expect), but they should not pay for two generations per seed.
  // Seeded from the module-level fixture: `params()`'s defaults are exactly
  // GOLDEN_PARAMS with seed akiba-01, so an empty cache paid for a second full
  // generation (~450ms) of a city this file had already built.
  const cache = new Map<string, ReturnType<typeof generateCity>>([
    [city.params.seed, city],
  ]);
  const goldenFor = (seed: string) => {
    const hit = cache.get(seed);
    if (hit !== undefined) return hit;
    const generated = generateCity(params({ seed, ...GOLDEN_PARAMS }));
    cache.set(seed, generated);
    return generated;
  };

  it.each(Object.keys(GOLDEN_CITIES))(
    "should reproduce every stage hash when generating seed %s",
    (seed) => {
      expect(goldenFor(seed).stageHashes).toEqual(
        GOLDEN_CITIES[seed].stageHashes
      );
    }
  );

  it.each(Object.keys(GOLDEN_CITIES))(
    "should reproduce the content hash when generating seed %s",
    (seed) => {
      expect(goldenFor(seed).contentHash).toBe(GOLDEN_CITIES[seed].contentHash);
    }
  );

  /**
   * A block ring that crosses itself is not a shape anything downstream can
   * reason about: its shoelace area can come out positive while the polygon is
   * folded, so it passes the area floor, and `zoning` then scores a district
   * from a centroid that is outside it. `lots.ts` checks the *inset* ring and
   * rejects what it finds, but that is a late and partial catch — the fold has
   * already decided which district the block is.
   *
   * Asserted here rather than in `blocks.test.ts` because the folds only appear
   * for real arterial graphs; that file's only `RoadGraph` fixture has no edges
   * at all, so subdivision there never sees a face with the topology that
   * produces one.
   */
  /**
   * The observer is the one thing injected into a pure engine, so the property
   * that keeps ADR-0027 true is that attaching one changes nothing. It holds
   * because `DiscardObserver` returns `void` and no stage reads it back — but
   * that is a claim about every call site, and a call site could start reading
   * a return value without any type error. This is what would catch that.
   */
  it("should produce identical output when an observer is attached", () => {
    const seen: Discard[] = [];
    const watched = generateCity(
      params({ seed: "akiba-02", ...GOLDEN_PARAMS }),
      {
        onDiscard: (d) => seen.push(d),
      }
    );
    const unwatched = generateCity(
      params({ seed: "akiba-02", ...GOLDEN_PARAMS })
    );
    // The second element is what stops this passing vacuously: a seed whose
    // engine never calls the observer would prove nothing about attaching one.
    expect([watched.contentHash, seen.length > 0]).toEqual([
      unwatched.contentHash,
      true,
    ]);
  });

  /**
   * Pinned as exact counts, not "at least one". These are the numbers a reader
   * would otherwise go and measure, and a measurement written from outside the
   * engine is how several wrong figures got into this repo — it reconstructs a
   * decision instead of asking about it. Fixing the counts here means the
   * engine's answer and the committed answer cannot drift apart silently.
   *
   * Taken under vitest, which is what asserts them — and as of 2026-08-04 bun
   * agrees, seed for seed and stage for stage. It did not before: the same seed
   * reported 5 folded blocks and 1 inside-out block here against 2 and none there,
   * because a self-loop arterial made the face rotation's comparator
   * non-transitive and `Array.prototype.sort` was free to resolve it differently
   * per engine (`graph/faces.ts`'s `half`). Regenerate these from inside the test
   * runner, as with the goldens, and re-check a second engine after touching the
   * traversal.
   *
   * The list is asserted whole rather than per reason, which is what caught a
   * regression these counts would otherwise have hidden: excluding a folded
   * outer face before subdivision took `folded-block` from 5 to 2 and looked
   * like an improvement, when 3 of those discards had merely stopped being
   * reported. Asserting the sequence means a reason that disappears fails here.
   *
   * `folded-block` reads 1 rather than 5 and `inside-out-block` is absent for the
   * same reason the hashes moved: the one self-loop was producing four of the
   * folds and the inside-out block, so removing it removed them. That is a change
   * in what the engine builds, not in what it chooses to mention — the seed's
   * blocks really are different now, which is why `golden.ts` moved with it.
   */
  it("should report every discard it made when one is observed", () => {
    const seen: Discard[] = [];
    generateCity(params({ seed: "akiba-02", ...GOLDEN_PARAMS }), {
      onDiscard: (d) => seen.push(d),
    });
    expect(seen).toEqual([
      { stage: "arterials", reason: "zero-length-edge", count: 259 },
      { stage: "arterials", reason: "duplicate-route", count: 58 },
      { stage: "blocks", reason: "self-loop-edge", count: 1 },
      { stage: "blocks", reason: "folded-block", count: 1 },
    ]);
  });

  /**
   * The streamed account and the account on the model are the same account.
   *
   * Asserted against the observer rather than against a copy of the numbers,
   * because a second literal list is a second thing to keep in step — and the
   * whole reason `discards` exists on the model is that a figure reconstructed
   * outside the engine is how several wrong ones got into this repo.
   */
  it("should carry the discards it streamed on the model when one is observed", () => {
    const seen: Discard[] = [];
    const generated = generateCity(
      params({ seed: "akiba-02", ...GOLDEN_PARAMS }),
      { onDiscard: (d) => seen.push(d) }
    );
    expect(generated.discards).toEqual(seen);
  });

  /** No observer attached is not a reason for the model to know less. */
  it("should carry the discards on the model when nobody is observing", () => {
    expect(
      generateCity(params({ seed: "akiba-02", ...GOLDEN_PARAMS })).discards
    ).toEqual([
      { stage: "arterials", reason: "zero-length-edge", count: 259 },
      { stage: "arterials", reason: "duplicate-route", count: 58 },
      { stage: "blocks", reason: "self-loop-edge", count: 1 },
      { stage: "blocks", reason: "folded-block", count: 1 },
    ]);
  });

  it("should report nothing it did not discard when one is observed", () => {
    const seen: Discard[] = [];
    generateCity(params({ seed: "akiba-01", ...GOLDEN_PARAMS }), {
      onDiscard: (d) => seen.push(d),
    });
    // This seed folds no block at this grid, so no folded-block line appears.
    expect(seen.map((d) => d.reason)).toEqual([
      "zero-length-edge",
      "duplicate-route",
    ]);
  });

  it.each(Object.keys(GOLDEN_CITIES))(
    "should leave no self-intersecting block ring when generating seed %s",
    (seed) => {
      const model = goldenFor(seed);
      expect(
        model.blocks.filter((block) =>
          isSelfIntersecting(ringAt(model.blockPolygons, block.ringIndex))
        )
      ).toEqual([]);
    }
  );
});
