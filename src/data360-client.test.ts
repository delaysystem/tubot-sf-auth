import { describe, expect, test } from "bun:test";
import { Data360AgentClient } from "./data360-client";

const KEY = "mesh-key-0123456789abcdef0123456789abcd";

function stubBinding(responder: (path: string) => { status: number; body: unknown }) {
  const seen: Array<{ path: string; headers: Record<string, string> }> = [];
  const binding = {
    seen,
    async fetch(input: string) {
      const url = new URL(input);
      return {
        status: 200,
        async json() {
          const found = responder(url.pathname + url.search);
          if (found.status !== 200) throw new Error("stub only serves 200 here");
          return found.body;
        },
      } as unknown as Response;
    },
  };
  // Capture headers by wrapping fetch.
  const inner = binding.fetch.bind(binding);
  binding.fetch = (async (input: string, init?: any) => {
    seen.push({ path: new URL(input).pathname + new URL(input).search, headers: init?.headers ?? {} });
    const out = await inner(input);
    const found = responder(new URL(input).pathname + new URL(input).search);
    (out as any).status = found.status;
    (out as any).ok = found.status >= 200 && found.status < 300;
    (out as any).json = async () => found.body;
    return out;
  }) as any;
  return binding;
}

describe("Data360AgentClient", () => {
  test("signs the route without the query string (verifier canonical form)", async () => {
    const { verifyServiceSignature } = await import("../../tubot-sf-data360/src/service-verify");
    const binding = stubBinding(() => ({ status: 200, body: { orgId: "o", agents: ["A"] } }));
    const client = new Data360AgentClient(binding as any, KEY);
    expect(await client.listAgents("00Dorg000000001")).toEqual(["A"]);
    const { headers } = binding.seen[0];
    const sig = { timestamp: headers["x-tubot-sig-timestamp"], nonce: headers["x-tubot-sig-nonce"], signature: headers["x-tubot-sig-signature"] };
    expect(await verifyServiceSignature([KEY], "GET", "/api/cache/agents", "", sig, Math.floor(Date.now() / 1000))).toBe(true);
  });

  test("returns null on 404 and throws typed errors otherwise", async () => {
    const missing = stubBinding(() => ({ status: 404, body: { error: "agent_not_cached" } }));
    expect(await new Data360AgentClient(missing as any, KEY).getAgent("o", "Nope")).toBeNull();
    const denied = stubBinding(() => ({ status: 401, body: {} }));
    await expect(new Data360AgentClient(denied as any, KEY).listAgents("o")).rejects.toThrow("data360_misconfigured");
    const down = stubBinding(() => ({ status: 503, body: {} }));
    await expect(new Data360AgentClient(down as any, KEY).listAgents("o")).rejects.toThrow("data360_unavailable");
    const badShape = stubBinding(() => ({ status: 200, body: { agents: "nope" } }));
    await expect(new Data360AgentClient(badShape as any, KEY).listAgents("o")).rejects.toThrow("data360_invalid_response");
  });
});
