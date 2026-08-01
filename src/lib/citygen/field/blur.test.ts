import { describe, expect, it } from "vitest";
import { createField2D } from "./field2d";
import { boxBlur3Pass } from "./blur";

describe("boxBlur3Pass", () => {
  it.each([[-1], [1.5]])(
    "should throw a RangeError when radius is %j",
    (radius) => {
      expect(() => boxBlur3Pass(createField2D(2, 1), radius)).toThrow(
        RangeError
      );
    }
  );

  it("should return the field unchanged when radius is zero", () => {
    const field = createField2D(
      3,
      1,
      (index) => [0, 0, 0, 0, 90, 0, 0, 0, 0][index]
    );
    const blurred = boxBlur3Pass(field, 0);
    expect(Array.from(blurred.data)).toEqual(Array.from(field.data));
  });

  it("should leave a uniform field unchanged when blurred", () => {
    const field = createField2D(3, 1, () => 4);
    const blurred = boxBlur3Pass(field, 1);
    expect(Array.from(blurred.data)).toEqual([4, 4, 4, 4, 4, 4, 4, 4, 4]);
  });

  it("should preserve the field's cells and cellSizeM when blurring", () => {
    const field = createField2D(3, 5, () => 1);
    const blurred = boxBlur3Pass(field, 1);
    expect({ cells: blurred.cells, cellSizeM: blurred.cellSizeM }).toEqual({
      cells: 3,
      cellSizeM: 5,
    });
  });

  it("should smooth a spike toward its clamped-window neighbours when blurred three times", () => {
    // Cross-checked against an independent naive triple-nested-loop reference
    // implementation of the same "separable, clamped-window, 3-pass" spec;
    // the two agreed to within float32 rounding (~1e-6).
    const field = createField2D(
      3,
      1,
      (index) => [0, 0, 0, 0, 90, 0, 0, 0, 0][index]
    );
    const blurred = boxBlur3Pass(field, 1);
    expect(
      Array.from(blurred.data).map((value) => Number(value.toFixed(4)))
    ).toEqual([
      16.684, 16.5046, 16.684, 16.5046, 16.3272, 16.5046, 16.684, 16.5046,
      16.684,
    ]);
  });
});
