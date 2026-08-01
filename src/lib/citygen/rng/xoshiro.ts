import { fnv1a32, splitmix32 } from "./hash";
import type { RngStream } from "./types";

/** 2^24, the resolution of `next()`. */
const TWO_24 = 16777216;
/** 2^32, used to normalise a 32-bit word before scaling in `nextInt`. */
const TWO_32 = 4294967296;

const STATE_WORDS = 4;

/**
 * Separates the two master lanes so `m1` cannot collide with `m0`.
 * A control character keeps it out of any realistic seed string.
 */
const SEED_LANE_SEPARATOR = "\u0001";

const rotl = (x: number, k: number): number =>
  ((x << k) | (x >>> (32 - k))) >>> 0;

/** Four successive splitmix32 outputs, seeded from one word. */
const seedState = (seedWord: number): Uint32Array => {
  const words = Array.from({ length: STATE_WORDS }).reduce<{
    state: number;
    out: readonly number[];
  }>(
    (acc) => {
      const stepped = splitmix32(acc.state);
      return { state: stepped.state, out: [...acc.out, stepped.value] };
    },
    { state: seedWord | 0, out: [] }
  );
  return Uint32Array.from(words.out);
};

/**
 * xoshiro128++ over an owned state buffer.
 *
 * The buffer is created inside this factory, so writing into it is local
 * mutation, not a parameter reassignment.
 */
const streamFromState = (state: Uint32Array): RngStream => {
  const nextWord = (): number => {
    // Uint32Array reads are always numbers; the buffer is length 4 by
    // construction in seedState, so no fallback branch is needed here.
    const s0 = state[0];
    const s1 = state[1];
    const s2 = state[2];
    const s3 = state[3];
    const result = (rotl((s0 + s3) >>> 0, 7) + s0) >>> 0;
    const t = (s1 << 9) >>> 0;
    const n2 = (s2 ^ s0) >>> 0;
    const n3 = (s3 ^ s1) >>> 0;
    state[0] = (s0 ^ n3) >>> 0;
    state[1] = (s1 ^ n2) >>> 0;
    state[2] = (n2 ^ t) >>> 0;
    state[3] = rotl(n3, 11);
    return result;
  };

  const forkSeed = (labels: readonly (string | number)[]): number =>
    labels.reduce<number>(
      (acc, label) =>
        splitmix32(
          (acc ^ (typeof label === "number" ? label >>> 0 : fnv1a32(label))) | 0
        ).value,
      state[0] | 0
    );

  return {
    next: () => (nextWord() >>> 8) / TWO_24,
    /**
     * Scaling by a power-of-two division first keeps the intermediate exact,
     * so the result is identical on every engine.
     */
    nextInt: (maxExclusive: number) =>
      maxExclusive <= 1
        ? 0
        : Math.min(
            maxExclusive - 1,
            Math.floor((nextWord() / TWO_32) * maxExclusive)
          ),
    fork: (...labels: readonly (string | number)[]) =>
      streamFromState(seedState(forkSeed(labels))),
  };
};

/** The two master words derived from the user-supplied seed string. */
export interface MasterSeed {
  readonly m0: number;
  readonly m1: number;
}

export const masterSeed = (seed: string): MasterSeed => ({
  m0: fnv1a32(seed),
  m1: fnv1a32(seed + SEED_LANE_SEPARATOR),
});

/**
 * The stream for one pipeline stage. Mixing the stage label into the seed is
 * what makes stages independent: adding a draw inside one stage cannot shift
 * any other stage's sequence.
 */
export const stageStream = (
  master: MasterSeed,
  stageLabel: string
): RngStream => {
  const state = seedState((master.m0 ^ fnv1a32(stageLabel)) | 0);
  state[0] = ((state[0] ?? 0) ^ master.m1) >>> 0;
  return streamFromState(state);
};

/** Exposed for the known-answer tests. */
export const streamFromSeedWord = (seedWord: number): RngStream =>
  streamFromState(seedState(seedWord));
