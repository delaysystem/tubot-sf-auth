import { describe, expect, test } from "bun:test";
import {
  JWT_BEARER_GRANT_TYPE,
  TUBOT_CHANNEL_API_CLIENT_ID,
  buildJwtAssertion,
  jwtAudience,
} from "./jwt";

describe("jwtAudience", () => {
  test("selects login vs test by environment", () => {
    expect(jwtAudience(false)).toBe("https://login.salesforce.com");
    expect(jwtAudience(true)).toBe("https://test.salesforce.com");
  });
});

describe("buildJwtAssertion", () => {
  test("rejects missing key and bad subjects without signing", async () => {
    await expect(buildJwtAssertion("", "u@example.com", false)).rejects.toThrow("jwt_private_key_misconfigured");
    await expect(buildJwtAssertion("not-a-key", "u@example.com", false)).rejects.toThrow("jwt_private_key_misconfigured");
  });

  test("builds a verifiable RS256 assertion", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const assertion = await buildJwtAssertion(privatePem, "integration@example.com", true, 1_700_000_000);
    const [headerB64, payloadB64, signatureB64] = assertion.split(".");
    expect([headerB64, payloadB64, signatureB64].every((part) => part.length > 0)).toBe(true);
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    expect(header).toEqual({ alg: "RS256" });
    expect(payload).toEqual({
      iss: TUBOT_CHANNEL_API_CLIENT_ID,
      sub: "integration@example.com",
      aud: "https://test.salesforce.com",
      exp: 1_700_000_180,
    });
    const { createVerify } = await import("node:crypto");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerB64}.${payloadB64}`);
    expect(verifier.verify(publicKey, Buffer.from(signatureB64, "base64url"))).toBe(true);
    expect(JWT_BEARER_GRANT_TYPE).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
  });
});
