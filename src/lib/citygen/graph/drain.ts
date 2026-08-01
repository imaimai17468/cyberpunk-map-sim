/**
 * Bounded-chunk drain: the loop-free core every priority-queue algorithm in
 * the generator shares (Dijkstra, priority-flood, and future consumers —
 * design §12).
 *
 * `style-rules/no-loops` bans `for`/`while`, and the engine's measured
 * recursion limit is ~9,765 frames — far too shallow for one recursive call
 * per heap pop against grids up to 1,048,576 cells. `boundedDrain` instead
 * recurses once per `CHUNK`-sized batch of steps, so recursion depth is
 * `ceil(maxOps / CHUNK)` regardless of how large the underlying queue is.
 *
 * `step` must be a no-op once the queue/algorithm is done, because a chunk
 * always runs exactly `chunk` step calls without checking `isDone` partway
 * through — the check only happens between chunks.
 */

/** Steps executed per recursive `drain` call. */
export const CHUNK = 4096;

export interface BoundedDrainOptions<S> {
  /** Advances the state by exactly one queue operation; a no-op once done. */
  readonly step: (state: S) => S;
  /** Reports whether the queue/algorithm has completed. */
  readonly isDone: (state: S) => boolean;
  /**
   * Hard upper bound on total step calls, independent of `isDone`. Every
   * priority-queue algorithm here has a static op bound (each cell pushed at
   * most a fixed number of times — design §12), so this is always known in
   * advance and guarantees termination even if `isDone` never reported true.
   */
  readonly maxOps: number;
}

const drainChunk = <S>(
  state: S,
  options: BoundedDrainOptions<S>,
  opsRemaining: number
): S => {
  if (options.isDone(state) || opsRemaining <= 0) return state;
  const chunk = Math.min(CHUNK, opsRemaining);
  const nextState = Array.from({ length: chunk }).reduce<S>(
    (current) => options.step(current),
    state
  );
  return drainChunk(nextState, options, opsRemaining - chunk);
};

/**
 * Drains `state` by repeatedly applying `options.step` in bounded chunks of
 * `CHUNK` steps, recursing between chunks until `options.isDone` reports
 * completion or `options.maxOps` total steps have run.
 */
export const boundedDrain = <S>(state: S, options: BoundedDrainOptions<S>): S =>
  drainChunk(state, options, options.maxOps);
