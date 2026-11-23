import { expect, test } from "bun:test";
import { isRecord } from "./record-guard";

test("shared record guard accepts only non-null non-array objects", () => {
  expect(isRecord({})).toBe(true);
  expect(isRecord({ a: 1 })).toBe(true);
  for (const bad of [null, undefined, [], [1], "x", 1, true]) {
    expect(isRecord(bad)).toBe(false);
  }
});
