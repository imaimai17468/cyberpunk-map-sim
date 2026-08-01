import { describe, expect, it } from "vitest";
import { boundedDrain, CHUNK } from "./drain";

interface CounterState {
  readonly remaining: number;
  readonly stepsRun: number;
}

const step = (state: CounterState): CounterState =>
  state.remaining <= 0
    ? state
    : { remaining: state.remaining - 1, stepsRun: state.stepsRun + 1 };

const isDone = (state: CounterState): boolean => state.remaining <= 0;

describe("boundedDrain", () => {
  it("should return the initial state unchanged when the queue is already empty", () => {
    const initial: CounterState = { remaining: 0, stepsRun: 0 };
    const result = boundedDrain(initial, { step, isDone, maxOps: 10 });
    expect(result).toEqual(initial);
  });

  it("should run zero steps when maxOps is zero even though work remains", () => {
    const initial: CounterState = { remaining: 5, stepsRun: 0 };
    const result = boundedDrain(initial, { step, isDone, maxOps: 0 });
    expect(result).toEqual(initial);
  });

  it("should run exactly one full chunk when opsRemaining equals CHUNK precisely", () => {
    const initial: CounterState = { remaining: CHUNK, stepsRun: 0 };
    const result = boundedDrain(initial, { step, isDone, maxOps: CHUNK });
    expect(result).toEqual({ remaining: 0, stepsRun: CHUNK });
  });

  it("should size the final chunk to the remaining work when it is smaller than CHUNK", () => {
    const initial: CounterState = { remaining: 1_000_000, stepsRun: 0 };
    const result = boundedDrain(initial, { step, isDone, maxOps: 10 });
    expect(result).toEqual({ remaining: 999_990, stepsRun: 10 });
  });

  it("should drain hundreds of thousands of steps without a stack overflow when the queue is large", () => {
    // Matches design §12's own Dijkstra depth bound for the default 512x512
    // grid: 8n pushes+pops with n = 262,144 cells => depth ceil(8n/4096) = 512.
    const totalOps = 8 * 262_144;
    const initial: CounterState = { remaining: totalOps, stepsRun: 0 };
    const result = boundedDrain(initial, { step, isDone, maxOps: totalOps });
    expect(result).toEqual({ remaining: 0, stepsRun: totalOps });
  });
});
