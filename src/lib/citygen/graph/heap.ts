/**
 * Binary min-heap over lexicographic total-order keys.
 *
 * Every key is a fixed-shape tuple of numbers whose final element is a
 * unique integer (a cell index or entity id per design §5/§12). Comparing
 * keys lexicographically and ending every key in a unique integer means two
 * entries that tie on every leading component still resolve to one, fixed
 * winner — never the incidental order they were pushed in. That is the
 * determinism guarantee every priority-queue algorithm in the generator
 * (Dijkstra, priority-flood) relies on this module for.
 *
 * Sift-up/sift-down are implemented recursively; recursion depth is
 * `~log2(size)` (at most ~20 for the generator's largest grids), which is
 * negligible against the engine's measured ~9,765-frame recursion limit.
 */

export type HeapKey = readonly number[];

export interface HeapEntry<T> {
  readonly key: HeapKey;
  readonly value: T;
}

const compareFrom = (a: HeapKey, b: HeapKey, index: number): number => {
  if (index >= a.length) return 0;
  const diff = a[index] - b[index];
  return diff !== 0 ? diff : compareFrom(a, b, index + 1);
};

/**
 * Lexicographic comparison of two heap keys: negative when `a` sorts before
 * `b`, positive when after, zero when identical. Assumes both keys share the
 * same shape, which every caller in this generator guarantees per stage.
 */
export const compareHeapKeys = (a: HeapKey, b: HeapKey): number =>
  compareFrom(a, b, 0);

/**
 * A binary min-heap backed by a single owned array. Methods mutate that
 * array in place (`no-param-reassign` forbids rebinding parameters, not
 * mutating an accumulator/buffer the class itself allocated).
 */
export class MinHeap<T> {
  private readonly items: Array<HeapEntry<T>> = [];

  get size(): number {
    return this.items.length;
  }

  peek(): HeapEntry<T> | undefined {
    return this.items.length > 0 ? this.items[0] : undefined;
  }

  push(entry: HeapEntry<T>): void {
    this.items.push(entry);
    this.siftUp(this.items.length - 1);
  }

  pop(): HeapEntry<T> | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop();
    if (last !== undefined && this.items.length > 0) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(index: number): void {
    if (index === 0) return;
    const parentIndex = (index - 1) >> 1;
    if (
      compareHeapKeys(this.items[index].key, this.items[parentIndex].key) >= 0
    ) {
      return;
    }
    this.swap(index, parentIndex);
    this.siftUp(parentIndex);
  }

  private siftDown(index: number): void {
    const smallest = this.smallestChildIndex(index);
    if (smallest === index) return;
    this.swap(index, smallest);
    this.siftDown(smallest);
  }

  private smallestChildIndex(index: number): number {
    const length = this.items.length;
    const left = index * 2 + 1;
    const right = index * 2 + 2;
    const withLeft =
      left < length &&
      compareHeapKeys(this.items[left].key, this.items[index].key) < 0
        ? left
        : index;
    return right < length &&
      compareHeapKeys(this.items[right].key, this.items[withLeft].key) < 0
      ? right
      : withLeft;
  }

  private swap(i: number, j: number): void {
    const temp = this.items[i];
    this.items[i] = this.items[j];
    this.items[j] = temp;
  }
}
