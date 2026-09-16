import { expect, it } from "vitest";
import { differs } from "./web.js";

it("compares scaffold objects by values, not key insertion order", () => {
  expect(differs("deps", { a: "1", b: "2" }, { b: "2", a: "1" })).toEqual([]);
  expect(differs("deps", { a: "1" }, { a: "2" })).toHaveLength(1);
  expect(differs("deps", { a: "1" }, { a: "1", b: "2" })).toHaveLength(1);
  expect(differs("array", ["a", "b"], ["b", "a"])).toHaveLength(1);
});
