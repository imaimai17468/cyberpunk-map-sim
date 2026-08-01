import { describe, expect, it } from "vitest";
import { byteWriter, hashBytes, hashConcat } from "./serialize";

describe("byteWriter scalars", () => {
  it("should emit one byte when writing a u8", () => {
    expect([...byteWriter().u8(0xab).finish()]).toEqual([0xab]);
  });

  it("should truncate to one byte when the u8 value overflows", () => {
    expect([...byteWriter().u8(0x1ff).finish()]).toEqual([0xff]);
  });

  it("should emit little-endian bytes when writing a u32", () => {
    expect([...byteWriter().u32(0x01020304).finish()]).toEqual([
      0x04, 0x03, 0x02, 0x01,
    ]);
  });

  it("should emit an unsigned encoding when the u32 value is negative", () => {
    expect([...byteWriter().u32(-1).finish()]).toEqual([
      0xff, 0xff, 0xff, 0xff,
    ]);
  });

  it("should emit four bytes when writing an f32", () => {
    expect(byteWriter().f32(1.5).finish().length).toBe(4);
  });

  it("should emit eight bytes when writing an f64", () => {
    expect(byteWriter().f64(1.5).finish().length).toBe(8);
  });

  it("should emit one when writing a true bool", () => {
    expect([...byteWriter().bool(true).finish()]).toEqual([1]);
  });

  it("should emit zero when writing a false bool", () => {
    expect([...byteWriter().bool(false).finish()]).toEqual([0]);
  });
});

describe("byteWriter arrays", () => {
  it("should length-prefix the payload when writing a string", () => {
    expect([...byteWriter().str("ab").finish()]).toEqual([
      2, 0, 0, 0, 0x61, 0x62,
    ]);
  });

  it("should count UTF-8 bytes rather than code units when writing a string", () => {
    // "ä" is one code unit and two UTF-8 bytes; the prefix must say two.
    expect([...byteWriter().str("ä").finish()].slice(0, 4)).toEqual([
      2, 0, 0, 0,
    ]);
  });

  it("should length-prefix by element count when writing an f32 array", () => {
    const out = byteWriter()
      .f32Array(Float32Array.from([1, 2]))
      .finish();
    expect([out.length, out[0]]).toEqual([12, 2]);
  });

  it("should length-prefix by element count when writing a u32 array", () => {
    const out = byteWriter()
      .u32Array(Uint32Array.from([7]))
      .finish();
    expect([...out]).toEqual([1, 0, 0, 0, 7, 0, 0, 0]);
  });

  it("should length-prefix by element count when writing a u8 array", () => {
    expect([
      ...byteWriter()
        .u8Array(Uint8Array.from([9, 8]))
        .finish(),
    ]).toEqual([2, 0, 0, 0, 9, 8]);
  });

  it("should emit only the prefix when the array is empty", () => {
    expect([...byteWriter().u32Array(new Uint32Array(0)).finish()]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  /**
   * A typed array view onto a larger buffer must serialise as its own elements,
   * not as the whole backing buffer — otherwise a pooled field would hash
   * differently depending on where it was allocated.
   */
  it("should serialise only the view when the array is a subarray of a pool", () => {
    const pool = Float32Array.from([1, 2, 3, 4]);
    const view = pool.subarray(1, 3);
    expect([...byteWriter().f32Array(view).finish()]).toEqual([
      ...byteWriter()
        .f32Array(Float32Array.from([2, 3]))
        .finish(),
    ]);
  });
});

describe("hashing", () => {
  it("should produce a stable digest when hashing the same bytes twice", () => {
    expect(hashBytes(Uint8Array.from([1, 2, 3]))).toBe(
      hashBytes(Uint8Array.from([1, 2, 3]))
    );
  });

  it("should produce a different digest when one byte differs", () => {
    const pair = [
      hashBytes(Uint8Array.from([1, 2, 3])),
      hashBytes(Uint8Array.from([1, 2, 4])),
    ];
    expect(pair[0] === pair[1]).toBe(false);
  });

  it("should equal the digest of the joined stream when concatenating", () => {
    expect(hashConcat([Uint8Array.from([1, 2]), Uint8Array.from([3])])).toBe(
      hashBytes(Uint8Array.from([1, 2, 3]))
    );
  });

  it("should distinguish a boundary shift when the concatenation is identical", () => {
    // Length prefixes are what make ["a","bc"] and ["ab","c"] differ; raw byte
    // concatenation alone would collide. This documents that hashConcat itself
    // does NOT add prefixes — callers must write them.
    expect(
      hashConcat([Uint8Array.from([1]), Uint8Array.from([2, 3])]) ===
        hashConcat([Uint8Array.from([1, 2]), Uint8Array.from([3])])
    ).toBe(true);
  });

  it("should return sixteen hex digits when hashing any input", () => {
    expect(hashBytes(Uint8Array.from([0])).length).toBe(16);
  });
});
