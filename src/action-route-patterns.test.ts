import { expect, test } from "bun:test";
import { ACTION_NAME, STANDARD_ROUTE } from "./action-route-patterns";

test("shared action name pattern matches platform names only", () => {
  expect(ACTION_NAME.test("createCart")).toBe(true);
  expect(ACTION_NAME.test("a".repeat(128))).toBe(true);
  expect(ACTION_NAME.test("")).toBe(false);
  expect(ACTION_NAME.test("9lives")).toBe(false);
  expect(ACTION_NAME.test("a".repeat(129))).toBe(false);
  expect(ACTION_NAME.test("with.dot")).toBe(false);
});

test("shared standard route pattern captures version and action", () => {
  const match = "/services/data/v67.0/actions/standard/createCart".match(STANDARD_ROUTE);
  expect(match?.[1]).toBe("v67.0");
  expect(match?.[2]).toBe("createCart");
  expect("/services/data/v67.0/actions/custom/flow/x".match(STANDARD_ROUTE)).toBeNull();
});
