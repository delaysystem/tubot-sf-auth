import { describe, expect, test } from "bun:test";
import { buildMetadata, parseArgs } from "./setup-salesforce-eca.mjs";

describe("Salesforce ECA bootstrap metadata", () => {
  test("builds a local client-credentials ECA with REST secret access enabled", () => {
    const files = buildMetadata({
      appName: "Tubot_SF_Channel_API",
      integrationUser: "api.user@example.com",
      contactEmail: "admin@example.com",
    });
    const allMetadata = [...files.values()].join("\n");

    expect(files.size).toBe(5);
    expect(allMetadata).toContain("<enableClientSecretInRestApiAccess>true</enableClientSecretInRestApiAccess>");
    expect(allMetadata).toContain("<distributionState>Local</distributionState>");
    expect(allMetadata).toContain("<commaSeparatedOauthScopes>Api, OpenID</commaSeparatedOauthScopes>");
    expect(allMetadata).toContain("<isClientCredentialsFlowEnabled>true</isClientCredentialsFlowEnabled>");
    expect(allMetadata).toContain("<clientCredentialsFlowUser>api.user@example.com</clientCredentialsFlowUser>");
    expect(allMetadata).toContain("<callbackUrl>https://tubot-new-panel.emalteaproductions.workers.dev/oauth/callback</callbackUrl>");
    expect(allMetadata).not.toContain("consumerSecret");
  });

  test("escapes user input in XML metadata", () => {
    const files = buildMetadata({ appName: "Tubot_Channel", integrationUser: "api&user@example.com", contactEmail: "admin@example.com" });
    const policy = files.get("extlClntAppOauthPolicies/Tubot_Channel_OAuth_Policies.ecaOauthPlcy-meta.xml");
    expect(policy).toContain("api&amp;user@example.com");
  });

  test("requires Salesforce org and admin setup inputs", () => {
    expect(() => parseArgs([])).toThrow("--target-org");
    expect(() => parseArgs(["--target-org", "sandbox", "--integration-user", "api@example.com", "--contact-email", "invalid"])).toThrow("valid email");
    expect(() => parseArgs(["--target-org", "sandbox", "--integration-user", "api@example.com", "--contact-email", "admin@example.com", "--app-name", "bad__name"])).toThrow("Salesforce API name");
  });

  test("parses automated connect and verify flags", () => {
    const options = parseArgs([
      "--target-org", "sandbox",
      "--integration-user", "api@example.com",
      "--contact-email", "admin@example.com",
      "--channel-id", "0Mjg5000000UvVVCA0",
      "--connect",
      "--verify",
    ]);
    expect(options.connect).toBe(true);
    expect(options.verify).toBe(true);
    expect(options.channelId).toBe("0Mjg5000000UvVVCA0");
  });
});
