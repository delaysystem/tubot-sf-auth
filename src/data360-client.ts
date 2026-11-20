import { signServiceRequest } from "../../tubot-new-panel/worker/service-signer";
import { SecurityError } from "./request-security";

export interface Data360Binding { fetch(input: any, init?: any): Promise<Response> }
export interface Data360AgentDoc {
  agent: string; orgId: string; sha: string; files: Record<string, string>;
  snapshotId: string | null; updatedAt: string;
}

/** Typed client for data360's HMAC-gated cached-agent routes. 404s return null; all else throws. */
export class Data360AgentClient {
  constructor(private readonly binding: Data360Binding, private readonly internalKey: string) {}

  private async signedGet(path: string): Promise<Response> {
    // The verifier canonicalizes the route without the query string; sign the same.
    const headers = await signServiceRequest(this.internalKey, "GET", path.split("?")[0], "");
    let response: Response;
    try {
      response = await this.binding.fetch(`https://data360.internal${path}`, {
        method: "GET", headers, signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if ((error as Error)?.name === "TimeoutError") throw new SecurityError(503, "data360_unavailable");
      throw new SecurityError(503, "data360_unavailable");
    }
    return response;
  }

  async listAgents(orgId: string): Promise<string[] | null> {
    const response = await this.signedGet(`/api/cache/agents?orgId=${encodeURIComponent(orgId)}`);
    if (response.status === 404) return null;
    if (response.status === 401) throw new SecurityError(500, "data360_misconfigured");
    if (!response.ok) throw new SecurityError(503, "data360_unavailable");
    const body = await response.json() as { agents?: unknown };
    if (!Array.isArray(body.agents)) throw new SecurityError(502, "data360_invalid_response");
    return body.agents.filter((a): a is string => typeof a === "string");
  }

  async getAgent(orgId: string, agent: string): Promise<Data360AgentDoc | null> {
    const response = await this.signedGet(`/api/cache/agent?orgId=${encodeURIComponent(orgId)}&agent=${encodeURIComponent(agent)}`);
    if (response.status === 404) return null;
    if (response.status === 401) throw new SecurityError(500, "data360_misconfigured");
    if (!response.ok) throw new SecurityError(503, "data360_unavailable");
    const body = await response.json() as Partial<Data360AgentDoc>;
    if (typeof body.sha !== "string" || !/^[0-9a-f]{64}$/.test(body.sha) ||
      typeof body.files !== "object" || !body.files || Array.isArray(body.files)) {
      throw new SecurityError(502, "data360_invalid_response");
    }
    return body as Data360AgentDoc;
  }
}
