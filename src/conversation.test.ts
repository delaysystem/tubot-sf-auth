import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  TubotSfAuthEntrypoint,
  __resetPanelCredentialCacheForTests,
  type AuthEnv,
  type Credential,
  type UserConversationHistory,
} from "./index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetPanelCredentialCacheForTests();
});

const orgId = "00D000000000001AAA";
const userId = "003000000000001AAA";
const channelId = "0Mjg00000000001AAA";
const scope = { teamId: "team-test", orgId, channelId };
const keyBytes = new Uint8Array(32).fill(7);
const encryptionKey = btoa(String.fromCharCode(...keyBytes));

async function createTestEnv() {
  const row: Credential = {
    team_id: "team-test",
    org_id: orgId,
    channel_id: channelId,
    instance_url: "https://test.my.salesforce.com",
    integration_user_id: "005000000000001AAA",
    integration_username: "integration@example.com",
    is_sandbox: 1,
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
          if (sql.includes("FROM panel_salesforce_channels") ||
              sql.includes("panel_salesforce_execution_users")) {
            return row;
          }
          return null;
        },
        async all() {
          return { results: [] };
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
    PANEL_JWT_SIGNER: {
      async signAssertion(_input: unknown) { return "test-assertion"; },
    } as never,
    AUTH_RPC_WARN_MODE: "1",
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

});
