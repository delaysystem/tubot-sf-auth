import { expect, test } from "bun:test";
import { inferredContextSchema, repairPromptContext } from "./prompt-context";

test("typed fixture follows required paths and types returned by Salesforce", () => {
  const value: Record<string, unknown> = {};
  expect(repairPromptContext(value, "$.runtime: is missing but it is required; $.events: is missing but it is required")).toBe(true);
  expect(repairPromptContext(value, "$.runtime.startTimestamp: is missing but it is required; $.events: object found, array expected")).toBe(true);
  expect(value.events).toEqual([]);
  expect((value.runtime as Record<string, unknown>).startTimestamp).toMatch(/\+0000$/);
  expect(inferredContextSchema(value)).toMatchObject({ type: "object", properties: {
    runtime: { type: "object", properties: { startTimestamp: { type: "string" } } }, events: { type: "array" },
  } });
});

test("typed fixture removes rejected properties and refuses unsafe or unsupported constraints", () => {
  const value = { runtime: { extra: true } };
  expect(repairPromptContext(value, "You can't add the extra property defined at $.runtime.extra because the `additionalProperties` keyword value is set to false.")).toBe(true);
  expect(value.runtime).toEqual({});
  expect(repairPromptContext(value, "$.constructor.polluted: is missing but it is required")).toBe(false);
  expect(repairPromptContext(value, "$.arbitrary: does not match the regex pattern (a+)+$")).toBe(false);
});
