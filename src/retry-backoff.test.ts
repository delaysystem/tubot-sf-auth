import { expect, test } from "bun:test";
import { backoffDelayMs } from "./retry-backoff";

test("backoff grows exponentially from the base and caps at twice the base", () => {
  const max = () => 0.999999;
  expect(backoffDelayMs(0, 2000, max)).toBeLessThanOrEqual(2000);
  expect(backoffDelayMs(0, 2000, max)).toBeGreaterThanOrEqual(1000);
  expect(backoffDelayMs(1, 2000, max)).toBeLessThanOrEqual(4000);
  expect(backoffDelayMs(1, 2000, max)).toBeGreaterThanOrEqual(2000);
  for (const attempt of [2, 5, 10, 100]) {
    expect(backoffDelayMs(attempt, 2000, max)).toBeLessThanOrEqual(4000);
  }
  const min = () => 0;
  expect(backoffDelayMs(0, 2000, min)).toBe(1000);
  expect(backoffDelayMs(9, 2000, min)).toBe(2000);
});

test("backoff never sleeps on a non-positive base and tolerates bad attempts", () => {
  expect(backoffDelayMs(0, 0)).toBe(0);
  expect(backoffDelayMs(3, 0)).toBe(0);
  expect(backoffDelayMs(0, -5)).toBe(0);
  expect(backoffDelayMs(-1, 2000, () => 0)).toBe(1000);
  expect(backoffDelayMs(NaN, 2000, () => 0)).toBe(1000);
});
