import type { StageName } from "@/entities/city";

/**
 * Committed golden hashes for the fixture seeds.
 *
 * These were deliberately withheld until the generated city had been looked at
 * on screen — a golden nobody has validated only asserts "unchanged", which is
 * worse than no golden because it manufactures confidence. The district
 * balance and building-count control are now tuned and inspected, so freezing
 * them is meaningful.
 *
 * Per-stage hashes are the point, not the whole-model one: when a golden fails
 * they name every stage whose hash diverged, so a change to hydrology does not
 * present as "the city is different".
 *
 * They do not rank them. A stage's bytes include upstream output — `hydrology`
 * serialises the corrected elevation, for instance — so one upstream change
 * cascades into every downstream stage, and the failure lists all of them.
 * Vitest prints mismatched keys alphabetically, not in pipeline order, so
 * finding the root cause means cross-referencing the reported names against
 * `STAGE_NAMES` in `entities/city` and taking the earliest.
 *
 * Regenerate deliberately, never reflexively: a diff here means the generator's
 * output changed, which is either the point of your change or a bug.
 * `GOLDEN_PARAMS` pins the configuration they were taken at; measuring at a
 * different `sizeM`/`cells` produces different hashes and proves nothing.
 *
 * They are also single-engine, and that mattered once. Until 2026-08-04 these
 * values were reproducible under vitest and not under bun — `akiba-02` came out
 * `ecf932279c0da1a6` here and `f371616bf0c27639` there — because a self-loop
 * arterial made the face rotation's comparator non-transitive and left
 * `Array.prototype.sort` free to choose (see `graph/faces.ts`'s `half`). A golden
 * cannot see that on its own: it certifies one engine against itself. What found
 * it was running the same seed under a second engine and diffing per stage, which
 * is worth doing after any change to the traversal or the geometry predicates.
 */

export const GOLDEN_PARAMS = {
  sizeM: 2048,
  cells: 128,
} as const;

export interface GoldenEntry {
  readonly contentHash: string;
  readonly stageHashes: Readonly<Record<StageName, string>>;
}

/**
 * Regenerated 2026-08-06 for the alleys, all three seeds. `lots`, `grading` and
 * `buildings` moved on every one and nothing above them moved on any: the alley
 * segments are appended to the road graph the block subdivision already built, so
 * `blocks` still hashes the network it emitted and only the stages downstream of
 * `lots` see the longer one. `lots` moves for three reasons at once — the alleys in
 * its road output, the `frontageDir` the alley-fronting lots now carry, and the
 * rings those lots gave up half a carriageway from.
 *
 * The note that follows is the previous regeneration, and its account of what this
 * configuration can and cannot witness still stands.
 *
 * Regenerated 2026-08-05 a third time, for the per-district earthwork budget. Only
 * `grading` and `buildings` move again, for the same reason as the second: the
 * budget decides which lots get a pad, and nothing upstream of `buildings` reads one.
 *
 * Regenerated 2026-08-05 a second time, for the grading stage (ADR-0028). Three
 * values moved on each seed: the new `grading`, plus `buildings` and the whole-model
 * hash. `arterials`, `blocks`, `zoning` and `lots` all reproduce the values below
 * them exactly, which is the shape ADR-0028 predicted and the evidence that grading
 * really does sit outside the decisions upstream of it — it emits levels and edits
 * no field, so nothing before `buildings` can see it.
 *
 * The note that follows is the earlier regeneration that day, for the corner
 * rounding, and its measurements about what this configuration can and cannot
 * witness still stand.
 *
 * Regenerated 2026-08-05 for the arterial corner rounding, all three seeds. Four
 * values moved on each — `arterials`, `blocks`, `buildings` and the whole-model hash
 * — plus `lots` on `akiba-02` alone. `zoning` moved nowhere.
 *
 * That distribution looks like a change that half failed to propagate, and it is
 * worth writing down as the opposite: it is what this configuration is able to see.
 * `GOLDEN_PARAMS` is 128 cells, and at that resolution almost nothing is bounded by
 * an arterial — 0, 1 and 2 blocks out of 842, 969 and 847, against 2,634 `cut` refs
 * on `akiba-01` alone. Counting the block ring vertices that land exactly on an
 * arterial's own interior vertex, the three seeds give 0, 6 and 0. `akiba-02` is the
 * only one that is not zero, and `akiba-02` is the only one whose `lots` hash moved.
 *
 * That last count is the one here that needs its method stated to be re-run: take
 * every `highway` or `avenue` edge, take `polylinePoints(...).slice(1, -1)` as its
 * interior vertices, key those and every `blockPolygons` vertex as `x.toFixed(2)`
 * with `y.toFixed(2)`, and count the ring vertices whose key is in that set. The
 * others come straight off `boundary[].kind` and the block array.
 *
 * At the 512 cells the app itself generates, the same counts are 13, 8 and 3 blocks
 * and 122, 35 and 21 ring vertices, with 143, 59 and 30 arterial refs. So the
 * coupling between road shape and block shape is live in the product and all but
 * unwitnessed here: a change that broke only that coupling would pass every hash in
 * this file on two seeds out of three. Raising the golden resolution would catch it
 * and would rewrite every value here, which is a decision of its own and not one
 * this change makes.
 *
 * `blocks` moves on every seed regardless, but at 128 cells mostly through the road
 * pool the stage emits alongside its polygons — the `blocks` writer in `pipeline.ts`
 * hashes `blockLayer.roads.polylines.coords` too. That is the arterials appearing a
 * second time, not the blocks responding to them.
 *
 * The previous regeneration, 2026-08-04, was for the self-loop determinism fix and
 * moved `akiba-02` only; `akiba-01` and `akiba-03` reproduced their older hashes
 * exactly, neither having carried a self-loop arterial.
 */
export const GOLDEN_CITIES: Readonly<Record<string, GoldenEntry>> = {
  "akiba-01": {
    contentHash: "1d51f1125cf7b382",
    stageHashes: {
      terrain: "7e22e397873605da",
      hydrology: "fcfa14d079f26450",
      derived: "0eb87c35b40df7e6",
      anchors: "77f67b220d818860",
      social: "971eb99d3052a14e",
      arterials: "6d92612038e46740",
      blocks: "5e5947b40947c784",
      zoning: "d84bcb7ed308020d",
      lots: "b97a1fdaf23cb9e2",
      grading: "227f5b6e65b589c7",
      buildings: "ac1ad884cda28e6e",
    },
  },
  "akiba-02": {
    contentHash: "aafa1b0b49387f57",
    stageHashes: {
      terrain: "7d83a8eb1f9050c4",
      hydrology: "b201772eac6cf3ee",
      derived: "08e62c57c6c45c13",
      anchors: "49bdb410abab47d6",
      social: "8cb24c78561f0b8e",
      arterials: "8ba7a4578282454f",
      blocks: "37aeef94a4894276",
      zoning: "bd368aad40fa0a0d",
      lots: "2fcc8b8f534566d2",
      grading: "2bbfb0a1d169414b",
      buildings: "003706d1c2bbdabd",
    },
  },
  "akiba-03": {
    contentHash: "6871666a2d7b0af0",
    stageHashes: {
      terrain: "1e715e3193652004",
      hydrology: "7eca9d76c27f920a",
      derived: "03f4eef79adabb3d",
      anchors: "6c1fc013e115f3e0",
      social: "3ad8ded031d6406e",
      arterials: "e6c0b3ecd7586ce7",
      blocks: "8a5300bc8fdc5163",
      zoning: "307796c8ba0d53ee",
      lots: "221a78046aa7df86",
      grading: "9de81b612de2d9bf",
      buildings: "4ad586fe35b70764",
    },
  },
};
