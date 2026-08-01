import { describe, expect, it } from "vitest";
import { compareHeapKeys, MinHeap } from "./heap";

describe("compareHeapKeys", () => {
  it("should return zero when two keys are identical", () => {
    expect(compareHeapKeys([5, 2], [5, 2])).toBe(0);
  });

  it("should return a negative number when the first component of a is smaller", () => {
    expect(compareHeapKeys([1, 9], [2, 0])).toBeLessThan(0);
  });

  it("should return a positive number when the leading components tie but a's tie-break integer is larger", () => {
    expect(compareHeapKeys([5, 10], [5, 3])).toBeGreaterThan(0);
  });
});

describe("MinHeap", () => {
  it("should return undefined when popping an empty heap", () => {
    const heap = new MinHeap<string>();
    expect(heap.pop()).toBeUndefined();
  });

  it("should return undefined when peeking an empty heap", () => {
    const heap = new MinHeap<string>();
    expect(heap.peek()).toBeUndefined();
  });

  it("should report zero size when no entries have been pushed", () => {
    const heap = new MinHeap<string>();
    expect(heap.size).toBe(0);
  });

  it("should pop entries in ascending primary-key order when the keys differ", () => {
    const heap = new MinHeap<string>();
    heap.push({ key: [30, 1], value: "high" });
    heap.push({ key: [10, 2], value: "low" });
    heap.push({ key: [20, 3], value: "mid" });
    const popped = [heap.pop()?.value, heap.pop()?.value, heap.pop()?.value];
    expect(popped).toEqual(["low", "mid", "high"]);
  });

  it("should pop the entry with the smaller tie-break integer first when the primary keys are equal", () => {
    const heap = new MinHeap<string>();
    heap.push({ key: [5, 10], value: "later" });
    heap.push({ key: [5, 3], value: "earlier" });
    const popped = [heap.pop()?.value, heap.pop()?.value];
    expect(popped).toEqual(["earlier", "later"]);
  });

  it("should restore heap order across many interleaved pushes when popped sequentially", () => {
    const heap = new MinHeap<number>();
    [7, 3, 9, 1, 5, 8, 2, 6, 4, 0].forEach((n) =>
      heap.push({ key: [n, n], value: n })
    );
    const popped = Array.from({ length: 10 }, () => heap.pop()?.value);
    expect(popped).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("should report the decremented size when an entry has been popped", () => {
    const heap = new MinHeap<number>();
    heap.push({ key: [1, 1], value: 1 });
    heap.push({ key: [2, 2], value: 2 });
    heap.pop();
    expect(heap.size).toBe(1);
  });
});
