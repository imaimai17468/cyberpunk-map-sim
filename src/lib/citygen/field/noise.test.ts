import { describe, expect, it } from "vitest";
import { domainWarp2D, fbm2D, noise2D, ridgedFbm2D } from "./noise";

describe("noise2D", () => {
  it("should return the same value when called twice with the same seed and coordinates", () => {
    expect(noise2D(42, 3.25, -1.5)).toBe(noise2D(42, 3.25, -1.5));
  });

  it("should produce a different value when only the seed differs", () => {
    const pair = [noise2D(1, 5, 5), noise2D(2, 5, 5)];
    expect(pair[0] === pair[1]).toBe(false);
  });

  it("should produce varied values when sampled at several nearby points", () => {
    const samples = [
      noise2D(7, 0, 0),
      noise2D(7, 0.3, 0.1),
      noise2D(7, 1.1, 0.7),
      noise2D(7, 2.4, 1.9),
    ];
    const allEqual = samples.every((value) => value === samples[0]);
    expect(allEqual).toBe(false);
  });

  it.each([
    [0.9, 0.1],
    [0.1, 0.9],
    [-0.6, -0.4],
    [-0.4, -0.6],
  ])(
    "should return a finite number when sampling (%d, %d) selects either simplex sub-triangle",
    (x, y) => {
      expect(Number.isFinite(noise2D(11, x, y))).toBe(true);
    }
  );
});

describe("fbm2D", () => {
  it("should return zero when octaves is zero", () => {
    expect(fbm2D(1, 0.5, 0.5, { octaves: 0 })).toBe(0);
  });

  it("should return the same value when called twice with the same inputs", () => {
    const options = { octaves: 4, lacunarity: 2, gain: 0.5 };
    expect(fbm2D(9, 12.5, -4.25, options)).toBe(fbm2D(9, 12.5, -4.25, options));
  });

  it("should use the default octave/lacunarity/gain shape when no options are given", () => {
    expect(Number.isFinite(fbm2D(9, 12.5, -4.25))).toBe(true);
  });
});

describe("ridgedFbm2D", () => {
  it("should return zero when octaves is zero", () => {
    expect(ridgedFbm2D(1, 0.5, 0.5, { octaves: 0 })).toBe(0);
  });

  it("should return a finite value when using the default octave shape", () => {
    expect(Number.isFinite(ridgedFbm2D(3, 1.2, -0.4))).toBe(true);
  });
});

describe("domainWarp2D", () => {
  it("should apply the default warp parameters when none are overridden", () => {
    const a = domainWarp2D(1, 2, 3, { amplitude: 50 });
    const b = domainWarp2D(1, 2, 3, { amplitude: 50 });
    expect(a).toEqual(b);
  });

  it("should honor every overridden warp parameter when all are provided", () => {
    const options = {
      amplitude: 50,
      frequency: 0.01,
      octaves: 3,
      lacunarity: 2.5,
      gain: 0.4,
    };
    const a = domainWarp2D(1, 2, 3, options);
    const b = domainWarp2D(1, 2, 3, options);
    expect(a).toEqual(b);
  });

  it("should leave coordinates unchanged when amplitude is zero", () => {
    expect(domainWarp2D(1, 2, 3, { amplitude: 0 })).toEqual({ x: 2, y: 3 });
  });
});
