import { describe, expect, it } from "vitest";
import { masterSeed, stageStream, streamFromSeedWord } from "./xoshiro";

const draws = (count: number, seedWord: number): readonly number[] => {
  const stream = streamFromSeedWord(seedWord);
  return Array.from({ length: count }, () => stream.next());
};

describe("streamFromSeedWord", () => {
  it("should produce an identical sequence when seeded with the same word", () => {
    expect(draws(8, 42)).toEqual(draws(8, 42));
  });

  it("should produce a different sequence when the seed word differs", () => {
    expect(draws(8, 42)).not.toEqual(draws(8, 43));
  });

  it("should stay within the unit interval when drawing many values", () => {
    expect(draws(512, 7).every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it("should not repeat immediately when drawing consecutive values", () => {
    const pair = draws(2, 99);
    expect(pair[0] === pair[1]).toBe(false);
  });
});

describe("nextInt", () => {
  it("should return zero when the bound is one", () => {
    expect(streamFromSeedWord(1).nextInt(1)).toBe(0);
  });

  it("should return zero when the bound is zero", () => {
    expect(streamFromSeedWord(1).nextInt(0)).toBe(0);
  });

  it("should stay inside the bound when drawing many values", () => {
    const stream = streamFromSeedWord(5);
    const values = Array.from({ length: 1000 }, () => stream.nextInt(6));
    expect(values.every((v) => Number.isInteger(v) && v >= 0 && v < 6)).toBe(
      true
    );
  });

  it("should reach every value when the bound is small and the sample is large", () => {
    const stream = streamFromSeedWord(11);
    const seen = new Set(Array.from({ length: 1000 }, () => stream.nextInt(4)));
    expect([...seen].toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});

describe("fork", () => {
  it("should produce the same substream when forked twice with equal labels", () => {
    const parent = streamFromSeedWord(3);
    const a = parent.fork("lots", 12, 0).next();
    const b = parent.fork("lots", 12, 0).next();
    expect(a).toBe(b);
  });

  it("should diverge when only the last label differs", () => {
    const parent = streamFromSeedWord(3);
    const a = parent.fork("lots", 12, 0).next();
    const b = parent.fork("lots", 12, 1).next();
    expect(a === b).toBe(false);
  });

  it("should diverge when only the first label differs", () => {
    const parent = streamFromSeedWord(3);
    const a = parent.fork("lots", 12).next();
    const b = parent.fork("bld", 12).next();
    expect(a === b).toBe(false);
  });

  /**
   * The property the whole determinism scheme rests on: an entity's draws must
   * not depend on how many siblings were forked before it. If forking advanced
   * the parent, adding one building would reshuffle every later one.
   */
  it("should leave the parent sequence unchanged when a substream is forked", () => {
    const withoutFork = streamFromSeedWord(21);
    const expected = [withoutFork.next(), withoutFork.next()];

    const withFork = streamFromSeedWord(21);
    const first = withFork.next();
    withFork.fork("noise", 1).next();
    withFork.fork("noise", 2).next();
    expect([first, withFork.next()]).toEqual(expected);
  });
});

describe("masterSeed", () => {
  it("should derive two distinct lanes when given one seed string", () => {
    const master = masterSeed("akiba-01");
    expect(master.m0 === master.m1).toBe(false);
  });

  it("should derive the same lanes when given the same seed string", () => {
    expect(masterSeed("akiba-01")).toEqual(masterSeed("akiba-01"));
  });

  it("should derive different lanes when the seed string differs", () => {
    expect(masterSeed("akiba-01")).not.toEqual(masterSeed("akiba-02"));
  });
});

describe("stageStream", () => {
  it("should produce a different sequence when the stage label differs", () => {
    const master = masterSeed("akiba-01");
    const a = stageStream(master, "terrain").next();
    const b = stageStream(master, "hydrology").next();
    expect(a === b).toBe(false);
  });

  it("should produce the same sequence when the seed and stage match", () => {
    const master = masterSeed("akiba-01");
    const a = Array.from({ length: 4 }, () =>
      stageStream(master, "terrain").next()
    );
    const b = Array.from({ length: 4 }, () =>
      stageStream(master, "terrain").next()
    );
    expect(a).toEqual(b);
  });

  it("should produce a different sequence when the master seed differs", () => {
    const a = stageStream(masterSeed("akiba-01"), "terrain").next();
    const b = stageStream(masterSeed("akiba-02"), "terrain").next();
    expect(a === b).toBe(false);
  });
});
