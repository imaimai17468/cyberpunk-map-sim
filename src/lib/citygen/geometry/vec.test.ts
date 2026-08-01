import { describe, expect, it } from "vitest";
import {
  add,
  blendLineTensors,
  comparePseudoAngle,
  cross,
  directionFromLineTensor,
  dot,
  length,
  lengthSq,
  lineTensorMagnitude,
  normalize,
  perp,
  pseudoAngle,
  randomUnitVector,
  scale,
  sub,
  toLineTensor,
} from "./vec";

describe("add", () => {
  it("should sum both components when given two vectors", () => {
    expect(add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
  });
});

describe("sub", () => {
  it("should subtract both components when given two vectors", () => {
    expect(sub({ x: 5, y: 7 }, { x: 2, y: 1 })).toEqual({ x: 3, y: 6 });
  });
});

describe("scale", () => {
  it("should scale both components when given a scalar", () => {
    expect(scale({ x: 2, y: -3 }, 5)).toEqual({ x: 10, y: -15 });
  });
});

describe("dot", () => {
  it("should compute the dot product when given two vectors", () => {
    expect(dot({ x: 1, y: 2 }, { x: 3, y: 4 })).toBe(11);
  });
});

describe("cross", () => {
  it("should compute the 2d cross product when given two vectors", () => {
    expect(cross({ x: 1, y: 0 }, { x: 0, y: 1 })).toBe(1);
  });
});

describe("lengthSq", () => {
  it("should sum the squared components when given a vector", () => {
    expect(lengthSq({ x: 3, y: 4 })).toBe(25);
  });
});

describe("length", () => {
  it("should return the exact length when given a 3-4-5 vector", () => {
    expect(length({ x: 3, y: 4 })).toBe(5);
  });
});

describe("perp", () => {
  it("should rotate the vector 90 degrees when given a nonzero vector", () => {
    expect(perp({ x: 3, y: 4 })).toEqual({ x: -4, y: 3 });
  });
});

describe("normalize", () => {
  it("should return a unit vector when the input is longer than the epsilon", () => {
    const unit = normalize({ x: 3, y: 4 });
    expect(unit).toSatisfy(
      (v: { x: number; y: number }) =>
        Math.abs(v.x - 0.6) < 1e-9 && Math.abs(v.y - 0.8) < 1e-9
    );
  });

  it("should return the fallback when the input is shorter than the epsilon", () => {
    expect(normalize({ x: 0, y: 0 }, { x: 1, y: 0 })).toEqual({ x: 1, y: 0 });
  });
});

describe("randomUnitVector", () => {
  it.each([
    [0.5, false, { x: 1, y: 0 }],
    [0, false, { x: 0, y: -1 }],
    [0.5, true, { x: -1, y: 0 }],
  ])(
    "should return the rational-parametrisation direction when u=%d and flip=%s",
    (u, flip, expected) => {
      const dir = randomUnitVector(u, flip);
      expect(dir).toSatisfy(
        (v: { x: number; y: number }) =>
          v.x === expected.x && v.y === expected.y
      );
    }
  );
});

describe("toLineTensor", () => {
  it("should return the double-angle components when given a 3-4-5 direction", () => {
    const tensor = toLineTensor({ x: 0.6, y: 0.8 });
    expect(tensor).toSatisfy(
      (t: { a: number; b: number }) =>
        Math.abs(t.a - -0.28) < 1e-9 && Math.abs(t.b - 0.96) < 1e-9
    );
  });
});

describe("blendLineTensors", () => {
  it("should return the weighted sum when given a known input pair", () => {
    const blended = blendLineTensors([
      { tensor: { a: 1, b: 0 }, weight: 2 },
      { tensor: { a: -1, b: 0 }, weight: 1 },
    ]);
    expect(blended).toEqual({ a: 1, b: 0 });
  });
});

describe("lineTensorMagnitude", () => {
  it("should return the exact magnitude when given a 3-4-5 tensor", () => {
    expect(lineTensorMagnitude({ a: 3, b: 4 })).toBe(5);
  });
});

describe("directionFromLineTensor", () => {
  it("should return a finite default direction when the tensor magnitude is near zero", () => {
    expect(directionFromLineTensor({ a: 0, b: 0 })).toEqual({ x: 1, y: 0 });
  });

  it("should return the vertical direction when cosTheta is near zero", () => {
    expect(directionFromLineTensor({ a: -1, b: 0 })).toEqual({ x: 0, y: 1 });
  });

  it("should recover the original 3-4-5 direction when the tensor came from a single vector", () => {
    const recovered = directionFromLineTensor(toLineTensor({ x: 0.6, y: 0.8 }));
    expect(recovered).toSatisfy(
      (v: { x: number; y: number }) =>
        Math.abs(v.x - 0.6) < 1e-9 && Math.abs(v.y - 0.8) < 1e-9
    );
  });
});

describe("pseudoAngle", () => {
  it.each([
    [{ x: 0, y: 0 }, 0],
    [{ x: 1, y: 1 }, 0.5],
    [{ x: -1, y: 1 }, 1.5],
    [{ x: -1, y: -1 }, 2.5],
    [{ x: 1, y: -1 }, 3.5],
  ])(
    "should return the monotonic pseudo-angle when given the vector %j",
    (v, expected) => {
      expect(pseudoAngle(v)).toBeCloseTo(expected);
    }
  );
});

describe("comparePseudoAngle", () => {
  it("should return a negative number when the first vector has a smaller pseudo-angle", () => {
    expect(comparePseudoAngle({ x: 1, y: 0 }, { x: 0, y: 1 })).toBeLessThan(0);
  });
});
