import { describe, expect, it } from "bun:test";
import {
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
