/**
 * Hashing primitives for the generator.
 *
 * Every function here is exactly reproducible across engines: only integer
 * arithmetic, `Math.imul`, and bitwise operators are used. No transcendentals,
 * no `**`, no `BigInt` — the 64-bit hash is carried in two 32-bit lanes so the
 * result does not depend on `BigInt` availability or on double rounding.
 */

const FNV32_OFFSET = 2166136261;
const FNV32_PRIME = 16777619;

/** 2^32, used to split a double-precision product into two 32-bit lanes. */
const TWO_32 = 4294967296;

/** FNV-1a 64 prime 0x100000001b3, split into its two 32-bit lanes. */
const FNV64_PRIME_LO = 0x1b3;
const FNV64_PRIME_HI = 0x100;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** FNV-1a 32 over the UTF-8 bytes of `text`. Returns an unsigned 32-bit word. */
export const fnv1a32 = (text: string): number =>
  utf8(text).reduce(
    (hash, byte) => Math.imul(hash ^ byte, FNV32_PRIME) >>> 0,
    FNV32_OFFSET
  );

/** A 64-bit hash carried as two unsigned 32-bit lanes. */
export interface Hash64 {
  readonly hi: number;
  readonly lo: number;
}

const FNV64_OFFSET: Hash64 = { hi: 0xcbf29ce4, lo: 0x84222325 };

/**
 * One FNV-1a 64 step: xor the byte into the low lane, then multiply the pair by
 * the 64-bit prime.
 *
 * The products below stay under 2^53 (a 32-bit lane times 0x1b3 is at most
 * ~1.9e12), so every intermediate is exact in double precision and `>>> 0`
 * performs the modulo-2^32 truncation.
 */
const fnv1a64Step = (hash: Hash64, byte: number): Hash64 => {
  const lo = (hash.lo ^ byte) >>> 0;
  const productLo = lo * FNV64_PRIME_LO;
  const carry = Math.floor(productLo / TWO_32);
  return {
    lo: productLo >>> 0,
    hi: (hash.hi * FNV64_PRIME_LO + lo * FNV64_PRIME_HI + carry) >>> 0,
  };
};

const toHex8 = (word: number): string => word.toString(16).padStart(8, "0");

/** Hex rendering of a 64-bit hash, high lane first. */
export const hash64ToHex = (hash: Hash64): string =>
  `${toHex8(hash.hi)}${toHex8(hash.lo)}`;

/** FNV-1a 64 over a byte array. */
export const fnv1a64Bytes = (bytes: Uint8Array): Hash64 =>
  bytes.reduce<Hash64>(fnv1a64Step, FNV64_OFFSET);

/**
 * One splitmix32 step. Returns the advanced state and the mixed output, so the
 * caller threads state explicitly rather than relying on hidden mutation.
 */
export const splitmix32 = (state: number): { state: number; value: number } => {
  const next = (state + 0x9e3779b9) | 0;
  const a = Math.imul(next ^ (next >>> 16), 0x21f0aaad);
  const b = Math.imul(a ^ (a >>> 15), 0x735a2d97);
  return { state: next, value: (b ^ (b >>> 15)) >>> 0 };
};
