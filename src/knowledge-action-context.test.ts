import { expect, test } from "bun:test";
import { invokeKnowledgeContext, KNOWLEDGE_CONTEXT_ACTIONS } from "./knowledge-action-context";

const version = "ka0000000000001AAA", article = "kA0000000000001AAA", user = "005000000000001AAA";
const translatedVersion = "ka0000000000002AAA";
async function run(action: string, options: { reject?: boolean; cleanupReject?: boolean; catalog?: string[]; masterReject?: boolean; referenceTo?: unknown; languages?: string[]; descriptorInputs?: { name: string; required: boolean }[]; setupReject?: boolean; noTranslation?: boolean } = {}) {
  const { reject = false, cleanupReject = false, masterReject = false, setupReject = false, noTranslation = false } = options;
  const catalog = options.catalog ?? KNOWLEDGE_CONTEXT_ACTIONS;
  const referenceTo = options.referenceTo === undefined ? ["Knowledge__ka"] : options.referenceTo;
  const languages = options.languages ?? ["en_US"];
  const descriptorInputs = options.descriptorInputs ?? [];
  let row: any, translated: any, removed = false;
  const calls: string[] = [];
  const deletes: string[] = [];
  const bodies: Record<string, any> = {};
  const result = await invokeKnowledgeContext({ root: "/services/data/v67.0", route: `/services/data/v67.0/actions/standard/${action}`, target: "Knowledge__kav", userId: user,
    build: async (_name, _marker, values) => ({ values }),
    request: async (path, method = "GET", body) => {
      const reply = (status: number, body: any) => ({ status, ok: status >= 200 && status < 300, body });
      if (path.endsWith("/actions/standard")) return reply(200, { actions: catalog.map(name => ({ name })) });
      if (path.endsWith("/describe")) return reply(200, { createable: true, queryable: true, fields: [{ name: "Title", createable: true }, { name: "UrlName", createable: true }, { name: "KnowledgeArticleId", referenceTo }, { name: "Language", picklistValues: languages.map(value => ({ active: true, value })) }] });
      if (path.includes("/query?")) return reply(200, { records: [row, translated].filter(Boolean).filter(v => decodeURIComponent(path).includes(`PublishStatus='${v.PublishStatus}'`)) });
      if (path.endsWith("/sobjects/Knowledge__kav") && method === "POST") { row = { ...body, Id: version, KnowledgeArticleId: article, PublishStatus: "Draft", Language: "en_US" }; return reply(201, { id: version }); }
      if (method === "DELETE") { deletes.push(path); if (masterReject) return reply(403, { errorCode: "FORBIDDEN" }); row = undefined; translated = undefined; removed = true; return reply(204, null); }
      if (path.endsWith(`/${version}`)) return row ? reply(200, row) : reply(404, []);
      if (method === "GET") return reply(200, { inputs: descriptorInputs });
      const name = path.split("/").at(-1)!;
      calls.push(name);
      bodies[name] = body;
      if (reject && name === action) return reply(200, [{ isSuccess: false, errors: [{ message: "real rejection" }] }]);
      if (setupReject && name === action) return reply(200, [{ isSuccess: false, errors: [{ statusCode: "INSUFFICIENTPRIVILEGE", message: "The endpoint cannot be accessed. Please check your permission and preference settings for SubmitForTranslation." }] }]);
      if (cleanupReject && name === "deleteKnowledgeArticles") return reply(403, { errorCode: "FORBIDDEN" });
      if (name === "publishKnowledgeArticles") row.PublishStatus = "Online";
      if (name === "archiveKnowledgeArticles") row.PublishStatus = "Archived";
      if (["createDraftFromOnlineKnowledgeArticle", "restoreKnowledgeArticleVersion"].includes(name)) row.PublishStatus = "Draft";
      if (name === "assignKnowledgeArticles") row.AssignedToId = body.inputs[0].assigneeId;
      if (name === "deleteKnowledgeArticles") { row = undefined; removed = true; }
      if (name === "submitKnowledgeArticleForTranslation" && !noTranslation) translated = { Id: translatedVersion, Title: row.Title, KnowledgeArticleId: article, PublishStatus: "Draft", Language: body.inputs[0].language };
      return reply(200, [{ isSuccess: true, errors: [], outputValues: {} }]);
    },
  });
  return { result, calls, deletes, removed, bodies };
}
for (const action of ["publishKnowledgeArticles", "archiveKnowledgeArticles", "assignKnowledgeArticles", "createDraftFromOnlineKnowledgeArticle", "restoreKnowledgeArticleVersion", "deleteKnowledgeArticles"]) test(`Knowledge ${action} verifies actual state and cleans owned versions`, async () => {
  const { result, removed, deletes } = await run(action);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.cleanupError).toBeUndefined();
  expect(removed).toBe(true);
  expect(deletes.every(d => d.includes("/sobjects/Knowledge__ka/") || d.includes("/sobjects/KnowledgeArticle/"))).toBe(true);
});
test("Knowledge publish succeeds without archive/delete invocables via master cascade", async () => {
  const { result, removed, calls } = await run("publishKnowledgeArticles", { catalog: ["publishKnowledgeArticles"] });
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.cleanupError).toBeUndefined();
  expect(removed).toBe(true);
  expect(calls).toEqual(["publishKnowledgeArticles"]);
});
test("Knowledge falls back to KnowledgeArticle master when describe lacks a reference", async () => {
  const { result, deletes } = await run("publishKnowledgeArticles", { referenceTo: [] });
  expect(result.contextSchema?.verified).toBe(true);
  expect(deletes[0]).toContain("/sobjects/KnowledgeArticle/");
});
test("Knowledge falls back to invocable cleanup when master delete is rejected", async () => {
  const { result, removed } = await run("publishKnowledgeArticles", { masterReject: true });
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.cleanupError).toBeUndefined();
  expect(removed).toBe(true);
});
test("Knowledge provider rejection remains a rejection while cleaning the draft", async () => {
  const { result, removed } = await run("publishKnowledgeArticles", { reject: true });
  expect(result.contextSchema?.verified).toBe(false);
  expect(result.body[0].isSuccess).toBe(false);
  expect(removed).toBe(true);
});
test("Knowledge cleanup rejection is explicit even after verified publication", async () => {
  const { result } = await run("publishKnowledgeArticles", { cleanupReject: true, masterReject: true });
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.cleanupError).toContain("deletion cleanup was rejected");
});
test("Knowledge cleanup failure without invocables names the master rejection", async () => {
  const { result } = await run("publishKnowledgeArticles", { masterReject: true, catalog: ["publishKnowledgeArticles"] });
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.cleanupError).toContain("master cleanup");
});
test("Knowledge refuses fixture creation when the requested action is unavailable", async () => {
  const { result, calls, removed } = await run("archiveKnowledgeArticles", { catalog: ["publishKnowledgeArticles"] });
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe("KNOWLEDGE_CLEANUP_CAPABILITY_REQUIRED");
  expect(result.body.message).toContain("archiveKnowledgeArticles");
  expect(calls).toEqual([]);
  expect(removed).toBe(false);
});
test("Knowledge refuses fixture creation when a setup dependency is unavailable", async () => {
  const { result, calls } = await run("archiveKnowledgeArticles", { catalog: ["archiveKnowledgeArticles", "deleteKnowledgeArticles"] });
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe("KNOWLEDGE_CLEANUP_CAPABILITY_REQUIRED");
  expect(result.body.message).toContain("publishKnowledgeArticles");
  expect(calls).toEqual([]);
});
const translationInputs = [{ name: "articleId", required: true }, { name: "language", required: true }];
test("Knowledge translation submits the owned master and verifies the translation draft", async () => {
  const { result, calls, bodies, removed } = await run("submitKnowledgeArticleForTranslation", { languages: ["en_US", "fr"], descriptorInputs: translationInputs });
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.cleanupError).toBeUndefined();
  expect(removed).toBe(true);
  expect(calls).toEqual(["submitKnowledgeArticleForTranslation"]);
  expect(bodies.submitKnowledgeArticleForTranslation.inputs[0]).toEqual({ articleId: article, language: "fr" });
  expect(result.contextSchema?.verificationRecordIds).toEqual([translatedVersion]);
});
test("Knowledge translation refuses fixture creation without a secondary language", async () => {
  const { result, calls, removed } = await run("submitKnowledgeArticleForTranslation", { descriptorInputs: translationInputs });
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe("KNOWLEDGE_TRANSLATION_SETUP_REQUIRED");
  expect(calls).toEqual([]);
  expect(removed).toBe(false);
});
test("Knowledge translation maps the SubmitForTranslation gate while cleaning the draft", async () => {
  const { result, removed } = await run("submitKnowledgeArticleForTranslation", { languages: ["en_US", "fr"], descriptorInputs: translationInputs, setupReject: true });
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe("KNOWLEDGE_TRANSLATION_SETUP_REQUIRED");
  expect(result.body.upstreamOutcome[0].isSuccess).toBe(false);
  expect(removed).toBe(true);
});
test("Knowledge translation refuses unsupported required descriptor inputs", async () => {
  const { result, calls, removed } = await run("submitKnowledgeArticleForTranslation", { languages: ["en_US", "fr"],
    descriptorInputs: [...translationInputs, { name: "futureRequired", required: true }] });
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe("KNOWLEDGE_CONTEXT_INVALID");
  expect(calls).toEqual([]);
  expect(removed).toBe(false);
});
test("Knowledge translation without a translation draft stays unverified", async () => {
  const { result, removed } = await run("submitKnowledgeArticleForTranslation", { languages: ["en_US", "fr"], descriptorInputs: translationInputs, noTranslation: true });
  expect(result.contextSchema?.verified).toBe(false);
  expect(result.body.errorCode).toBe("KNOWLEDGE_MUTATION_UNVERIFIED");
  expect(removed).toBe(true);
});
