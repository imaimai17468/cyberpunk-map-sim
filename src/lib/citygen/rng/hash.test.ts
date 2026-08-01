import { describe, expect, it } from "vitest";
import { fnv1a32, fnv1a64Bytes, hash64ToHex, splitmix32 } from "./hash";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The FNV-1a 32 recurrence over an explicit byte array, for the encoding test. */
const foldBytes = (input: readonly number[]): number =>
  input.reduce((h, b) => Math.imul(h ^ b, 16777619) >>> 0, 2166136261);

describe("fnv1a32", () => {
  // Published FNV-1a 32 vectors. These come from the FNV reference material,
  // not from this implementation, so they catch a self-consistent mistake.
  it.each([
    ["", 0x811c9dc5],
    ["a", 0xe40c292c],
    ["foobar", 0xbf9cf968],
  ])("should match the published vector when hashing %j", (input, expected) => {
    expect(fnv1a32(input)).toBe(expected);
  });

  /**
   * Checks the encoding step rather than the mixing step: "ä" is one code unit
   * but two UTF-8 bytes, so a implementation that hashed char codes would
   * disagree with this explicit byte fold. The recurrence is shared, so this
   * test says nothing about the constants — the published vectors above do.
   */
  it("should fold the UTF-8 bytes when the input is non-ASCII", () => {
    expect(fnv1a32("ä")).toBe(foldBytes([0xc3, 0xa4]));
  });

  it("should return an unsigned word when the mix would overflow to negative", () => {
    expect(fnv1a32("cyberpunk") >>> 0).toBe(fnv1a32("cyberpunk"));
  });
});

describe("fnv1a64", () => {
  // Published FNV-1a 64 vectors — the strongest available check that the
  // two-lane 32-bit multiply reproduces true 64-bit arithmetic.
  it.each([
    ["", "cbf29ce484222325"],
    ["a", "af63dc4c8601ec8c"],
    ["foobar", "85944171f73967e8"],
  ])(
    "should match the published 64-bit vector when hashing %j",
    (input, expected) => {
      expect(hash64ToHex(fnv1a64Bytes(bytes(input)))).toBe(expected);
    }
  );

  it("should produce a different digest when one byte changes", () => {
    const pair = [
      hash64ToHex(fnv1a64Bytes(bytes("akiba-01"))),
      hash64ToHex(fnv1a64Bytes(bytes("akiba-02"))),
    ];
    expect(pair[0] === pair[1]).toBe(false);
  });

  it("should pad each lane to eight hex digits when a lane has leading zeros", () => {
    expect(hash64ToHex({ hi: 0x1, lo: 0x2 })).toBe("0000000100000002");
  });
});

describe("splitmix32", () => {
  it("should return the same state and value when called twice with one input", () => {
    expect(splitmix32(12345)).toEqual(splitmix32(12345));
  });

  it("should advance the state by the golden-ratio constant when stepped", () => {
    expect(splitmix32(0).state).toBe((0 + 0x9e3779b9) | 0);
  });

  it("should return an unsigned value when the final mix sets the high bit", () => {
    expect(splitmix32(7).value >>> 0).toBe(splitmix32(7).value);
  });

  it("should diverge when the input states differ by one", () => {
    expect(splitmix32(1).value === splitmix32(2).value).toBe(false);
  });
});
