type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const record = (v: any): v is Value => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: any): v is string => typeof v === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
export const KNOWLEDGE_CONTEXT_ACTIONS = ["publishKnowledgeArticles", "assignKnowledgeArticles", "archiveKnowledgeArticles", "deleteKnowledgeArticles", "createDraftFromOnlineKnowledgeArticle", "restoreKnowledgeArticleVersion", "getArticleSmartLinkUrl", "submitKnowledgeArticleForTranslation"];
const success = (r: Result) => r.ok && Array.isArray(r.body) && r.body.length > 0 && r.body.every(v => record(v) && v.isSuccess === true && (!Array.isArray(v.errors) || v.errors.length === 0));
const rejection = (r: Result): string => JSON.stringify(Array.isArray(r.body) ? r.body.flatMap(v => v.errors ?? []).map(v => ({ code: v.statusCode ?? v.errorCode, message: v.message })) : { errorCode: r.body?.errorCode, message: r.body?.message })
  .replace(/\b[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?\b/g, "[salesforce-id]").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]").slice(0, 1500);

/** Only newly created article versions are ever published, archived, assigned or deleted. */
export async function invokeKnowledgeContext(input: {
  root: string; route: string; target: string; userId: string; verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
}): Promise<{ status: number; body: any; contextSchema?: Value; cleanupError?: string }> {
  const { root, request, target } = input;
  const action = input.route.split("/").at(-1)!;
  const fail = (errorCode: string, message: string): Result => ({ status: 422, ok: false, body: { errorCode, message } });
  if (!KNOWLEDGE_CONTEXT_ACTIONS.includes(action) || !/^[A-Za-z][A-Za-z0-9_]{0,127}__kav$/.test(target) || !id(input.userId)) return fail("KNOWLEDGE_CONTEXT_INVALID", "A live article-version object and connected execution identity are required.");
  const schema = await request(`${root}/sobjects/${target}/describe`);
  if (!schema.ok) return schema;
  const fields = record(schema.body) && Array.isArray(schema.body.fields) ? schema.body.fields.filter(record) : [];
  if (schema.body?.createable !== true || schema.body?.queryable !== true || !["Title", "UrlName"].every(name => fields.some(f => f.name === name && f.createable === true)))
    return { status: 403, body: { errorCode: "KNOWLEDGE_FIXTURE_PERMISSIONS_REQUIRED", message: "Live article create/read, Title and UrlName write access are required for an owned Knowledge lifecycle." } };
  const language = fields.find(f => f.name === "Language")?.picklistValues?.find((v: Value) => v.active === true)?.value;
  if (typeof language !== "string") return fail("KNOWLEDGE_LANGUAGE_UNAVAILABLE", "The live article schema has no active language.");
  // Translation needs a secondary active language to submit to. When the org
  // exposes only the master language (live-verified: single-value picklist,
  // no KnowledgeSettings languages), Salesforce rejects every submit with its
  // SubmitForTranslation setup gate — refuse before creating any fixture.
  const translationLanguage = action === "submitKnowledgeArticleForTranslation"
    ? fields.find(f => f.name === "Language")?.picklistValues?.find((v: Value) => v.active === true && v.value !== language)?.value
    : undefined;
  if (action === "submitKnowledgeArticleForTranslation" && typeof translationLanguage !== "string")
    return fail("KNOWLEDGE_TRANSLATION_SETUP_REQUIRED", "The live org exposes no secondary Knowledge language to submit a translation to; enable Knowledge translation languages before this fixture can run.");
  const descriptor = await request(input.route);
  if (!descriptor.ok) return descriptor;
  const liveInputs = record(descriptor.body) && Array.isArray(descriptor.body.inputs) ? descriptor.body.inputs.filter(record) : [];
  if (action === "submitKnowledgeArticleForTranslation") {
    const required = liveInputs.filter(i => i.required === true).map(i => i.name);
    const unknown = required.filter(name => typeof name !== "string" || !["articleId", "language"].includes(name));
    if (unknown.length) return fail("KNOWLEDGE_CONTEXT_INVALID", `The live translation action requires unsupported inputs: ${unknown.join(", ")}.`);
    if (!required.includes("articleId") || !required.includes("language"))
      return fail("KNOWLEDGE_CONTEXT_INVALID", "The live translation action does not expose its required article/language inputs.");
  }
  const catalog = await request(`${root}/actions/standard`);
  if (!catalog.ok) return catalog;
  const available = new Set(Array.isArray(catalog.body?.actions) ? catalog.body.actions.map((v: Value) => v.name) : []);
  // Owned cleanup deletes the Knowledge master record (cascades to every version),
  // so archive/delete invocables are setup dependencies only — never a fixture gate.
  const setupDependencies = action === "restoreKnowledgeArticleVersion" ? ["publishKnowledgeArticles", "archiveKnowledgeArticles"]
    : ["archiveKnowledgeArticles", "createDraftFromOnlineKnowledgeArticle", "getArticleSmartLinkUrl"].includes(action) ? ["publishKnowledgeArticles"] : [];
  const missing = [action, ...setupDependencies].find(name => !available.has(name));
  if (missing) {
    return fail("KNOWLEDGE_CLEANUP_CAPABILITY_REQUIRED", `The live action catalog lacks ${missing}, which this owned Knowledge fixture requires. Lightning Knowledge setup is needed before this fixture can run.`);
  }
  const invocableCleanup = ["archiveKnowledgeArticles", "deleteKnowledgeArticles"].every(name => available.has(name));
  // The master object derives from the live KnowledgeArticleId reference (e.g. FAQ__ka);
  // KnowledgeArticle is the platform-wide fallback. Both cascade to every version.
  const referenceTo = fields.find(f => f.name === "KnowledgeArticleId")?.referenceTo;
  const derivedMaster = Array.isArray(referenceTo) ? referenceTo.find((name: unknown): name is string => typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name)) : undefined;
  const masters = [...new Set([derivedMaster, "KnowledgeArticle"].filter((name): name is string => typeof name === "string"))];
  const marker = `AS probe ${crypto.randomUUID()}`;
  const built = await input.build(target, marker, { Title: marker, UrlName: `as-probe-${crypto.randomUUID()}`, Language: language });
  if ("failure" in built) return built.failure;
  const automaticSteps = ["Discover live Knowledge article fields and language", "Create and read back a uniquely marked draft", "Prepare the required publication state", "Invoke the discovered action", "Verify actual article state", "Delete owned article versions and verify absence"];
  let articleId: string | undefined, versionId: string | undefined, verified = false, cleanupError: string | undefined;
  const verificationRecordIds: string[] = [];
  let outcome: Result = fail("KNOWLEDGE_CONTEXT_UNAVAILABLE", "The article context could not be prepared.");
  let expectedChanges: Value = {};
  const versions = async () => {
    if (!articleId) return [];
    const rows: Value[] = [];
    // Knowledge queries require a single publication status when filtering by article identity.
    for (const state of ["Draft", "Online", "Archived"]) {
      const r = await request(`${root}/query?q=${encodeURIComponent(`SELECT Id,Title,PublishStatus,KnowledgeArticleId,AssignedToId,Language FROM ${target} WHERE KnowledgeArticleId='${articleId}' AND PublishStatus='${state}' LIMIT 10`)}`);
      if (!r.ok || !Array.isArray(r.body?.records)) throw Error("Owned article versions could not be independently read back.");
      if (r.body.records.some((v: Value) => !id(v.Id) || v.Title !== marker)) throw Error("Owned article version marker mismatch.");
      rows.push(...r.body.records);
    }
    return rows;
  };
  const invoke = (name: string, args: Value) => request(`${root}/actions/standard/${name}`, "POST", { inputs: [args] });
  try {
    outcome = await (async () => {
      const created = await request(`${root}/sobjects/${target}`, "POST", built.values);
      if (!created.ok || !id(created.body?.id)) return created;
      versionId = created.body.id;
      const actual = await request(`${root}/sobjects/${target}/${versionId}`);
      if (!actual.ok || actual.body?.Title !== marker || !id(actual.body?.KnowledgeArticleId)) return fail("KNOWLEDGE_DRAFT_UNVERIFIED", "The owned draft failed its title/article identity readback.");
      articleId = actual.body.KnowledgeArticleId;
      if (["archiveKnowledgeArticles", "createDraftFromOnlineKnowledgeArticle", "restoreKnowledgeArticleVersion", "getArticleSmartLinkUrl"].includes(action)) {
        const published = await invoke("publishKnowledgeArticles", { articleVersionIdList: [versionId], pubAction: "PUBLISH_ARTICLE" });
        if (!success(published)) return published;
        if (!(await versions()).some(v => v.Id === versionId && v.PublishStatus === "Online")) return fail("KNOWLEDGE_PUBLICATION_UNVERIFIED", "Salesforce did not publish the owned article version.");
      }
      if (action === "restoreKnowledgeArticleVersion") {
        const archived = await invoke("archiveKnowledgeArticles", { articleVersionIdList: [versionId] });
        if (!success(archived)) return archived;
        if (!(await versions()).some(v => v.Id === versionId && v.PublishStatus === "Archived")) return fail("KNOWLEDGE_ARCHIVE_UNVERIFIED", "Salesforce did not archive the owned article version.");
      }
      // Translation submits the owned master (KA) directly: the live descriptor
      // accepts "KA or primary-language KAV" with no state requirement, so no
      // publication prep is needed. Only required inputs are sent — no
      // assignee, due date, email, or Einstein service side effects.
      const args: Value = action === "createDraftFromOnlineKnowledgeArticle" ? { action: "EDIT_AS_DRAFT_ARTICLE", unpublish: true, articleId }
        : action === "restoreKnowledgeArticleVersion" ? { action: "RESTORE_KNOWLEDGE_ARTICLE_VERSION", articleId }
        : action === "submitKnowledgeArticleForTranslation" ? { articleId, language: translationLanguage }
        : action === "getArticleSmartLinkUrl" ? { articleVersionId: versionId }
        : { articleVersionIdList: [versionId], ...(action === "publishKnowledgeArticles" ? { pubAction: "PUBLISH_ARTICLE" } : {}),
          ...(action === "assignKnowledgeArticles" ? { assignAction: "ASSIGN_DRAFT_MASTER", assigneeId: input.userId, sendEmailNotification: false } : {}) };
      if (action === "deleteKnowledgeArticles" && input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, input.verificationWindowMs));
      const result = await request(input.route, "POST", { inputs: [args] });
      if (!success(result)) {
        // Orgs with a secondary language but without the SubmitForTranslation
        // preference reject explicitly (live-verified INSUFFICIENTPRIVILEGE in
        // both orgs, draft and published) — report setup-blocked honestly.
        if (action === "submitKnowledgeArticleForTranslation" && /submitfortranslation/i.test(rejection(result)))
          return { ...fail("KNOWLEDGE_TRANSLATION_SETUP_REQUIRED", "Salesforce rejected the owned translation submit at its SubmitForTranslation setup gate; enable Knowledge translation before this fixture can run."), body: { errorCode: "KNOWLEDGE_TRANSLATION_SETUP_REQUIRED", message: "Salesforce rejected the owned translation submit at its SubmitForTranslation setup gate; enable Knowledge translation before this fixture can run.", upstreamOutcome: result.body } };
        return result;
      }
      const rows = await versions();
      if (action === "deleteKnowledgeArticles") { verified = rows.length === 0; expectedChanges = { deleted: true }; }
      else if (action === "submitKnowledgeArticleForTranslation") {
        expectedChanges = { Language: translationLanguage };
        const found = rows.find(v => Object.entries(expectedChanges).every(([name, value]) => v[name] === value));
        verified = Boolean(found); if (found) verificationRecordIds.push(found.Id);
      }
      else if (action === "getArticleSmartLinkUrl") {
        verified = rows.some(v => v.Id === versionId && v.PublishStatus === "Online") && result.body.some((v: Value) => Object.values(v.outputValues ?? {}).some(url => typeof url === "string" && /^(?:https?:\/\/|\/)/.test(url)));
        if (verified) verificationRecordIds.push(versionId!);
      } else {
        expectedChanges = action === "assignKnowledgeArticles" ? { AssignedToId: input.userId } : { PublishStatus: action === "publishKnowledgeArticles" ? "Online" : action === "archiveKnowledgeArticles" ? "Archived" : "Draft" };
        const found = rows.find(v => Object.entries(expectedChanges).every(([name, value]) => v[name] === value));
        verified = Boolean(found); if (found) verificationRecordIds.push(found.Id);
      }
      if (action === "deleteKnowledgeArticles" && verified) verificationRecordIds.push(versionId!);
      if (verified && action !== "deleteKnowledgeArticles" && input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, input.verificationWindowMs));
      return verified ? result : { ...fail("KNOWLEDGE_MUTATION_UNVERIFIED", "Salesforce reported success without the expected owned article state."), body: { errorCode: "KNOWLEDGE_MUTATION_UNVERIFIED", message: "Salesforce reported success without the expected owned article state.", upstreamOutcome: result.body } };
    })();
  } catch (error) { outcome = fail("KNOWLEDGE_LIFECYCLE_UNVERIFIED", error instanceof Error ? error.message : "The owned article lifecycle failed."); }
  finally {
    // Resolve the master identity even when the initial readback failed midway.
    if (!articleId && versionId) {
      const existing = await request(`${root}/sobjects/${target}/${versionId}`);
      if (existing.ok && existing.body?.Title === marker && id(existing.body?.KnowledgeArticleId)) articleId = existing.body.KnowledgeArticleId;
    }
    if (articleId || versionId) try {
      if (!articleId) throw Error("The owned article master identity could not be resolved for cleanup.");
      // versions() rejects markers that are not ours, so the master below is owned.
      const owned = await versions();
      let cleaned = owned.length === 0;
      let lastRejection = "";
      for (const master of masters) {
        if (cleaned) break;
        const r = await request(`${root}/sobjects/${master}/${articleId}`, "DELETE");
        if (r.ok || r.status === 404) {
          if ((await versions()).length === 0) { cleaned = true; break; }
          lastRejection = `Owned article versions remain after ${master} master cleanup.`;
        } else lastRejection = `Owned article master cleanup via ${master} was rejected: ${rejection(r)}`;
      }
      if (!cleaned && invocableCleanup) {
        // Legacy fallback where the catalog still exposes archive/delete invocables.
        for (const v of (await versions()).filter(v => v.PublishStatus === "Online")) {
          const r = await invoke("archiveKnowledgeArticles", { articleVersionIdList: [v.Id] });
          if (!success(r)) throw Error(`Owned article archival cleanup was rejected: ${rejection(r)}`);
        }
        for (const v of await versions()) {
          const existing = await request(`${root}/sobjects/${target}/${v.Id}`);
          if (existing.status === 404) continue;
          if (!existing.ok || existing.body?.Title !== marker) throw Error("Owned article deletion marker readback failed.");
          const r = await invoke("deleteKnowledgeArticles", { articleVersionIdList: [v.Id] });
          if (!success(r)) throw Error(`Owned article deletion cleanup was rejected: ${rejection(r)}`);
          const check = await request(`${root}/sobjects/${target}/${v.Id}`);
          if (check.status !== 404) throw Error("Owned article deletion was not verified.");
        }
        cleaned = (await versions()).length === 0;
        if (!cleaned) lastRejection = "Owned article versions remain after invocable cleanup.";
      }
      if (!cleaned) throw Error(lastRejection || "Owned Knowledge cleanup failed.");
      if (versionId && (await request(`${root}/sobjects/${target}/${versionId}`)).status !== 404)
        throw Error("The originally created article version remains after cleanup.");
    } catch (error) { cleanupError = error instanceof Error ? error.message : "Owned Knowledge cleanup failed."; }
  }
  return { status: outcome.status, body: outcome.body, ...(cleanupError ? { cleanupError } : {}), contextSchema: {
    source: "salesforce_live_knowledge_action", targetObject: target, markerField: "Title", marker, articleId, versionId,
    ...(action === "submitKnowledgeArticleForTranslation" ? { translationLanguage } : {}),
    mutationKind: action === "deleteKnowledgeArticles" ? "delete" : "update", verified, expectedChanges, verificationRecordIds, automaticSteps,
  } };
}
