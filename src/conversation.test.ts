import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker, {
  TubotSfAuthEntrypoint,
  type AuthEnv,
  type Credential,
  type UserConversationHistory,
} from "./index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const secret = "a".repeat(48);
const orgId = "00D000000000001AAA";
const userId = "003000000000001AAA";
const channelId = "0Mjg00000000001AAA";
const scope={teamId:"team-test",orgId,channelId,channelSecret:secret};
function scopedRequest(input:any,init:RequestInit={}) {
 const headers=new Headers(init.headers);for(const [k,v] of Object.entries({"x-team-id":scope.teamId,"x-org-id":scope.orgId,"x-channel-id":channelId,"x-channel-secret":secret}))headers.set(k,v);
 return new Request(input,{...init,headers});
}
const enc = new TextEncoder();
const keyBytes = new Uint8Array(32).fill(7);
const encryptionKey = btoa(String.fromCharCode(...keyBytes));
const hash = async (s: string) =>
  btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function createTestEnv() {
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, enc.encode("salesforce-secret"))
  );
  const row: Credential = {
    team_id: "team-test",
    org_id: orgId,
    channel_id: channelId,
    instance_url: "https://test.my.salesforce.com",
    client_id: "client-id",
    client_secret_cipher: btoa(String.fromCharCode(...cipher)),
    client_secret_iv: btoa(String.fromCharCode(...iv)),
    integration_user_id: "005000000000001AAA",
    channel_secret_hash: await hash(secret),
  };

  const db = {
    prepare(sql: string) {
      let bound: any[] = [];
      return {
        bind(...args: any[]) {
          bound = args;
          return this;
        },
        async first() {
          if (sql.includes("salesforce_auth_credential")) {
            return row;
          }
          if (sql.includes("salesforce_channel_connection")) {
            return { secret_hash: row.channel_secret_hash };
          }
          return null;
        },
        async run() {
          return { success: true };
        },
      };
    },
  } as unknown as D1Database;

  const env: AuthEnv = {
    DB: db,
    SF_CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
  };

  return { env, row };
}

describe("tubot-sf-auth: User Conversation Data Extraction", () => {
  test("queries and groups conversation entries across current and previous sessions", async () => {
    const { env, row } = await createTestEnv();

    const mockSessions = [
      {
        Id: "0Mw000000000002AAA",
        ConversationId: "0Mw000000000002AAA",
        ChannelName: "WhatsApp_Support",
        ChannelType: "WhatsApp",
        Status: "Active",
        StartTime: "2026-09-26T14:00:00.000Z",
        EndTime: null,
        MessagingEndUserId: userId,
        ContactId: userId,
        CreatedDate: "2026-09-26T14:00:00.000Z",
      },
      {
        Id: "0Mw000000000001AAA",
        ConversationId: "0Mw000000000001AAA",
        ChannelName: "Web_Chat",
        ChannelType: "Web",
        Status: "Ended",
        StartTime: "2026-09-25T10:00:00.000Z",
        EndTime: "2026-09-25T10:30:00.000Z",
        MessagingEndUserId: userId,
        ContactId: userId,
        CreatedDate: "2026-09-25T10:00:00.000Z",
      },
    ];

    const mockEntries = [
      // Session 1 entries (previous session)
      {
        Id: "0Me000000000001AAA",
        ConversationId: "0Mw000000000001AAA",
        EntryType: "Message",
        MessageText: "Hi, I have a question about my invoice.",
        ActorType: "EndUser",
        ActorName: "Alice Customer",
        CreatedDate: "2026-09-25T10:01:00.000Z",
      },
      {
        Id: "0Me000000000002AAA",
        ConversationId: "0Mw000000000001AAA",
        EntryType: "Message",
        MessageText: "Hello Alice! I can help you with your invoice.",
        ActorType: "Agent",
        ActorName: "Support Rep Bob",
        CreatedDate: "2026-09-25T10:02:00.000Z",
      },
      // Session 2 entries (current session)
      {
        Id: "0Me000000000003AAA",
        ConversationId: "0Mw000000000002AAA",
        EntryType: "Message",
        MessageText: "I am following up on the payment link you sent.",
        ActorType: "EndUser",
        ActorName: "Alice Customer",
        CreatedDate: "2026-09-26T14:01:00.000Z",
      },
      {
        Id: "0Me000000000004AAA",
        ConversationId: "0Mw000000000002AAA",
        EntryType: "Message",
        MessageText: "Here is your updated payment confirmation: #PAY-992.",
        ActorType: "Bot",
        ActorName: "Agentforce Invoicing Bot",
        CreatedDate: "2026-09-26T14:01:30.000Z",
      },
    ];

    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      // OAuth Token endpoint
      if (url.includes("/services/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "test-token", instance_url: "https://test.my.salesforce.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Userinfo endpoint
      if (url.includes("/services/oauth2/userinfo")) {
        return new Response(JSON.stringify({
          organization_id: orgId,
          user_id: row.integration_user_id,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // SOQL query
      if (url.includes("/services/data/v65.0/query")) {
        const decoded = decodeURIComponent(url);
        if (decoded.includes("FROM MessagingSession")) {
          return new Response(JSON.stringify({ totalSize: 2, done: true, records: mockSessions }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (decoded.includes("FROM ConversationEntry")) {
          return new Response(JSON.stringify({ totalSize: 4, done: true, records: mockEntries }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return new Response("Not found", { status: 404 });
    };

    const entrypoint = new TubotSfAuthEntrypoint({ waitUntil: () => {} }, env);
    const result: UserConversationHistory = await entrypoint.getUserConversationHistory(userId, {
      ...scope,
      channelId,
      currentSessionId: "0Mw000000000002AAA",
    });

    expect(result.userId).toBe(userId);
    expect(result.totalSessions).toBe(2);
    expect(result.totalMessages).toBe(4);
    expect(result.sessions.length).toBe(2);

    // Verify current session
    const currentSession = result.sessions.find((s) => s.sessionId === "0Mw000000000002AAA")!;
    expect(currentSession).toBeDefined();
    expect(currentSession.status).toBe("Active");
    expect(currentSession.messages.length).toBe(2);
    expect(currentSession.messages[0].senderType).toBe("user");
    expect(currentSession.messages[0].message).toBe("I am following up on the payment link you sent.");
    expect(currentSession.messages[1].senderType).toBe("bot");
    expect(currentSession.metadata?.isCurrentSession).toBe(true);

    // Verify previous session
    const prevSession = result.sessions.find((s) => s.sessionId === "0Mw000000000001AAA")!;
    expect(prevSession).toBeDefined();
    expect(prevSession.status).toBe("Ended");
    expect(prevSession.messages.length).toBe(2);
    expect(prevSession.messages[0].senderType).toBe("user");
    expect(prevSession.messages[1].senderType).toBe("agent");
    expect(prevSession.metadata?.isCurrentSession).toBe(false);
  });

  test("handles POST /internal/channels/user/conversations route", async () => {
    const { env } = await createTestEnv();

    globalThis.fetch = async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/services/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "test-token", instance_url: "https://test.my.salesforce.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/services/oauth2/userinfo")) {
        return new Response(JSON.stringify({
          organization_id: orgId,
          user_id: "005000000000001AAA",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/services/data/v65.0/query")) {
        return new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const req = scopedRequest("https://tubot-sf-auth.internal/internal/channels/user/conversations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer salesforce-secret",
        "x-channel-id": channelId,
        "x-team-id": "team-test",
        "x-org-id": orgId,
      },
      body: JSON.stringify({
        userId,
        currentSessionId: "0MwCurrentSession",
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");

    const data = await res.json();
    expect(data.userId).toBe(userId);
    expect(data.totalSessions).toBe(0);
    expect(data.totalMessages).toBe(0);
    expect(Array.isArray(data.sessions)).toBe(true);
  });

  test("returns 400 when userId is missing in conversation request", async () => {
    const { env } = await createTestEnv();
    const req = scopedRequest("https://tubot-sf-auth.internal/internal/channels/user/conversations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer salesforce-secret",
        "x-channel-id": channelId,
        "x-team-id": "team-test",
        "x-org-id": orgId,
      },
      body: JSON.stringify({}),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
  });
});
