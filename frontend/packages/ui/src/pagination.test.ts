import { expect, it } from "vitest";
import { paginationItems } from "./pagination";

it("shows every page when the total is seven or less", () => {
  expect(paginationItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

it("keeps first, last and a compact window around the current page", () => {
  expect(paginationItems(1, 12)).toEqual([1, 2, 3, 4, 5, "ellipsis", 12]);
  expect(paginationItems(6, 12)).toEqual([1, "ellipsis", 5, 6, 7, "ellipsis", 12]);
  expect(paginationItems(12, 12)).toEqual([1, "ellipsis", 8, 9, 10, 11, 12]);
});
