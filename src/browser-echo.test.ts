import { describe, expect, it } from "bun:test";
import { discoverBrowserTurns, vfBootstrapDeployment } from "./browser-echo";

const initFor = (esw: string) =>
  `<script>function initEmbeddedMessaging(){try{embeddedservice_bootstrap.init(\n` +
  `\t\t'00Dxx0000000000',\n\t\t'${esw}',\n\t\t'https://example.my.site.com/ESWTest',\n` +
  `\t\t{\n\t\t\tscrt2URL: 'https://example.my.salesforce-scrt.com'\n\t\t}\n\t);}};</script>`;

describe("vfBootstrapDeployment", () => {
  it("parses the deployment from a multiline bootstrap init", () => {
    expect(vfBootstrapDeployment(initFor("Nu_Message_Channel_TuBot"))).toBe(
      "Nu_Message_Channel_TuBot",
    );
  });
  it("strips a namespace prefix from the esw name", () => {
    expect(vfBootstrapDeployment(initFor("tubot__Nu_Message_Web"))).toBe("Nu_Message_Web");
  });
  it("returns null when no init call is present", () => {
    expect(vfBootstrapDeployment("<apex:page><body>no bootstrap</body></apex:page>")).toBeNull();
  });
});

const REF = "a".repeat(64);
const scope: any = { teamId: "t", orgId: "00D000000000000", channelId: "0Mj000000000000" };
const config: any = { apiVersion: "v68.0", visitorField: "Proxy_Echo_Visitor_Ref__c" };
const jsonRes = (body: unknown, ok = true) =>
  ({ ok, json: async () => body }) as unknown as Response;
const convRow = (conv: string, refValue: string | null = null) => ({
  Id: "0Mw000000000000",
  Status: "Waiting",
  Conversation: { ConversationIdentifier: conv },
  Proxy_Echo_Visitor_Ref__c: refValue,
});

describe("discoverBrowserTurns", () => {
  it("fires a single bound lookup (unbound adoption removed: takeover guard)", async () => {
    const seen: string[] = [];
    const read = async (path: string) => {
      seen.push(path);
      return jsonRes({ records: [] });
    };
    const out = await discoverBrowserTurns(read, scope, config, { reference: REF, sinceMs: Date.now() });
    expect(out).toEqual({ conversationId: null, entries: [] });
    expect(seen.filter((p) => p.includes("/query?")).length).toBe(1);
    expect(seen[0]).toContain(REF);
  });

  it("serves the bound reference match", async () => {
    const boundConv = crypto.randomUUID();
    const msg = crypto.randomUUID();
    const read = async (path: string) => {
      if (path.includes("/query?")) return jsonRes({ records: [convRow(boundConv, REF)] });
      return jsonRes({ conversationEntries: [{ identifier: msg, messageText: "hi", sender: { role: "EndUser" }, clientTimestamp: Date.now() }] });
    };
    const out = await discoverBrowserTurns(read, scope, config, { reference: REF, sinceMs: Date.now() });
    expect(out.conversationId).toBe(boundConv);
    expect(out.entries.map((e) => e.messageId)).toEqual([msg]);
  });

  it("never adopts unbound candidates, with or without entries", async () => {
    const unboundConv = crypto.randomUUID();
    const msg = crypto.randomUUID();
    const read = async (path: string) => {
      if (path.includes("/query?") && path.includes(REF)) return jsonRes({ records: [] });
      if (path.includes("/query?")) return jsonRes({ records: [convRow(unboundConv, null)] });
      return jsonRes({ conversationEntries: [{ identifier: msg, messageText: "victim text", sender: { role: "EndUser" }, clientTimestamp: Date.now() }] });
    };
    const out = await discoverBrowserTurns(read, scope, config, { reference: REF, sinceMs: Date.now() });
    expect(out).toEqual({ conversationId: null, entries: [] });
  });

  it("keeps the pinned fast path and ended handling", async () => {
    const conv = crypto.randomUUID();
    const msg = crypto.randomUUID();
    const calls: string[] = [];
    const read = async (path: string) => {
      calls.push(path);
      if (path.includes("/query?")) return jsonRes({ records: [convRow(conv, REF)] });
      return jsonRes({ conversationEntries: [{ identifier: msg, messageText: "hi", sender: { role: "EndUser" }, clientTimestamp: Date.now() }] });
    };
    const out = await discoverBrowserTurns(read, scope, config, { reference: REF, conversationId: conv });
    expect(out.conversationId).toBe(conv);
    expect(calls.filter((p) => p.includes("/query?")).length).toBe(1);
  });

  it("rejects pinned unbound rows (binding requires echo proof)", async () => {
    const conv = crypto.randomUUID();
    const read = async (path: string) => {
      if (path.includes("/query?")) return jsonRes({ records: [convRow(conv, null)] });
      return jsonRes({ conversationEntries: [] });
    };
    const out = await discoverBrowserTurns(read, scope, config, { reference: REF, conversationId: conv });
    expect(out).toEqual({ conversationId: null, entries: [] });
  });

  it("rejects malformed scope ids without querying", async () => {
    const calls: string[] = [];
    const read = async (path: string) => {
      calls.push(path);
      return jsonRes({ records: [] });
    };
    const badOrg = await discoverBrowserTurns(read, { ...scope, orgId: "o' OR '1'='1" }, config, { reference: REF });
    expect(badOrg).toEqual({ conversationId: null, entries: [] });
    const badChannel = await discoverBrowserTurns(read, { ...scope, channelId: "x" }, config, { reference: REF });
    expect(badChannel).toEqual({ conversationId: null, entries: [] });
    expect(calls.length).toBe(0);
  });
});

describe("verifyBrowserTurn knownEntries pass-through", () => {
  const { verifyBrowserTurn } = require("./browser-echo") as typeof import("./browser-echo");
  const msg = crypto.randomUUID();
  const conv = crypto.randomUUID();
  const boundSession = () => jsonRes({ records: [{ Id: "0Mw000000000000", MessagingEndUserId: "0Sg000000000000", Proxy_Echo_Visitor_Ref__c: REF }] });
  const liveEntries = (text: string) =>
    jsonRes({ conversationEntries: [{ identifier: msg, messageText: text, sender: { role: "EndUser" } }] });

  it("skips the duplicate entries fetch on (messageId,text) match", async () => {
    const paths: string[] = [];
    const read = async (path: string) => {
      paths.push(path);
      if (path.includes("/query?")) return boundSession();
      return liveEntries("hi");
    };
    const out = await verifyBrowserTurn(read, scope, config, {
      reference: REF, conversationId: conv, messageId: msg, text: "hi",
      knownEntries: [{ messageId: msg, text: "hi", timestamp: Date.now() }],
    });
    expect(out).toEqual({ ok: true, code: "verified" });
    expect(paths.filter((p) => p.includes("/entries?")).length).toBe(0);
    expect(paths.filter((p) => p.includes("/query?")).length).toBe(1);
  });

  it("falls back to the live fetch on miss or drift, mismatch still fails", async () => {
    const paths: string[] = [];
    const read = async (path: string) => {
      paths.push(path);
      if (path.includes("/query?")) return boundSession();
      return liveEntries("real text");
    };
    const base = { reference: REF, conversationId: conv, messageId: msg };
    // miss: unknown messageId -> live fetch -> entry found
    const hit = await verifyBrowserTurn(read, scope, config, { ...base, text: "real text", knownEntries: [{ messageId: crypto.randomUUID(), text: "nope", timestamp: 0 }] });
    expect(hit.code).toBe("verified");
    // drift: non-array -> live fetch
    const drift = await verifyBrowserTurn(read, scope, config, { ...base, text: "real text", knownEntries: "garbage" as any });
    expect(drift.code).toBe("verified");
    // tampered text matches neither known nor live transcript
    const bad = await verifyBrowserTurn(read, scope, config, { ...base, text: "tampered", knownEntries: [{ messageId: msg, text: "real text", timestamp: 0 }] });
    expect(bad).toEqual({ ok: false, code: "transcript_mismatch" });
    expect(paths.filter((p) => p.includes("/entries?")).length).toBe(3);
  });
});
