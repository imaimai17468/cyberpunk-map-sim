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
 */

export const GOLDEN_PARAMS = {
  sizeM: 2048,
  cells: 128,
} as const;

export interface GoldenEntry {
  readonly contentHash: string;
  readonly stageHashes: Readonly<Record<StageName, string>>;
}

export const GOLDEN_CITIES: Readonly<Record<string, GoldenEntry>> = {
  "akiba-01": {
    contentHash: "dee79fa3cca2cb68",
    stageHashes: {
      terrain: "7e22e397873605da",
      hydrology: "fcfa14d079f26450",
      derived: "0eb87c35b40df7e6",
      anchors: "77f67b220d818860",
      social: "971eb99d3052a14e",
      arterials: "6775cdb6fbff02f3",
      blocks: "b8e0ee5cbcaa05c7",
      zoning: "d84bcb7ed308020d",
      lots: "264bd0d81fcfc5b2",
      buildings: "0897d160c2e3355e",
    },
  },
  "akiba-02": {
    contentHash: "7648609b58e2f055",
    stageHashes: {
      terrain: "7d83a8eb1f9050c4",
      hydrology: "b201772eac6cf3ee",
      derived: "08e62c57c6c45c13",
      anchors: "49bdb410abab47d6",
      social: "8cb24c78561f0b8e",
      arterials: "f242ef0bca610ac9",
      blocks: "730d940cdda56c49",
      zoning: "905f835c598fabea",
      lots: "a6ce60a5f20422a7",
      buildings: "f639ce14aeab52da",
    },
  },
  "akiba-03": {
    contentHash: "1c2a6024fa07315d",
    stageHashes: {
      terrain: "1e715e3193652004",
      hydrology: "7eca9d76c27f920a",
      derived: "03f4eef79adabb3d",
      anchors: "6c1fc013e115f3e0",
      social: "3ad8ded031d6406e",
      arterials: "633799ecaa19ec0a",
      blocks: "b8523d8ef551e759",
      zoning: "307796c8ba0d53ee",
      lots: "8e6a66cca35604f2",
      buildings: "52da58a45924abb6",
    },
  },
};
