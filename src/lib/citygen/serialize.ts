import { fnv1a64Bytes, hash64ToHex } from "./rng/hash";

/**
 * Canonical byte serialisation, the basis of every content hash.
 *
 * The hashes are the actual proof of determinism (design §5), so this writer has
 * to be canonical in the strict sense: fixed field order, explicit
 * little-endian, length-prefixed arrays, and no textual float formatting. A
 * `toFixed` anywhere here would make the hash depend on locale-independent but
 * precision-losing rounding, which is why floats are written as raw IEEE bytes.
 */

/** A growable byte sink. The buffer is owned, so writing into it is local. */
export interface ByteWriter {
  u8(value: number): ByteWriter;
  u32(value: number): ByteWriter;
  f32(value: number): ByteWriter;
  f64(value: number): ByteWriter;
  bool(value: boolean): ByteWriter;
  /** Length-prefixed UTF-8. */
  str(value: string): ByteWriter;
  /** Length-prefixed. */
  f32Array(values: Float32Array): ByteWriter;
  u32Array(values: Uint32Array): ByteWriter;
  u8Array(values: Uint8Array): ByteWriter;
  finish(): Uint8Array;
}

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  chunks.reduce((offset, chunk) => {
    out.set(chunk, offset);
    return offset + chunk.length;
  }, 0);
  return out;
};

const scalarBytes = (
  size: number,
  write: (view: DataView) => void
): Uint8Array => {
  const buffer = new ArrayBuffer(size);
  write(new DataView(buffer));
  return new Uint8Array(buffer);
};

/**
 * Reinterprets a typed array's bytes. `slice()` copies, so the result is
 * independent of the source buffer and of any offset it carried.
 */
const rawBytes = (values: ArrayBufferView): Uint8Array =>
  new Uint8Array(
    values.buffer.slice(
      values.byteOffset,
      values.byteOffset + values.byteLength
    )
  );

export const byteWriter = (): ByteWriter => {
  const chunks: Uint8Array[] = [];

  const push = (chunk: Uint8Array): ByteWriter => {
    chunks.push(chunk);
    return writer;
  };

  const u32 = (value: number): ByteWriter =>
    push(scalarBytes(4, (v) => v.setUint32(0, value >>> 0, true)));

  const writer: ByteWriter = {
    u8: (value) => push(Uint8Array.from([value & 0xff])),
    u32,
    f32: (value) => push(scalarBytes(4, (v) => v.setFloat32(0, value, true))),
    f64: (value) => push(scalarBytes(8, (v) => v.setFloat64(0, value, true))),
    bool: (value) => push(Uint8Array.from([value ? 1 : 0])),
    str: (value) => {
      const encoded = new TextEncoder().encode(value);
      u32(encoded.length);
      return push(encoded);
    },
    f32Array: (values) => {
      u32(values.length);
      return push(rawBytes(values));
    },
    u32Array: (values) => {
      u32(values.length);
      return push(rawBytes(values));
    },
    u8Array: (values) => {
      u32(values.length);
      return push(rawBytes(values));
    },
    finish: () => concat(chunks),
  };

  return writer;
};

/** FNV-1a 64 of a canonical byte stream, as hex. */
export const hashBytes = (bytes: Uint8Array): string =>
  hash64ToHex(fnv1a64Bytes(bytes));

/** Hash of the concatenation of already-computed stage byte streams. */
export const hashConcat = (streams: readonly Uint8Array[]): string =>
  hashBytes(concat(streams));
