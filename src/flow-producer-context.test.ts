import { describe, expect, it } from "bun:test";
import {
  eventSlotCompletion,
  personIdentityCompletion,
  verificationProducerInput,
} from "./flow-producer-context";

describe("verificationProducerInput", () => {
  const outputs = [
    { name: "verificationCode" },
    { name: "authenticationKey" },
    { name: "customerId" },
    { name: "customerType" },
    { name: "verificationMessage" },
  ];
  it("detects the live producer shape", () => {
    expect(
      verificationProducerInput(
        [{ name: "customerToVerify", type: "STRING", maxOccurs: 1 }],
        outputs,
      ),
    ).toBe("customerToVerify");
  });
  it("rejects record inputs, collections, extra inputs, and partial outputs", () => {
    expect(
      verificationProducerInput(
        [{ name: "contactRecord", type: "SOBJECT", sObjectType: "Contact" }],
        [{ name: "outcomeMessage" }],
      ),
    ).toBeNull();
    expect(
      verificationProducerInput(
        [{ name: "customerToVerify", type: "STRING", maxOccurs: 2000 }],
        outputs,
      ),
    ).toBeNull();
    expect(
      verificationProducerInput(
        [
          { name: "customerToVerify", type: "STRING" },
          { name: "other", type: "STRING" },
        ],
        outputs,
      ),
    ).toBeNull();
    expect(
      verificationProducerInput(
        [{ name: "customerToVerify", type: "STRING" }],
        [{ name: "verificationCode" }],
      ),
    ).toBeNull();
    expect(verificationProducerInput(null, outputs)).toBeNull();
    expect(verificationProducerInput([{ name: "x", type: "STRING" }], null)).toBeNull();
  });
});

describe("personIdentityCompletion", () => {
  const fields = [
    { name: "LastName", type: "string", createable: true },
    { name: "Email", type: "email", createable: true },
  ];
  it("adds an undeliverable Email when the live field is createable and empty", () => {
    const completed = personIdentityCompletion(fields, { LastName: "Probe" });
    expect(typeof completed.Email).toBe("string");
    expect(String(completed.Email)).toMatch(/^flow-probe-[^@]+@example\.invalid$/);
    expect(completed.LastName).toBe("Probe");
  });
  it("never overwrites a supplied Email or invents one without a live field", () => {
    expect(
      personIdentityCompletion(fields, { Email: "owned@example.com" }),
    ).toEqual({ Email: "owned@example.com" });
    expect(
      personIdentityCompletion(
        [{ name: "LastName", type: "string", createable: true }],
        { LastName: "Probe" },
      ),
    ).toEqual({ LastName: "Probe" });
    expect(
      personIdentityCompletion(
        [{ name: "Email", type: "email", createable: false }],
        { LastName: "Probe" },
      ),
    ).toEqual({ LastName: "Probe" });
  });
});

describe("eventSlotCompletion", () => {
  const fields = [
    { name: "Subject", type: "string", createable: true },
    { name: "ActivityDateTime", type: "datetime", createable: true },
    { name: "DurationInMinutes", type: "int", createable: true },
  ];
  it("stamps a forward slot on Event fixtures missing it", () => {
    const completed = eventSlotCompletion("Event", fields, { Subject: "Probe" });
    expect(completed.DurationInMinutes).toBe(60);
    expect(Date.parse(completed.ActivityDateTime as string)).toBeGreaterThan(Date.now());
    expect(completed.Subject).toBe("Probe");
  });
  it("never touches non-Event objects, supplied slots, or undescribed fields", () => {
    expect(eventSlotCompletion("Task", fields, { Subject: "Probe" })).toEqual({ Subject: "Probe" });
    expect(eventSlotCompletion("Event", fields,
      { Subject: "Probe", ActivityDateTime: "2026-03-01T10:00:00.000Z", DurationInMinutes: 30 }))
      .toEqual({ Subject: "Probe", ActivityDateTime: "2026-03-01T10:00:00.000Z", DurationInMinutes: 30 });
    expect(eventSlotCompletion("Event",
      [{ name: "Subject", type: "string", createable: true }], { Subject: "Probe" }))
      .toEqual({ Subject: "Probe" });
  });
});
