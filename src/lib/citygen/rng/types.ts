/**
 * The random-number boundary for the generator.
 *
 * Declared as an interface with a single implementation on purpose: stages
 * depend on this shape, not on xoshiro, so the algorithm can be replaced
 * without touching a stage. Every stage receives its own stream, and every
 * entity forks a substream from a stable id — never from an accept-order
 * counter — so adding a draw in one place cannot reshuffle another.
 */
export interface RngStream {
  /** Uniform in [0, 1) with 24 bits of resolution. */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /** A substream keyed by stable labels. */
  fork(...labels: readonly (string | number)[]): RngStream;
}
