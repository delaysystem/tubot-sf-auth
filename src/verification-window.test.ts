import { expect, test } from "bun:test";
import { clampVerificationWindowMs, isVerificationWindowMs } from "./verification-window";

test("verification window validation admits only integers 0..15000", () => {
  expect(isVerificationWindowMs(0)).toBe(true);
  expect(isVerificationWindowMs(15000)).toBe(true);
  expect(isVerificationWindowMs(1500)).toBe(true);
  for (const bad of [-1, 15001, 1.5, NaN, Infinity, -Infinity, undefined, null, "1500", {}, []]) {
    expect(isVerificationWindowMs(bad)).toBe(false);
  }
});

test("verification window clamp is identity on valid inputs and bounded otherwise", () => {
  expect(clampVerificationWindowMs(0)).toBe(0);
  expect(clampVerificationWindowMs(15000)).toBe(15000);
  expect(clampVerificationWindowMs(1500)).toBe(1500);
  expect(clampVerificationWindowMs(15001)).toBe(15000);
  expect(clampVerificationWindowMs(1e12)).toBe(15000);
  expect(clampVerificationWindowMs(-5)).toBe(0);
  expect(clampVerificationWindowMs(1.9)).toBe(1);
  for (const skip of [NaN, Infinity, -Infinity, undefined, null, "1500"]) {
    expect(clampVerificationWindowMs(skip)).toBe(0);
  }
});
