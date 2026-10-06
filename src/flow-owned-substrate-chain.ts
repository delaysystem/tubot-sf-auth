/**
 * Owned-substrate execution for metadata-hidden custom Flow actions.
 *
 * Root cause: creation/update flows stall in the searcher because no
 * disposable business-record substrate exists to execute them on, and
 * notification flows stall for want of a disposable recipient. The
 * searcher (`1action-searcher/src/flow-owned-substrate.ts`) classifies the
 * live descriptor into a plan; this module executes it against live org
 * state with a fully owned fixture graph and verified cleanup:
 *
 * - Resolve every id/reference input to a live object: ordered hint
 *   candidates (normalized stem, CamelCase n-grams, route-tail n-grams,
 *   description keyword joins) validated against the live
 *   EntityDefinition catalog, then live sObject describes. Unresolvable
 *   record-documented targets refuse with FLOW_RECORD_TARGET_ABSENT
 *   before anything is created; non-record-documented inputs (correlation
 *   tokens, codes) and external-identity inputs (external ids, sys_ids)
 *   take synthetic fillers instead of blocking the probe, and
 *   self-user-shaped inputs (owner, custodian, subject ids) bind the
 *   live integration user itself on every plan kind, never a minted User.
 * - Plan the fixture graph with `planOwnedContext` (bounded, cycle-safe,
 *   marker-proven), create and read back every fixture, invoke once with
 *   fixture ids bound, and gate on the real outcome: native success, a
 *   Finished interview, no errors, and no failure text in any output.
 *   Anchorless sweeps prove ownership through the exact prose marker
 *   alone, and anchorless reads bind only synthetic values.
 * - Delete created rows through id/record outputs with probe-window
 *   creation proof (CreatedDate within the probe window, never a fixture
 *   id, never a live parent). Scalar, collection, and JSON-embedded
 *   output identities all surface as candidates; mirror SOBJECT outputs
 *   count on creation-declared flows; children sweep by created-parent
 *   linkage and delete children-first before their parents. Fixtures then
 *   delete through ownership-scoped cleanup plus a communication-residue
 *   sweep, and every tracked child reports in `createdChildren`.
 * - Creation-declared shapes with no cleanable output refuse upfront
 *   with FLOW_CREATED_CHILD_UNTRACKED, unless the plan is a creation
 *   sweep: sweep targets resolved from live catalog evidence are queried
 *   for probe-window rows carrying the exact marker or referencing an
 *   owned fixture, verified, and deleted children-first. No target or no
 *   ownership proof refuses with the same code, as does an
 *   exact-evidence created object the identity cannot query or delete:
 *   created rows would leak.
 * - Approval-submission and external-channel/ITSM shapes refuse with the
 *   shared terminal codes; nothing is ever invoked for them. Bare `text`
 *   alone is not a channel: consent documents (`authorization form text`)
 *   are records, not SMS. Fulfillment and recurrence vocabulary no longer
 *   refuses upfront: internal-record fulfillment sweeps when its targets
 *   resolve cleanable, and read-only-evident reads excuse collaboration
 *   nouns plus contained sys_id inputs (never directed sends, meetings,
 *   vendor systems, callouts, or ITSM-evidencing routes/descriptions).
 * - Opaque execution faults (UNKNOWN_EXCEPTION interview errors) carry an
 *   evidence-fed managedFlowFault stamp: flow-metadata references checked
 *   against the live actions descriptor, the ApexClass table, and cached
 *   describes narrow the generic code to FLOW_EXECUTION_INVOCABLE_MISSING
 *   or FLOW_EXECUTION_SCHEMA_SKEW. Planner output only; assessed codes
 *   stay stable. Diagnosed faults also carry a repairPlan (the concrete
 *   repair strategy), and provably non-creating agent-context faults
 *   repair inline through the producer-backed lifecycle; creation-claimed
 *   flows never inline-repair and keep the planner's repairPlan.
 * - Bare generic record ids (`RecordId`) fall back to an owned Case
 *   fixture only when the plan explicitly allows it and the live catalog
 *   validates Case; template-named inputs sample one live configuration
 *   row (never business data); optional unresolvable generic inputs are
 *   omitted while specific-stem misses keep the precise terminal.
 *
 * Zero-hardcoding contract: no org IDs, aliases, instance URLs, tenant
 * names, or customer values appear here. Flow/object/field names are
 * caller-supplied live descriptor values validated before use; the only
 * fixed object name is the platform CustomNotificationType vocabulary
 * for notification-type sampling, validated against the live catalog.
 */

import { nativeActionSucceeded } from "./action-outcome";
import { flowOutputFailureSnippet } from "./flow-fallback-contact-chain";
import {
  planFlowFaultRepair,
  runFlowFaultRepairConsumer,
} from "./flow-fault-repair-consumer";
import {
  collectFlowExecutionEvidence,
  describeFieldNames,
  diagnoseFlowExecutionFault,
  fetchFlowMetadataReferences,
  type FlowExecutionEvidenceCache,
} from "./flow-execution-evidence";
import { classifyManagedFlowFault, type ManagedFlowFault } from "./managed-flow-faults";
import { cleanupOwnedContext, type OwnedRecord, type OwnershipScope } from "./owned-context-cleanup";
import { planOwnedContext, type ContextNode, type ContextSchema } from "./owned-context-plan";
import { isTriggerNullInsertFault, planTriggerNullEnrichment } from "./trigger-null-enrichment";
import { sweepFlowCommunicationResidue } from "./flow-residue-sweep";

/** Family builder version: owned-substrate execution for refused flow shapes. 2: plural `Ids` collections count as record evidence; classification runs on the singular form. 3: opaque execution faults attach evidence-fed managedFlowFault (FLOW_EXECUTION_INVOCABLE_MISSING / FLOW_EXECUTION_SCHEMA_SKEW narrow the generic stamp). 4: creation-sweep/read/delete plans, bare-record fallback, template config sampling, optional-generic omission, bare-text channel guard. 5: evidence covers update filters and delete filters, narrowing more generic stamps to schema skew; assessed output failures stamp R5 setup/input branches (FLOW_UPSTREAM_ACCESS_REQUIRED / FLOW_SETUP_RECORD_REQUIRED). 6: diagnosed faults attach a repairPlan, and provably non-creating agent-context faults repair inline through the producer-backed lifecycle. 7: fixtureless marker sweeps, zero-anchor synthetic reads, external-identity synthetic binding, strict self-user binding, mirror-output creation tracking, JSON-embedded and collection created-id tracking, created-child sweeps with dependency-ordered deletes, read-only collaboration carve-out, fulfillment/recurrence resolution-decided sweeps, undeletable-created-object refusal. 8: trigger-null-tolerant fixture enrichment (a mint that faults in a managed BeforeInsert trigger retries once with nillable references populated from owned mints). */
export const FLOW_OWNED_SUBSTRATE_BUILDER_VERSION = 8;

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const FLOW_ROUTE = /^\/services\/data\/v(\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/;
/** Input-name suffixes documenting a live business reference. */
const REFERENCE_SUFFIX = /^(.{3,}?)(Id|ID|Key|Number|Nbr)$/;
/** Flow-variable Hungarian prefixes stripped before stem matching. */
const HUNGARIAN_PREFIX = /^(?:var|rvar|obj|rec|str|int|num|dt|bool|lst|col)(?=[A-Z_])/;
/** Bare generic stems that resolve no specific business object. */
const GENERIC_STEM = /^(?:record|object|input|value|data)s?$/i;
/** Approval-submission vocabulary (live approval acts are never probed). */
const APPROVAL_SUBMIT = /(?:approv|apprvl|appvl|authoriz)/i;
const APPROVAL_ACT = /(?:submit|orchestrat|request|email|review|decision)/i;
/** External-channel vocabulary no disposable substrate can absorb. Bare `text` alone is not a channel: consent documents (`authorization form text`) are records, not SMS. */
const EXTERNAL_CHANNEL = /(?:slack|chatter|teams|webex|zoom|sms|whatsapp|messaging.{0,20}channel|live.?message|\btext\b.{0,30}(?:message|messaging|sms)|(?:send|sending|message|messaging|sms).{0,30}\btext\b)/i;
/** External-meeting vocabulary: invites leave Salesforce with attendees attached. */
const EXTERNAL_MEETING = /(?:outlook|google\s*meet|attendee)/i;
/** External vendor-system vocabulary beyond the ITSM list (clearinghouse eligibility calls). */
const EXTERNAL_VENDOR_SYSTEM = /(?:clearinghouse)/i;
/** Prose-shaped inputs that can carry the ownership marker into created rows. */
const PROSE_INPUT = /(?:name|subject|descrip(?:tion)?|comment|text|title|label|note|reason|message|utterance)$/i;
/** Template-named reference inputs sampling one live configuration row (never business data). */
const TEMPLATE_INPUT = /template(?:id|name|sourceobjectid)?$/i;
/** External-identity input names: the value identifies a row outside Salesforce, never an owned fixture. */
const EXTERNAL_IDENTITY_NAME = /(?:external|sys_?id|systemid|correlation)(?:id|key|number|nbr)?$/i;
/** External-identity input descriptions documenting a non-Salesforce identifier. */
const EXTERNAL_IDENTITY_DOC = /(?:external\s+(?:system\s+)?(?:id|identifier|key)|sys_?id|systemid|correlation\s*id)/i;
/** Identity nouns bound to the integration user itself, reference-shaped only (prose `*Subject` lines keep the marker). */
const SELF_SHAPED_REFERENCE = /(?:subject|custodian|steward|assignee)/i;
/** Bare identity nouns bound to the integration user itself without any shape requirement. */
const SELF_BARE_NOUN = /^(?:owner|user|member|requester|submitter|sender|approver)$/i;
/** Person/channel-directed send evidence no read-only claim can excuse. */
const DIRECTED_SEND = /(?:send|deliver).{0,30}(?:message|survey|notification|customer|recipient|contact|sms|email|text)/i;
/** Description evidence of a record-state update (`sets the Status ... to Closed`). */
const SET_STATUS_DESCRIPTION = /\bsets?\b.{0,40}\bstatus\b/i;
/** Description evidence of a closed/complete state transition. */
const MARK_CLOSED_DESCRIPTION = /\bmarks?\b.{0,40}\b(closed|complete|completed)\b/i;
/** Message-shaped outputs carrying the flow's own generative verdict. */
const MESSAGE_OUTPUT = /(?:message|prompt|notice|result|summary|outcome|brief|recommendation)$/i;
/** Universal fallback object for bare generic record ids (platform vocabulary, validated live). */
const BARE_RECORD_FALLBACK_OBJECT = "Case";
/** Custom-notification vocabulary (bell notifications to a recipient). */
const NOTIFICATION_HINT = /(?:notif|bell)/i;
/** External ITSM-system vocabulary (the record lives outside Salesforce). */
const EXTERNAL_ITSYSTEM = /(?:servicenow|cmdb|bmc[\s_-]?remedy|zendesk|freshservice|cherwell|ivanti|jira|sys_?id|systemid)/i;
/** Tight creation claim for the scalar-create plan. */
const CREATE_CLAIM = /(?:creat|insert|generat|save|assign)/i;
/** Flow-description verbs proving the flow itself creates records. */
const CREATE_DESCRIPTION = /(?:creat|insert|generat)(?:s|es|d|ing)?\s+(?:a|an|the|\d+|one or more)?\s*\w*(?:record|order|case|contact|request|plan|voucher|shipment|transfer|reservation|campaign|consent|incident|entitlement|disbursement|swarm|channel)/i;
/** Record vocabulary proving an id-shaped input names a business record. */
const RECORD_DOCUMENTED = /(?:record|object|sobject|lookup|reference|related|account|contact|lead|case|order|opportunity|asset|product|user|member|owner|appointment|incident|request|campaign|swarm|candidate|participant|enrollee|benefit|consent|disbursement|brief|shipment|transfer|reservation|voucher|promotion|journal|entitlement|approval)/i;
/** Non-record description vocabulary allowing a synthetic filler for an id-shaped input. */
const NON_RECORD_DOCUMENTED = /(?:correlation|token|uuid|guid|code|number|name|email|phone|comment|reason|type|method|option|status|key\b)/i;
/**
 * Notification-type input vocabulary (name or description). Within a
 * notification-send plan a bare `notificationId` can only select the
 * notification type, since the instance does not exist before the send.
 */
const NOTIFICATION_TYPE_INPUT = /(?:notification.?(?:type|id)|template)/i;
/** User-identity input vocabulary bound to the integration user. */
const SELF_USER_INPUT = /(?:submitter|sender|owner|approver|requester|user|member)/i;
/** JSON-documented scalar inputs take an empty-document filler. */
const JSON_DOCUMENTED = /\bjson\b/i;
/** List-documented JSON inputs take an empty array instead of an object. */
const JSON_LIST_DOCUMENTED = /(\blist\b|\barray\b|\bcollection\b|\bmessages\b|\bcomponents\b|\bmembers\b|\bids\b|\brecords\b|\bitems\b|\bproducts\b)/i;
/**
 * Verbs whose side effect makes omission unsafe for read-only claims.
 * `send` counts only with a delivery target (prompt-template-internal
 * sends are read-only); `approv` counts as a verb form or with an
 * approval-act object (an "Approval Work Item" being summarized is not
 * an approval act).
 */
const MUTATING_VERB =
  /\b(creat|insert|generat|submit|deploy|publish|post|notif|authoriz|activat|schedul|updat|modif|delet|remov|cancel|archiv|merg|convert|transfer|stor|persist|sav(?:e|es|ing|ed)|writ|log|assign|clos(?:e|ing|ed)|orchestrat|appl(?:y|ies|ied)|start|refresh|reclaim|retire|provision|fulfill)\w*|\bsend.{0,30}(?:message|customer|recipient|contact|sms|email|text|notif|survey)|\bapprove[sd]?(?![a-z])|\bapproving\b|\bapproval\b.{0,30}(?:submit|request|orchestrat|email|review|decision|process)|\brequest.{0,20}(?:approv|submit|review|access|quote|grant|permission)/i;

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const record = (value: unknown): value is Value =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && SF_ID.test(value);

export type OwnedSubstratePlanKind = "owned_id_probe_via_auth" | "scalar_create_via_auth" | "notification_self_via_auth" | "creation_sweep_via_auth" | "read_probe_via_auth" | "delete_probe_via_auth";

export type OwnedSubstratePlan = {
  kind: OwnedSubstratePlanKind;
  idInputs?: string[];
  recordInputs?: Array<{ inputName: string; objectName: string }>;
  cleanupOutputs?: string[];
  recipientInputs?: string[];
  /** Runner-passed: bare generic record ids may fall back to an owned Case fixture (validated live). */
  allowBareRecordFallback?: boolean;
  /** Searcher-passed: creation claim limited to generative nouns (brief/summary/prompt/...). */
  generative?: boolean;
};

export type OwnedSubstrateTransport = (path: string, method?: string, body?: any) => Promise<Result>;
export type OwnedSubstrateBuild = (name: string, marker: string, values: Value) =>
  Promise<{ values: Value } | { failure: Result }>;

/** Strip Flow-variable Hungarian prefixes (`varCaseId` -> `CaseId`). */
export function stripHungarianPrefix(name: string): string {
  return name.replace(HUNGARIAN_PREFIX, "");
}

/** True when the input name documents a live business reference. */
export function isReferenceShaped(name: string): boolean {
  return REFERENCE_SUFFIX.test(stripHungarianPrefix(name));
}

/**
 * Reference stem for catalog matching (`varCaseId` -> `Case`). Null for
 * bare generic stems (`RecordId`) that resolve no specific business
 * object; the caller falls back to route/description object hints.
 */
export function referenceStem(name: string): string | null {
  const match = REFERENCE_SUFFIX.exec(stripHungarianPrefix(name));
  if (!match || GENERIC_STEM.test(match[1])) return null;
  return match[1];
}

/**
 * True when the input documents a business record (not a token/code).
 * External-identity inputs (external ids, sys_ids, correlation tokens)
 * never qualify; otherwise explicit record phrasing wins, a non-record
 * description allows a synthetic filler, multi-word stems presume a
 * business record, and single-word stems fall back to record-noun
 * vocabulary.
 */
export function inputDocumentsRecord(name: string, description: string | null | undefined): boolean {
  if (isExternalIdentityShaped(name, description)) return false;
  const text = `${name} ${description ?? ""}`;
  if (/(?:record|object|sobject|lookup|reference|related|\bids\b|\bid\b.{0,10}(?:of|for))/i.test(text)) return true;
  if (NON_RECORD_DOCUMENTED.test(description ?? "")) return false;
  const stem = referenceStem(name);
  const words = stem ? stem.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0) : [];
  if (words.length >= 2) return true;
  return RECORD_DOCUMENTED.test(text);
}

/**
 * Ordered object-name candidates for one scalar input, most to least
 * specific: normalized-stem exact, CamelCase n-grams of the input name,
 * route-tail token n-grams, then description keyword joins. Every
 * candidate is validated against the live EntityDefinition catalog plus
 * sObject describes; nothing here is trusted without that check.
 */
export function objectHintCandidates(
  inputName: string,
  inputDescription: string | null | undefined,
  route: string,
  flowDescription: string | null | undefined,
): string[] {
  const candidates: string[] = [];
  const push = (name: string): boolean => {
    if (name.length >= 64 || !FIELD_NAME.test(name) || GENERIC_STEM.test(name) ||
      /^(?:record|object|input|value|data)(?:id|key|number|nbr)?$/i.test(name) ||
      candidates.includes(name) || candidates.length >= 16) {
      return false;
    }
    candidates.push(name);
    return true;
  };
  const stem = referenceStem(inputName);
  if (stem) push(stem[0].toUpperCase() + stem.slice(1));
  const join = (tokens: string[]): string =>
    tokens.map((token) => token[0].toUpperCase() + token.slice(1).toLowerCase()).join("");
  const nameTokens = stripHungarianPrefix(inputName).replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/).filter((token) => token.length >= 2);
  let nameBudget = 4;
  for (let width = Math.min(3, nameTokens.length); width >= 1 && nameBudget > 0; width -= 1) {
    for (let start = 0; start + width <= nameTokens.length && nameBudget > 0; start += 1) {
      const joined = join(nameTokens.slice(start, start + width));
      if (!/^(id|key|number|nbr|record|input|value)$/i.test(joined) && push(joined)) nameBudget -= 1;
    }
  }
  const words = `${inputDescription ?? ""} ${flowDescription ?? ""}`.toLowerCase()
    .split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
  const stop = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "flow", "record", "records", "value", "values",
    "available", "input", "passed", "stores", "store", "used", "uses", "use", "variable", "identifier",
    "when", "specified", "specific", "next", "given", "current", "existing", "active"]);
  let descBudget = 8;
  for (const width of [2, 3, 1, 4]) {
    if (width > words.length || descBudget <= 0) continue;
    for (let start = 0; start + width <= words.length && descBudget > 0; start += 1) {
      const slice = words.slice(start, start + width);
      if (slice.some((token) => stop.has(token))) continue;
      if (push(join(slice))) descBudget -= 1;
    }
  }
  // Flow names lead with the verb and trail the object, so route n-grams
  // run back to front.
  const tailTokens = routeTailTokens(route);
  for (let width = Math.min(2, tailTokens.length); width >= 1; width -= 1) {
    for (let start = tailTokens.length - width; start >= 0; start -= 1) {
      const joined = join(tailTokens.slice(start, start + width));
      if (!/^(id|key|number|nbr|record|flow|action|update|create|close|process)$/i.test(joined)) push(joined);
    }
  }
  return candidates;
}

/** Route-tail tokens for back-to-front object n-grams (flow names lead with the verb and trail the object). */
function routeTailTokens(route: string): string[] {
  const tail = route.split("?")[0].split("/").at(-1) ?? "";
  return tail.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/).filter((token) => token.length >= 3);
}

/**
 * Ordered created-object candidates from a flow description plus route:
 * description keyword joins longest-first (a four-word join names the
 * created object more precisely than any shorter slice), each with a
 * singularized twin for plural prose ("line items" also tries
 * "LineItem"), then back-to-front route-tail n-grams. Every candidate
 * is validated against the live EntityDefinition catalog plus sObject
 * describes; nothing here is trusted without that check.
 */
export function createdObjectCandidates(
  flowDescription: string | null | undefined,
  route: string,
): string[] {
  const candidates: string[] = [];
  const push = (name: string): boolean => {
    if (name.length >= 64 || !FIELD_NAME.test(name) ||
      candidates.includes(name) || candidates.length >= 40) {
      return false;
    }
    candidates.push(name);
    return true;
  };
  const join = (tokens: string[]): string =>
    tokens.map((token) => token[0].toUpperCase() + token.slice(1).toLowerCase()).join("");
  const words = `${flowDescription ?? ""}`.toLowerCase()
    .split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
  const stop = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "flow", "record", "records", "value", "values",
    "available", "input", "passed", "stores", "store", "used", "uses", "use", "variable", "identifier",
    "when", "specified", "specific", "next", "given", "current", "existing", "active"]);
  const singular = (token: string): string | null =>
    token.endsWith("s") && token.length > 3 && !token.endsWith("ss") ? token.slice(0, -1) : null;
  const widthCaps = new Map([[4, 8], [3, 8], [2, 8], [1, 16]]);
  for (const width of [4, 3, 2, 1]) {
    if (width > words.length) continue;
    let pushed = 0;
    const cap = widthCaps.get(width) ?? 8;
    for (let start = 0; start + width <= words.length && pushed < cap; start += 1) {
      const slice = words.slice(start, start + width);
      if (slice.some((token) => stop.has(token))) continue;
      if (push(join(slice))) pushed += 1;
      const last = singular(slice[slice.length - 1]);
      if (last) push(join([...slice.slice(0, -1), last]));
    }
  }
  const tailTokens = routeTailTokens(route);
  for (let width = Math.min(2, tailTokens.length); width >= 1; width -= 1) {
    for (let start = tailTokens.length - width; start >= 0; start -= 1) {
      const joined = join(tailTokens.slice(start, start + width));
      if (!/^(id|key|number|nbr|record|flow|action|update|create|close|process)$/i.test(joined)) push(joined);
    }
  }
  return candidates;
}

/** True when a scalar input name is prose-shaped and can carry the ownership marker. */
export function isProseShaped(name: string): boolean {
  return typeof name === "string" && PROSE_INPUT.test(name);
}

/** True when a reference input name selects a configuration template (live-sampled, never business data). */
export function isTemplateShaped(name: string): boolean {
  return typeof name === "string" && TEMPLATE_INPUT.test(name);
}

/**
 * True when a reference input names an identity outside Salesforce (an
 * external-system id, sys_id, or correlation token). Such inputs bind
 * synthetic fillers and never resolve fixtures: no owned Salesforce row
 * can satisfy them, and borrowing a live row for one is forbidden.
 */
export function isExternalIdentityShaped(name: string, description: string | null | undefined): boolean {
  if (typeof name !== "string") return false;
  if (EXTERNAL_IDENTITY_NAME.test(name)) return true;
  return EXTERNAL_IDENTITY_DOC.test(description ?? "");
}

/**
 * True when an input carries the probe's own user identity: a bare
 * identity noun (`owner`), or a user-identity noun in a
 * reference-shaped or id-documented name (`recordOwner` + "The Owner Id
 * of the record", `custodyItemSubjectID`, `custodianID`). Deliberately
 * stricter than substring matching: prose `*Subject`/`*MemberName`
 * lines never qualify, so without reference shape or id documentation
 * the input keeps the ownership marker instead of the integration user
 * id.
 */
export function isSelfUserShaped(name: string, description: string | null | undefined): boolean {
  if (typeof name !== "string") return false;
  if (SELF_BARE_NOUN.test(name)) return true;
  if (!SELF_USER_INPUT.test(name) && !(isReferenceShaped(name) && SELF_SHAPED_REFERENCE.test(name))) return false;
  if (isReferenceShaped(name)) return true;
  return /(\bid\b|\bidentifier\b)/i.test(description ?? "");
}

/**
 * True when a reference input consumes an owned fixture. Template-shaped
 * inputs sample live configuration instead, so they never count toward
 * fixture-anchor bounds (a sweep anchored only by a template plus a bare
 * generic id still qualifies for the bare-record fallback).
 */
export function countsAsFixtureReference(inputName: string): boolean {
  return !isTemplateShaped(inputName);
}

/**
 * True when the route tail or description evidences a record-state
 * update: update/close/cancel route vocabulary, a whole-word `set` step
 * in the tail, or description evidence (`updates ... status`, `sets the
 * Status ... to Closed`, `marks ... complete`). Credential contexts stay
 * the caller's guard; this reports update evidence only.
 */
export function flowDeclaresUpdate(tail: string, description: string | null | undefined): boolean {
  if (typeof tail !== "string") return false;
  if (/(?:update|close|cancel)/i.test(tail)) return true;
  const words = tail.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
  if (words.includes("set")) return true;
  const text = `${tail} ${description ?? ""}`;
  return /\bupdat\w*\b.{0,60}\b(record|field|status)\b/i.test(text) ||
    SET_STATUS_DESCRIPTION.test(text) || MARK_CLOSED_DESCRIPTION.test(text);
}

/**
 * Salesforce ids embedded in one output value: bare ids, record id
 * fields, arrays of either, and JSON documents walked to a bounded
 * depth. Only identity-shaped strings surface; every candidate still
 * needs probe-window creation proof before any delete.
 */
export function extractEmbeddedIds(value: unknown, depth = 0): string[] {
  const found: string[] = [];
  const push = (id: unknown): void => {
    if (typeof id === "string" && SF_ID.test(id) && !found.includes(id) && found.length < 25) found.push(id);
  };
  const walk = (entry: unknown, level: number): void => {
    if (found.length >= 25 || level > 4) return;
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (SF_ID.test(trimmed)) {
        push(trimmed);
        return;
      }
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
          walk(JSON.parse(trimmed), level + 1);
        } catch {
          /* Opaque string; not evidence. */
        }
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry.slice(0, 25)) walk(item, level + 1);
      return;
    }
    if (record(entry)) {
      push(entry.Id);
      for (const item of Object.values(entry).slice(0, 25)) walk(item, level + 1);
    }
  };
  walk(value, depth);
  return found;
}

/**
 * Order cleanup targets so objects referencing other targets delete
 * first (children before parents). Bounded relaxation over live
 * describe `referenceTo` evidence; cycles and unrelated targets keep
 * their relative order.
 */
export function orderCleanupTargets<T extends { objectName: string; references: string[] }>(targets: T[]): T[] {
  const names = new Set(targets.map((target) => target.objectName));
  const rank = new Map(targets.map((target) => [target.objectName, 0]));
  for (let pass = 0; pass < targets.length; pass += 1) {
    for (const target of targets) {
      for (const ref of target.references) {
        if (ref !== target.objectName && names.has(ref)) {
          rank.set(target.objectName, Math.max(rank.get(target.objectName) ?? 0, (rank.get(ref) ?? 0) + 1));
        }
      }
    }
  }
  return [...targets].sort((a, b) => (rank.get(b.objectName) ?? 0) - (rank.get(a.objectName) ?? 0));
}

/**
 * First active picklist value for an input from live describe fields: the
 * field whose API name matches the input name case-insensitively must
 * expose active picklist values. Null when the input is unconstrained.
 */
export function livePicklistChoice(fields: Value[], inputName: string): string | null {
  const want = String(inputName ?? "").toLowerCase();
  const field = Array.isArray(fields) ? fields.find((entry) =>
    record(entry) && typeof entry.name === "string" && entry.name.length >= 3 &&
    want.endsWith(entry.name.toLowerCase()) && Array.isArray(entry.picklistValues)) : null;
  if (!field) return null;
  const values = (field.picklistValues as unknown[]).filter((entry): entry is Value => record(entry));
  const choice = values.find((entry) => typeof entry.value === "string" && entry.value && entry.active !== false);
  return choice ? String(choice.value) : null;
}

/** First active descriptor-declared picklist value for a flow input (live descriptor evidence). */
export function descriptorPicklistChoice(field: Value): string | undefined {
  const raw = field as Value & { values?: unknown; picklistValues?: unknown };
  const candidates = Array.isArray(raw.values) ? raw.values : Array.isArray(raw.picklistValues) ? raw.picklistValues : [];
  for (const entry of candidates) {
    if (typeof entry === "string" && entry) return entry;
    if (record(entry) && typeof entry.value === "string" && entry.value && entry.active !== false) return entry.value;
  }
  return undefined;
}

/** Neutral filler for non-reference scalar inputs (JSON-aware). */
export function neutralOwnedValue(type: string | null | undefined, description: string | null | undefined): unknown {
  switch ((type ?? "STRING").toUpperCase()) {
    case "BOOLEAN": return false;
    case "INTEGER":
    case "INT":
    case "DOUBLE":
    case "DECIMAL":
    case "CURRENCY":
    case "PERCENT": return 0;
    case "DATE": return "1970-01-01";
    case "DATETIME": return "1970-01-01T00:00:00.000Z";
    case "TIME": return "00:00:00.000Z";
    default: {
      const documented = description ?? "";
      if (JSON_DOCUMENTED.test(documented)) return JSON_LIST_DOCUMENTED.test(documented) ? "[]" : "{}";
      return `probe-nonexistent-${crypto.randomUUID()}`;
    }
  }
}

/**
 * Rank live catalog names against ordered hint candidates without naming
 * any object: earlier candidates win, exact beats containment, shorter
 * names win ties. Returns the single best validated hit, else null.
 */
export function rankHintCandidates(candidates: string[], liveNames: string[]): string | null {
  const live = new Set(liveNames.filter((name) => FIELD_NAME.test(name)));
  for (const candidate of candidates) {
    if (live.has(candidate)) return candidate;
  }
  const lowered = [...live].map((name) => ({ name, lower: name.toLowerCase() }));
  for (const candidate of candidates) {
    const want = candidate.toLowerCase();
    const hits = lowered.filter((entry) => entry.lower === want || entry.lower.endsWith(want) || entry.lower.startsWith(want));
    if (hits.length === 0) continue;
    hits.sort((a, b) => a.name.length - b.name.length);
    return hits[0].name;
  }
  return null;
}

/** Qualified object names from an EntityDefinition candidate query body. */
export function entityDefinitionNames(body: unknown): string[] {
  if (!record(body) || !Array.isArray(body.records)) return [];
  return body.records.filter(record).map((row) => row.QualifiedApiName)
    .filter((name): name is string => typeof name === "string" && FIELD_NAME.test(name));
}

/**
 * Number-shaped value from an owned fixture readback: a `*Number`/`*Nbr`
 * field first, else the Name field, else the id. Never invented.
 */
export function fixtureNumberValue(actual: Value, fallbackId: string): unknown {
  const numbered = Object.keys(actual).find((field) =>
    /(?:number|nbr)$/i.test(field) && (typeof actual[field] === "string" || typeof actual[field] === "number") &&
    String(actual[field]).length > 0);
  if (numbered) return actual[numbered];
  if (typeof actual.Name === "string" && actual.Name.length > 0) return actual.Name;
  return fallbackId;
}

/**
 * True when the descriptor proves a read-only flow: no callout,
 * scalar-only non-Flow outputs, and no mutating verb in the route,
 * description, or any input name/description. Read-only-evident flows may
 * use live rows and live names, since no probe input can trigger a
 * mutation path.
 *
 * Flow/object names join verb stems with underscores or camel humps
 * (`..._Update_...`, `updateStatus`), which `\b` cannot see, so the
 * haystack is split into tokens before testing: mutation evidence in the
 * route or input names always disqualifies the read-only claim, even when
 * the descriptor carries no description.
 */
export function isReadOnlyEvident(descriptor: unknown, route: string): boolean {
  if (!record(descriptor) || typeof route !== "string" || !route.includes("/actions/custom/flow/")) return false;
  if ((descriptor as Value).hasCallout === true) return false;
  const inputs = descriptorFields(descriptor, "inputs");
  const outputs = descriptorFields(descriptor, "outputs");
  if (outputs.some((field) => field.type === "SOBJECT" && typeof field.name === "string" && !field.name.toLowerCase().startsWith("flow__"))) {
    return false;
  }
  const tail = route.split("?")[0].split("/").at(-1) ?? "";
  const haystack = [
    tail,
    typeof (descriptor as Value).description === "string" ? (descriptor as Value).description as string : "",
    ...inputs.map((field) => `${field.name} ${typeof field.description === "string" ? field.description : ""}`),
  ].join(" ");
  const tokenized = haystack.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return !MUTATING_VERB.test(tokenized);
}

/** True when the single Flow execution result reports a Finished interview. */
export function interviewFinished(body: unknown): boolean {
  if (!Array.isArray(body) || body.length !== 1 || !record(body[0])) return false;
  const outputs = record(body[0].outputValues) ? body[0].outputValues as Value : null;
  if (!outputs) return true;
  const status = outputs.Flow__InterviewStatus;
  return status === undefined || status === null || status === "Finished";
}

/**
 * Gate an owned-substrate response on the real Salesforce outcome. Success
 * requires native success, a Finished interview, and no failure text in
 * any non-Flow output value. Anything else is an explicit failure.
 */
export function assessOwnedSubstrateOutcome(status: number, body: unknown): {
  ok: boolean; code: string; message: string; outputValues: Value;
} {
  const fail = (code: string, message: string, outputValues: Value = {}): {
    ok: boolean; code: string; message: string; outputValues: Value;
  } => ({ ok: false, code, message, outputValues });
  if (!nativeActionSucceeded(status, body)) {
    return fail("FLOW_OWNED_PROBE_EXECUTION_FAILED", "Salesforce did not report owned-substrate execution success.");
  }
  const outputs = record((body as Value[])[0]?.outputValues) ? (body as Value[])[0].outputValues as Value : {};
  if (!interviewFinished(body)) {
    return fail("FLOW_OWNED_PROBE_EXECUTION_FAILED", "The Flow interview did not finish.", outputs);
  }
  for (const [name, value] of Object.entries(outputs)) {
    if (name === "Flow__InterviewGuid" || name === "Flow__InterviewStatus") continue;
    const snippet = flowOutputFailureSnippet(value);
    if (snippet) {
      return fail("FLOW_OWNED_PROBE_OUTPUT_FAILED",
        `The Flow reported its own operation failed (${String(value).slice(0, 200)}).`, outputs);
    }
  }
  return { ok: true, code: "FLOW_OWNED_PROBE_ACCEPTED", message: "The Flow interview finished with native success.", outputValues: outputs };
}

/**
 * Evidence-fed execution-fault diagnosis for a failed owned-substrate
 * invoke. Runs only when the invoke response already matches the opaque
 * execution-fault shape (no extra reads otherwise), then gathers bounded
 * independent evidence — flow-metadata references checked against the
 * live actions descriptor, the ApexClass table, and cached describes —
 * and re-diagnoses. Unverifiable reads keep the generic stamp; transport
 * failures never replace the assessed failure. Returns null for
 * non-opaque failures so other fault shapes keep their verdicts.
 */
/**
 * Planner-only taxonomy stamp for assessed flow-owned output text,
 * restricted to the R5 setup/input branches (upstream access-denial
 * outputs, missing-setup-record outputs). The assessed code stays stable
 * either way; any other shape keeps a null stamp exactly as before.
 * Pure: no reads, no logging. Exported for the colocated contract test.
 */
export function diagnoseSubstrateOutputText(assessed: { outputValues: Value }): ManagedFlowFault | null {
  const outputs = record(assessed?.outputValues) ? assessed.outputValues as Value : null;
  if (!outputs) return null;
  const texts: string[] = [];
  for (const [name, value] of Object.entries(outputs)) {
    if (name.toLowerCase().startsWith("flow__")) continue;
    if (typeof value === "string" && value.length > 0 && value.length <= 500) texts.push(value);
  }
  if (!texts.length) return null;
  const fault = classifyManagedFlowFault({ status: 200, messages: texts, codes: [], envelopeSucceeded: true });
  return fault && (fault.code === "FLOW_UPSTREAM_ACCESS_REQUIRED" || fault.code === "FLOW_SETUP_RECORD_REQUIRED")
    ? fault
    : null;
}

async function diagnoseSubstrateExecutionFault(input: {
  root: string;
  route: string;
  status: number;
  body: unknown;
  request: OwnedSubstrateTransport;
  describes: Map<string, Value>;
  cache: FlowExecutionEvidenceCache;
}): Promise<ManagedFlowFault | null> {
  try {
    const bare = diagnoseFlowExecutionFault({ status: input.status, body: input.body });
    if (!bare || bare.code !== "MANAGED_FLOW_EXECUTION_FAULT") return null;
    const tail = input.route.split("?")[0].split("/").at(-1) ?? "";
    const refs = await fetchFlowMetadataReferences({
      root: input.root, flowName: tail, request: input.request, cache: input.cache,
    });
    if (!refs || (refs.invocables.length === 0 && refs.schemaRefs.length === 0)) return bare;
    input.cache.describes ??= new Map();
    for (const [objectName, schema] of input.describes) {
      if (!input.cache.describes.has(objectName)) {
        const fields = describeFieldNames(schema);
        if (fields) input.cache.describes.set(objectName, fields);
      }
    }
    const evidence = await collectFlowExecutionEvidence({
      root: input.root, request: input.request,
      invocables: refs.invocables, schemaRefs: refs.schemaRefs, cache: input.cache,
    });
    return diagnoseFlowExecutionFault({ status: input.status, body: input.body, evidence }) ?? bare;
  } catch {
    return null;
  }
}

export type OwnedSubstrateInput = {
  root: string;
  route: string;
  plan: OwnedSubstratePlan;
  /** Live integration user id; notifications and self-identity inputs bind only this. */
  integrationUserId: string;
  verificationWindowMs?: number;
  request: OwnedSubstrateTransport;
  build: OwnedSubstrateBuild;
  now?: () => number;
};

const fail = (errorCode: string, message: string, extra?: Value): Result => ({
  status: 422, ok: false, body: { errorCode, message, ...extra },
});

const descriptorFields = (body: unknown, key: string): Value[] =>
  record(body) && Array.isArray((body as Value)[key]) ? ((body as Value)[key] as unknown[]).filter(record) : [];

/** True when the flow description proves the flow itself creates records. */
function declaresCreation(tail: string, description: string): boolean {
  return CREATE_CLAIM.test(tail) || CREATE_DESCRIPTION.test(description);
}

/** Wide creation claim matching the searcher's terminal taxonomy (any create/insert/save/assign vocabulary). */
function isWideCreation(tail: string, description: string): boolean {
  return CREATE_CLAIM.test(tail) || CREATE_CLAIM.test(description);
}

export async function invokeOwnedSubstrate(input: OwnedSubstrateInput): Promise<{
  status: number; body: any; cleanupError?: string; contextSchema?: Value;
}> {
  const { root, request, plan } = input;
  const now = input.now ?? Date.now;
  const match = typeof input.route === "string" ? input.route.match(FLOW_ROUTE) : null;
  const automaticSteps = [
    "Re-derive the live descriptor and validate the substrate plan against it",
    "Resolve every reference input to a live object via EntityDefinition plus describes",
    "Plan, create, and read back the owned fixture graph",
    "Invoke once with fixture identities bound and gate on the real outcome",
    "Delete created rows through id/record outputs with probe-window proof",
    "Delete every fixture with ownership-scoped cleanup and sweep residue",
  ];
  const base = { source: "salesforce_live_flow_owned_substrate", planKind: plan?.kind, automaticSteps };
  const done = (outcome: Result, extra: Value): { status: number; body: any; cleanupError?: string; contextSchema?: Value } => ({
    status: outcome.status, body: outcome.body,
    ...(typeof extra.cleanupError === "string" ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...base, ...extra },
  });
  if (!match || !root.startsWith("/services/data/") || !input.route.startsWith(`${root}/actions/`)) {
    return done(fail("FLOW_OWNED_ROUTE_INVALID", "A discovered custom Flow route under the API root is required."), { verified: false });
  }
  if (!plan || !["owned_id_probe_via_auth", "scalar_create_via_auth", "notification_self_via_auth",
    "creation_sweep_via_auth", "read_probe_via_auth", "delete_probe_via_auth"].includes(plan.kind)) {
    return done(fail("FLOW_OWNED_PLAN_INVALID", "A validated owned-substrate plan is required."), { verified: false });
  }
  const sweepPlan = plan.kind === "creation_sweep_via_auth";
  const readPlan = plan.kind === "read_probe_via_auth";
  const deletePlan = plan.kind === "delete_probe_via_auth";
  if (!identity(input.integrationUserId)) {
    return done(fail("FLOW_OWNED_IDENTITY_INVALID", "A live integration user identity is required; none is ever guessed."), { verified: false });
  }
  const tail = match[2];
  const marker = `AS owned ${crypto.randomUUID()}`;
  const owned: OwnedRecord[] = [];
  const scopes: OwnershipScope[] = [];
  const fixtureIds: Record<string, string> = {};
  const actuals: Record<string, Value> = {};
  const createdChildren: OwnedRecord[] = [];
  const sweepTargets: Array<{ objectName: string; nameField: string | null; parentFields: string[]; references: string[] }> = [];
  const omittedInputs: string[] = [];
  const absenceNotes: string[] = [];
  const fixtureEmails: string[] = [];
  const fixtureContactIds: string[] = [];
  const mappings: Array<{ inputName: string; objectName: string }> = [];
  let cleanupError: string | undefined;
  let outcome: Result = fail("FLOW_OWNED_CONTEXT_UNAVAILABLE", "The owned flow substrate context could not be prepared.");
  let executionFault: ManagedFlowFault | null = null;
  let repairPlan: ReturnType<typeof planFlowFaultRepair> = null;
  let agentRepairAttempt: Value | null = null;
  const evidenceCache: FlowExecutionEvidenceCache = {};
  let verified = false;
  let residueSweep: unknown = null;
  let nativeAttempted = false;
  const probeStart = now();
  try {
    outcome = await (async (): Promise<Result> => {
      const descriptor = await request(input.route);
      if (!descriptor.ok) return descriptor;
      const inputs = descriptorFields(descriptor.body, "inputs");
      const outputs = descriptorFields(descriptor.body, "outputs");
      if (!Array.isArray((descriptor.body as Value)?.inputs) || !Array.isArray((descriptor.body as Value)?.outputs)) {
        return fail("FLOW_OWNED_DESCRIPTOR_INVALID", "The live Flow descriptor does not declare input and output lists.");
      }
      const allowed = new Set(inputs.map((field) => field.name));
      const flowDescription = typeof (descriptor.body as Value)?.description === "string"
        ? (descriptor.body as Value).description as string : "";
      const inputText = inputs.map((field) => `${field.name} ${typeof field.description === "string" ? field.description : ""}`).join(" ");
      const haystack = `${tail} ${flowDescription} ${inputText}`;
      if (APPROVAL_SUBMIT.test(`${tail} ${flowDescription}`) && APPROVAL_ACT.test(haystack)) {
        return fail("FLOW_APPROVAL_SUBMISSION_UNSUPPORTED",
          "The flow submits or orchestrates a live approval act and approvals on live records must never be probed.");
      }
      // Read-only-evident reads never ride a mutation path, so collaboration
      // nouns alone (Slack app ids, channel names) do not prove an external
      // send substrate the way they do for mutating plans. Directed sends,
      // meetings, vendor systems, and callouts stay absolute, and ITSM
      // vocabulary is excused only when the route and description are
      // clean and every ITSM-evidencing input binds a synthetic
      // external-identity filler: the probe then reads nothing live
      // anywhere, and the outcome gate still decides honestly.
      const itsystemInputs = inputs.filter((field) => typeof field.name === "string" &&
        EXTERNAL_ITSYSTEM.test(`${field.name} ${typeof field.description === "string" ? field.description : ""}`));
      const itsystemContained = itsystemInputs.every((field) =>
        isExternalIdentityShaped(field.name, typeof field.description === "string" ? field.description : null));
      const readOnlyCarveOut = readPlan && isReadOnlyEvident(descriptor.body, input.route) &&
        !DIRECTED_SEND.test(haystack) && !EXTERNAL_MEETING.test(haystack) &&
        !EXTERNAL_VENDOR_SYSTEM.test(haystack) &&
        !EXTERNAL_ITSYSTEM.test(`${tail} ${flowDescription}`) && itsystemContained &&
        (descriptor.body as Value)?.hasCallout !== true;
      if (!readOnlyCarveOut && (EXTERNAL_CHANNEL.test(haystack) ||
        EXTERNAL_ITSYSTEM.test(`${flowDescription} ${inputText}`) ||
        (descriptor.body as Value)?.hasCallout === true)) {
        return fail("FLOW_FALLBACK_EXTERNAL_SUBSTRATE_UNSUPPORTED",
          "The flow reaches external messaging/channel/system substrate and no disposable external channel exists to absorb a probe.");
      }
      if (sweepPlan) {
        const meeting = haystack.match(EXTERNAL_MEETING)?.[0] ?? null;
        if (meeting) {
          return fail("FLOW_FALLBACK_EXTERNAL_SUBSTRATE_UNSUPPORTED",
            `The flow creates an external meeting ('${meeting.toLowerCase()}') with invites no disposable substrate can absorb.`);
        }
        const vendor = haystack.match(EXTERNAL_VENDOR_SYSTEM)?.[0] ?? null;
        if (vendor) {
          return fail("FLOW_FALLBACK_EXTERNAL_SUBSTRATE_UNSUPPORTED",
            `The flow calls the external '${vendor.toLowerCase()}' vendor system; no disposable counterpart exists to absorb a probe.`);
        }
        // Fulfillment and recurrence vocabulary no longer refuses upfront:
        // flows whose created rows are queryable, deletable, ownership-
        // provable internal records sweep like any other creation. The
        // target-resolution and ownership gates below still refuse honestly
        // when the created substrate cannot be owned.
        if (!declaresCreation(tail, flowDescription) && !isWideCreation(tail, flowDescription)) {
          return fail("FLOW_OWNED_PLAN_INVALID", "A creation-sweep plan requires a creation-declared flow; the descriptor drifted.");
        }
      }
      const fieldByName = (name: string): Value | undefined => inputs.find((field) => field.name === name);
      const planIdInputs = (plan.idInputs ?? []).filter((name) => typeof name === "string" && FIELD_NAME.test(name) && allowed.has(name));
      const planRecordInputs = (plan.recordInputs ?? []).filter((entry) =>
        entry && FIELD_NAME.test(entry.inputName) && allowed.has(entry.inputName) &&
        fieldByName(entry.inputName)?.type === "SOBJECT");
      const planRecipients = (plan.recipientInputs ?? []).filter((name) => typeof name === "string" && FIELD_NAME.test(name) && allowed.has(name));
      if (plan.kind === "notification_self_via_auth" && planRecipients.length === 0) {
        return fail("FLOW_OWNED_PLAN_INVALID", "The notification plan names no live recipient input; the flow addresses recipients internally.");
      }
      // Anchorless sweeps and reads are sound without fixtures: a sweep
      // proves created-row ownership through the exact prose marker plus
      // the probe window, and a read binds only synthetic or neutral
      // values, so no live row ever rides a probe input. The ownership
      // and outcome gates below still decide honestly.
      if (plan.kind !== "scalar_create_via_auth" && plan.kind !== "notification_self_via_auth" &&
        plan.kind !== "creation_sweep_via_auth" && plan.kind !== "read_probe_via_auth" &&
        planIdInputs.length + planRecordInputs.length === 0) {
        return fail("FLOW_OWNED_PLAN_INVALID", "The substrate plan names no live reference or record input to own.");
      }
      const required = inputs.filter((field) => field.required === true);
      if (required.length > 0) {
        return fail("FLOW_FALLBACK_REQUIRED_INPUT_UNRESOLVED",
          `Required input '${required[0].name}' has no live reference to resolve it from.`);
      }
      // Resolve reference inputs to live objects before creating anything.
      const targets = new Map<string, string>();
      const synthetic: Record<string, unknown> = {};
      const selfBound: Record<string, string> = {};
      const templateNeeds: Array<{ inputName: string; objectName: string }> = [];
      const tried: string[] = [];
      const candidateLists = new Map<string, string[]>();
      if (plan.allowBareRecordFallback === true) tried.push(BARE_RECORD_FALLBACK_OBJECT);
      for (const name of planIdInputs) {
        const field = fieldByName(name);
        const fieldDescription = typeof field?.description === "string" ? field.description : null;
        const single = typeof field?.maxOccurs !== "number" || field.maxOccurs <= 1;
        // Every plan binds self-user-shaped references to the integration
        // user itself, never a minted User: the probe acts as its own
        // identity, which is contained on every plan kind.
        if (single && isSelfUserShaped(name, fieldDescription)) {
          selfBound[name] = input.integrationUserId;
          continue;
        }
        // External-identity references (external ids, sys_ids, correlation
        // tokens) identify rows outside Salesforce; no fixture can satisfy
        // them, so every plan sends a synthetic filler instead of borrowing
        // a live row.
        if (single && isExternalIdentityShaped(name, fieldDescription)) {
          synthetic[name] = neutralOwnedValue(typeof field?.type === "string" ? field.type : null, fieldDescription);
          continue;
        }
        // Read probes send synthetic lookup keys; live keys are never borrowed for any flow.
        if (readPlan && /Key$/i.test(name)) {
          synthetic[name] = `probe-nonexistent-${crypto.randomUUID()}`;
          continue;
        }
        const candidates = objectHintCandidates(name,
          typeof field?.description === "string" ? field.description : null, input.route, flowDescription);
        candidateLists.set(name, candidates);
        for (const candidate of candidates) if (!tried.includes(candidate)) tried.push(candidate);
      }
      const exactSoql = tried.length
        ? `SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName IN (${tried.map((name) => `'${name}'`).join(",")})`
        : null;
      const exact = exactSoql ? await request(`${root}/query?q=${encodeURIComponent(exactSoql)}`) : null;
      if (exact && !exact.ok) return exact;
      const liveNames = exact ? entityDefinitionNames(exact.body) : [];
      for (const name of planIdInputs) {
        if (selfBound[name] !== undefined || synthetic[name] !== undefined) continue;
        const field = fieldByName(name);
        const stem = referenceStem(name);
        const genericStem = !stem || GENERIC_STEM.test(stem);
        // Bare fallback and omission apply only to id-shaped inputs (`*Id`, `*Key`,
        // singularized for collections); name-shaped misses (`*Name`) keep the precise
        // terminal (live-name sampling already failed upstream; an id would be a shape
        // violation).
        const stripped = stripHungarianPrefix(name);
        const idShaped = REFERENCE_SUFFIX.test(stripped) || REFERENCE_SUFFIX.test(stripped.replace(/s$/i, ""));
        const documentsRecord = inputDocumentsRecord(name,
          typeof field?.description === "string" ? field.description : null);
        const hit = rankHintCandidates(candidateLists.get(name) ?? [], liveNames);
        if (hit) {
          // Template-named sweep inputs sample one live configuration row instead of minting a fixture.
          if (sweepPlan && isTemplateShaped(name)) {
            templateNeeds.push({ inputName: name, objectName: hit });
            continue;
          }
          targets.set(name, hit);
          continue;
        }
        if (stem && !GENERIC_STEM.test(stem)) {
          const like = await request(`${root}/query?q=${encodeURIComponent(
            `SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName LIKE '%${stem}%' LIMIT 50`)}`);
          if (!like.ok) return like;
          const ranked = rankHintCandidates(candidateLists.get(name) ?? [], entityDefinitionNames(like.body));
          if (ranked) {
            if (sweepPlan && isTemplateShaped(name)) {
              templateNeeds.push({ inputName: name, objectName: ranked });
              continue;
            }
            targets.set(name, ranked);
            continue;
          }
        }
        // Bare generic record ids fall back to an owned Case fixture when the plan allows it
        // and the live catalog validates Case; the fixture is created and cleaned like any other.
        if (plan.allowBareRecordFallback === true && idShaped && genericStem && documentsRecord &&
          liveNames.includes(BARE_RECORD_FALLBACK_OBJECT)) {
          targets.set(name, BARE_RECORD_FALLBACK_OBJECT);
          continue;
        }
        if (documentsRecord) {
          // Optional generic id-shaped misses omit (discovery-minimal: the flow receives
          // less, never a guess); specific-stem and name-shaped misses keep the precise
          // terminal (grant or substrate signal).
          if (field?.required !== true && idShaped && genericStem) {
            omittedInputs.push(name);
            continue;
          }
          const shown = (candidateLists.get(name) ?? []).slice(0, 6).join(", ");
          return fail("FLOW_RECORD_TARGET_ABSENT",
            `Reference input '${name}' resolves to no live object (tried ${shown || "no usable hint"} against the live catalog); the flow cannot run without it.`);
        }
        synthetic[name] = neutralOwnedValue(typeof field?.type === "string" ? field.type : null,
          typeof field?.description === "string" ? field.description : null);
      }
      // Record inputs resolve through the same live catalog (never assumed).
      for (const entry of planRecordInputs) {
        const field = fieldByName(entry.inputName);
        const declared = typeof field?.sObjectType === "string" && FIELD_NAME.test(field.sObjectType) ? field.sObjectType : null;
        if (!declared) {
          return fail("FLOW_RECORD_TARGET_ABSENT",
            `Record input '${entry.inputName}' declares no usable object type; no typed contract can be inferred.`);
        }
        if (!liveNames.includes(declared)) {
          const check = await request(`${root}/query?q=${encodeURIComponent(
            `SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName IN ('${declared}')`)}`);
          if (!check.ok) return check;
          if (!entityDefinitionNames(check.body).includes(declared)) {
            return fail("FLOW_RECORD_TARGET_ABSENT",
              `Record input '${entry.inputName}' declares '${declared}', absent from the live org schema; the flow cannot run without it.`);
          }
        }
        targets.set(entry.inputName, declared);
      }
      // Creation with no cleanable output would leak: refuse before any write,
      // unless this is a creation sweep with resolvable, ownership-provable targets.
      // On creation-declared flows a mirror SOBJECT output counts as cleanable:
      // the flow-created row rides the same-named variable, so tracking it
      // deletes only probe-window rows while fixture echoes stay explained.
      const creationDeclared = declaresCreation(tail, flowDescription) || (sweepPlan && isWideCreation(tail, flowDescription));
      const mirrorOutput = (output: Value): boolean =>
        inputs.some((item) => item.type === "SOBJECT" && typeof item.name === "string" &&
          typeof output.name === "string" && item.name.toLowerCase() === output.name.toLowerCase());
      const cleanableOutputs = outputs.filter((output) => typeof output.name === "string" &&
        !output.name.toLowerCase().startsWith("flow__") && (creationDeclared || !mirrorOutput(output)) &&
        (output.type === "SOBJECT" || output.type === "ID" ||
          ((output.type ?? "STRING") === "STRING" && /^(?!flow__)(.{1,60}?)(Id|ID|Key)s?$/.test(output.name))));
      // On creation-declared flows every stringish output may embed a
      // created identity (structured JSON metadata under a free-form
      // name), so extraction scans them all; probe-window proof still
      // decides every candidate, and the narrow gate above still routes
      // output-less creations to the sweep.
      const scannableOutputs = creationDeclared
        ? outputs.filter((output) => typeof output.name === "string" &&
          !output.name.toLowerCase().startsWith("flow__") &&
          (output.type === "SOBJECT" || ["STRING", "TEXT", "TEXTAREA", "ID"].includes((output.type ?? "STRING").toUpperCase())))
        : cleanableOutputs;
      const sweepTried: string[] = [];
      if (creationDeclared && cleanableOutputs.length === 0) {
        if (!sweepPlan) {
          return fail("FLOW_CREATED_CHILD_UNTRACKED",
            "The flow declares creation with no id/record output to delete the created rows through, so created rows would leak outside fixture scope.");
        }
        // Resolve created-row sweep targets from live catalog evidence: exact
        // description/route candidates first, then keyword containment.
        const sweepCandidates = createdObjectCandidates(flowDescription, input.route);
        for (const candidate of sweepCandidates) if (!sweepTried.includes(candidate)) sweepTried.push(candidate);
        const sweepExact = sweepCandidates.length
          ? await request(`${root}/query?q=${encodeURIComponent(
            `SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName IN (${sweepCandidates.map((name) => `'${name}'`).join(",")})`)}`)
          : null;
        if (sweepExact && !sweepExact.ok) return sweepExact;
        const sweepLive = sweepExact ? entityDefinitionNames(sweepExact.body) : [];
        const sweepResolved: string[] = [];
        const sweepExactNames = new Set<string>();
        for (const candidate of sweepCandidates) {
          if (sweepResolved.length >= 3) break;
          if (sweepLive.includes(candidate) && !sweepResolved.includes(candidate)) {
            sweepResolved.push(candidate);
            sweepExactNames.add(candidate);
          }
        }
        const stopWords = new Set(["flow", "flows", "record", "records", "input", "inputs", "value", "values",
          "using", "used", "uses", "passed", "flow__", "with", "from", "that", "this", "into", "over"]);
        const keywords = `${tail} ${flowDescription}`.toLowerCase().split(/[^a-z0-9]+/)
          .filter((token) => token.length >= 4 && !stopWords.has(token))
          .filter((token, at, all) => all.indexOf(token) === at).slice(0, 4);
        for (const keyword of keywords) {
          if (sweepResolved.length >= 3) break;
          if (!/^[a-z0-9]+$/.test(keyword)) continue;
          const like = await request(`${root}/query?q=${encodeURIComponent(
            `SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName LIKE '%${keyword}%' LIMIT 50`)}`);
          if (!like.ok) return like;
          const hits = entityDefinitionNames(like.body)
            .filter((name) => name.toLowerCase().includes(keyword) && !sweepResolved.includes(name))
            .sort((a, b) => a.length - b.length);
          for (const name of hits) {
            if (sweepResolved.length >= 3) break;
            sweepResolved.push(name);
          }
        }
        // Ownership proof before any write: a prose input to carry the marker,
        // or a sweep-target lookup to an owned fixture object. Template objects
        // never prove ownership (live shared rows reference them too).
        const fixtureObjects = new Set(targets.values());
        const boundNames = new Set([...targets.keys(), ...Object.keys(selfBound), ...Object.keys(synthetic),
          ...templateNeeds.map((need) => need.inputName), ...omittedInputs]);
        const markerInputs = inputs.filter((field) => typeof field.name === "string" &&
          !boundNames.has(field.name) && isProseShaped(field.name) &&
          ["STRING", "TEXT", "TEXTAREA"].includes(String(field.type ?? "STRING").toUpperCase()));
        for (const objectName of sweepResolved) {
          const schema = await request(`${root}/sobjects/${objectName}/describe`);
          if (!schema.ok) return schema;
          // Exact-evidence created objects that cannot be swept refuse by
          // name: silently skipping them would leak created rows the sweep
          // can never see. Fuzzy keyword matches still skip: the flow may
          // never create them.
          const unusable = (!record(schema.body) || !Array.isArray(schema.body.fields))
            ? "exposed no usable schema"
            : schema.body.queryable !== true
              ? "is not queryable by the execution identity"
              : schema.body.deletable !== true
                ? "cannot be deleted by the execution identity"
                : null;
          if (unusable) {
            if (sweepExactNames.has(objectName)) {
              return fail("FLOW_CREATED_CHILD_UNTRACKED",
                `The flow declares creation of '${objectName}' rows and live object '${objectName}' ${unusable}; created rows would leak outside fixture scope.`);
            }
            continue;
          }
          const fields = (schema.body.fields as unknown[]).filter(record);
          if (!fields.some((field) => field.name === "CreatedDate")) {
            if (sweepExactNames.has(objectName)) {
              return fail("FLOW_CREATED_CHILD_UNTRACKED",
                `The flow declares creation of '${objectName}' rows and live object '${objectName}' exposes no creation timestamp for probe-window proof; created rows would leak outside fixture scope.`);
            }
            continue;
          }
          // The marker must be writable through the flow's prose input: an
          // auto-number name field (ReturnOrderNumber) can never carry it.
          const named = fields.find((field) => field.nameField === true && typeof field.name === "string" &&
            FIELD_NAME.test(field.name) && String(field.type ?? "").toLowerCase() === "string" &&
            field.createable === true);
          const fallbackName = fields.some((field) => field.name === "Name" &&
            String(field.type ?? "").toLowerCase() === "string" && field.createable === true) ? "Name" : null;
          const parentFields = fields.filter((field) => typeof field.name === "string" && FIELD_NAME.test(field.name) &&
            String(field.type ?? "").toLowerCase() === "reference" && Array.isArray(field.referenceTo) &&
            (field.referenceTo as unknown[]).some((ref) => typeof ref === "string" && fixtureObjects.has(ref)))
            .map((field) => String(field.name));
          const references = [...new Set(fields
            .filter((field) => String(field.type ?? "").toLowerCase() === "reference" && Array.isArray(field.referenceTo))
            .flatMap((field) => field.referenceTo as unknown[])
            .filter((ref): ref is string => typeof ref === "string" && FIELD_NAME.test(ref)))];
          sweepTargets.push({ objectName, nameField: (named && typeof named.name === "string" ? named.name : null) ?? fallbackName, parentFields, references });
        }
        if (sweepTargets.length === 0) {
          return fail("FLOW_CREATED_CHILD_UNTRACKED",
            `The flow declares creation with no cleanable output and no queryable sweep target resolved (tried ${sweepTried.slice(0, 6).join(", ") || "no usable hint"} against the live catalog); created rows would leak outside fixture scope.`);
        }
        const markerPath = markerInputs.length > 0 && sweepTargets.some((target) => target.nameField !== null);
        const parentPath = sweepTargets.some((target) => target.parentFields.length > 0);
        if (!markerPath && !parentPath) {
          return fail("FLOW_CREATED_CHILD_UNTRACKED",
            `The flow declares creation with no cleanable output and neither marker propagation nor parent linkage can prove created-row ownership on ${sweepTargets.map((target) => target.objectName).join(", ")}; created rows would leak outside fixture scope.`);
        }
      }
      // Notification-type inputs sample one live row (read-only setup metadata).
      const typeInputs = plan.kind === "notification_self_via_auth"
        ? inputs.filter((field) => typeof field.name === "string" &&
          NOTIFICATION_TYPE_INPUT.test(`${field.name} ${typeof field.description === "string" ? field.description : ""}`))
        : [];
      let notificationTypeId: string | null = null;
      if (typeInputs.length > 0) {
        const typeCheck = await request(`${root}/query?q=${encodeURIComponent(
          "SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName IN ('CustomNotificationType')")}`);
        if (!typeCheck.ok) return typeCheck;
        if (!entityDefinitionNames(typeCheck.body).includes("CustomNotificationType")) {
          return fail("FLOW_RECORD_TARGET_ABSENT",
            "The flow needs a live custom-notification type and CustomNotificationType is absent from the live org schema.");
        }
        const sample = await request(`${root}/query?q=${encodeURIComponent("SELECT Id FROM CustomNotificationType LIMIT 1")}`);
        if (!sample.ok) return sample;
        const row = record(sample.body) && Array.isArray(sample.body.records)
          ? (sample.body.records as unknown[]).filter(record)[0] : null;
        if (!row || !identity(row.Id)) {
          return fail("FLOW_RECORD_TARGET_ABSENT",
            "The flow needs a live custom-notification type and no CustomNotificationType rows were discovered.");
        }
        notificationTypeId = row.Id;
      }
      // Describe every target; owned fixtures need the full lifecycle.
      const describes = new Map<string, Value>();
      for (const objectName of new Set(targets.values())) {
        const schema = await request(`${root}/sobjects/${objectName}/describe`);
        if (!schema.ok) return schema;
        if (!record(schema.body) || !Array.isArray(schema.body.fields)) {
          return fail("FLOW_RECORD_TARGET_ABSENT",
            `Live describe for '${objectName}' exposed no usable schema; the flow cannot run without it.`);
        }
        describes.set(objectName, schema.body as Value);
      }
      for (const [inputName, objectName] of targets) {
        void inputName;
        const schema = describes.get(objectName);
        if (!schema || schema.queryable !== true) {
          return fail("FLOW_RECORD_TARGET_ABSENT",
            `Live object '${objectName}' is not queryable by the execution identity; the flow cannot run without it.`);
        }
        if (schema.createable !== true || schema.deletable !== true) {
          return fail("FLOW_RECORD_CONTEXT_UNAVAILABLE",
            `The live Flow schema does not resolve its record inputs to createable objects ('${objectName}' is not createable and deletable).`);
        }
      }
      // Template-named sweep inputs sample one live configuration row (read-only setup
      // metadata, mirroring notification-type sampling; never business data).
      const templateIds: Record<string, string> = {};
      for (const need of templateNeeds) {
        if (!describes.has(need.objectName)) {
          const schema = await request(`${root}/sobjects/${need.objectName}/describe`);
          if (!schema.ok) return schema;
          if (!record(schema.body) || !Array.isArray(schema.body.fields)) {
            return fail("FLOW_RECORD_TARGET_ABSENT",
              `Live describe for '${need.objectName}' exposed no usable schema; the flow cannot run without it.`);
          }
          describes.set(need.objectName, schema.body as Value);
        }
        const schema = describes.get(need.objectName);
        if (!schema || schema.queryable !== true) {
          return fail("FLOW_RECORD_TARGET_ABSENT",
            `Live object '${need.objectName}' is not queryable by the execution identity; the flow cannot run without it.`);
        }
        const sample = await request(`${root}/query?q=${encodeURIComponent(`SELECT Id FROM ${need.objectName} LIMIT 1`)}`);
        if (!sample.ok) return sample;
        const row = record(sample.body) && Array.isArray(sample.body.records)
          ? (sample.body.records as unknown[]).filter(record)[0] : null;
        if (!row || !identity(row.Id)) {
          return fail("FLOW_RECORD_TARGET_ABSENT",
            `Reference input '${need.inputName}' resolved to live object '${need.objectName}' with no samplable rows; the flow cannot run without it.`);
        }
        templateIds[need.inputName] = row.Id;
      }
      const roots = [...new Set(targets.values())];
      // Scalar-create plans bind no fixtures: every input is synthetic.
      const graph = roots.length === 0
        ? { ok: true as const, nodes: [] as ContextNode[], cleanupOrder: [] as string[] }
        : await planOwnedContext({
          roots,
          maxNodes: 12,
          markerLength: marker.length,
          describe: async (name) => describes.get(name) as unknown as ContextSchema | undefined,
        });
      if (!graph.ok) {
        return fail(graph.issue.code,
          `The live owned fixture dependency graph could not be safely planned (${graph.issue.objectName || "root"}).`);
      }
      const ids: Record<string, string> = {};
      const args: Value = {};
      // Live describe reader shared by enrichment (cached in describes).
      const describeCached = async (name: string): Promise<ContextSchema | undefined> => {
        const cached = describes.get(name);
        if (cached && record(cached) && Array.isArray((cached as Value).fields)) return cached as unknown as ContextSchema;
        let schema: Result | null = null;
        try {
          schema = await request(`${root}/sobjects/${name}/describe`);
        } catch {
          return undefined;
        }
        if (!schema || !schema.ok || !record(schema.body) || !Array.isArray((schema.body as Value).fields)) return undefined;
        describes.set(name, schema.body as Value);
        return schema.body as unknown as ContextSchema;
      };
      // Single insert attempt for a node (build, email completion, POST).
      const postNode = async (target: ContextNode, payload: Value): Promise<Result> => {
        const built = await input.build(target.objectName, marker, payload);
        if ("failure" in built) return built.failure;
        if (Object.entries(payload).some(([field, value]) => (built.values as Value)[field] !== value)) {
          return fail("FLOW_OWNED_BUILD_UNSCOPED", "The fixture builder changed a planned ownership or dependency field.");
        }
        const completed = { ...(built.values as Value) };
        const schema = describes.get(target.objectName);
        const fields = schema && Array.isArray(schema.fields) ? (schema.fields as Value[]) : [];
        const emailField = fields.find((field) => field.name === "Email" && field.createable === true && String(field.type).toLowerCase() === "email");
        if (emailField && (completed.Email == null || completed.Email === "")) {
          completed.Email = `owned-probe-${crypto.randomUUID()}@example.invalid`;
        }
        if (typeof completed.Email === "string" && completed.Email.endsWith("@example.invalid")) {
          fixtureEmails.push(completed.Email);
        }
        return request(`${root}/sobjects/${target.objectName}`, "POST", completed);
      };
      // Mint one planned node. Null when the fixture is established (ids and
      // actuals updated); otherwise the fault to return. Enrichment runs at
      // most one level deep: enrichment parents mint with enrich=false.
      const mintNode = async (node: ContextNode, enrich: boolean): Promise<Result | null> => {
        const values: Value = { ...node.values, [node.markerField]: marker };
        for (const reference of node.references) {
          const id = reference.source === "owned" ? ids[reference.objectName] : reference.id;
          if (!identity(id)) {
            return fail("FLOW_OWNED_REFERENCE_UNVERIFIED", "A planned dependency identity was not established.");
          }
          values[reference.field] = id;
        }
        let created = await postNode(node, values);
        if ((!created.ok || !identity(created.body?.id)) && enrich &&
          isTriggerNullInsertFault(created.status, created.body)) {
          const retried = await enrichAndRetry(node, values);
          if (retried) created = retried;
        }
        if (!created.ok || !identity(created.body?.id)) return created;
        owned.push({ objectName: node.objectName, id: created.body.id });
        scopes.push({ objectName: node.objectName, equals: { [node.markerField]: marker } });
        const actual = await request(`${root}/sobjects/${node.objectName}/${created.body.id}`);
        if (!actual.ok || !record(actual.body) || actual.body.Id !== created.body.id ||
          Object.entries(values).some(([field, value]) => (actual.body as Value)[field] !== value)) {
          return fail("FLOW_OWNED_FIXTURE_UNVERIFIED", "A planned owned fixture failed actual marker or relationship readback.");
        }
        ids[node.objectName] = created.body.id;
        actuals[node.objectName] = actual.body as Value;
        if (node.objectName === "Contact" || node.objectName === "Lead") fixtureContactIds.push(created.body.id);
        return null;
      };
      // Trigger-null-tolerant enrichment: populate the failed row's nillable
      // references from owned mints and retry the insert once. Returns the
      // retry outcome, or null when nothing enrichable resolves (the caller
      // keeps the original fault). Enrichment parents are owned, tracked,
      // and read back exactly like planned nodes.
      const enrichAndRetry = async (node: ContextNode, values: Value): Promise<Result | null> => {
        const schema = describes.get(node.objectName);
        const fields = schema && Array.isArray(schema.fields) ? schema.fields : [];
        const candidates = await planTriggerNullEnrichment({
          objectName: node.objectName,
          fields,
          plannedObjectNames: Object.keys(ids),
          boundFields: Object.keys(values),
          describe: describeCached,
        });
        if (candidates.length === 0) return null;
        const fresh = [...new Set(candidates.filter((candidate) => !candidate.reuse).map((candidate) => candidate.target))];
        if (fresh.length > 0) {
          let sub: Awaited<ReturnType<typeof planOwnedContext>> | null = null;
          try {
            sub = await planOwnedContext({
              roots: fresh,
              maxNodes: Math.max(1, 12 - Object.keys(ids).length),
              markerLength: marker.length,
              describe: describeCached,
            });
          } catch {
            return null;
          }
          if (!sub || !sub.ok) return null;
          for (const parent of sub.nodes) {
            if (ids[parent.objectName]) continue;
            const fault = await mintNode(parent, false);
            if (fault) return null;
          }
        }
        const enriched: Value = { ...values };
        for (const candidate of candidates) {
          const id = ids[candidate.target];
          if (!identity(id)) return null;
          enriched[candidate.field] = id;
        }
        return postNode(node, enriched);
      };
      for (const node of graph.nodes) {
        const fault = await mintNode(node, true);
        if (fault) return fault;
      }
      for (const [inputName, objectName] of targets) {
        fixtureIds[inputName] = ids[objectName];
        mappings.push({ inputName, objectName });
      }
      for (const [name, value] of Object.entries(synthetic)) args[name] = value;
      for (const [name, id] of Object.entries(selfBound)) args[name] = id;
      for (const [name, id] of Object.entries(templateIds)) args[name] = id;
      for (const [inputName, objectName] of targets) {
        const field = fieldByName(inputName);
        const collection = typeof field?.maxOccurs === "number" && field.maxOccurs > 1;
        if (field?.type === "SOBJECT") {
          const value = { ...actuals[objectName], attributes: { type: objectName } };
          args[inputName] = collection ? [value] : value;
        } else if (/(?:number|nbr)$/i.test(inputName)) {
          const value = fixtureNumberValue(actuals[objectName], ids[objectName]);
          args[inputName] = collection ? [value] : value;
        } else {
          args[inputName] = collection ? [ids[objectName]] : ids[objectName];
        }
      }
      // Live picklist values across every described object (fixtures, templates): same-named
      // constrained inputs bind live values instead of neutral fillers that would fault.
      const describedFields = [...describes.values()].flatMap((schema) =>
        Array.isArray(schema.fields) ? (schema.fields as unknown[]).filter(record) : []);
      for (const field of inputs) {
        if (typeof field.name !== "string" || Object.hasOwn(args, field.name)) continue;
        if (omittedInputs.includes(field.name)) continue;
        const collection = typeof field.maxOccurs === "number" && field.maxOccurs > 1;
        const wrap = (value: unknown): unknown => collection ? [value] : value;
        const stringish = ["STRING", "TEXT", "TEXTAREA"].includes(String(field.type ?? "STRING").toUpperCase());
        if (planRecipients.includes(field.name)) {
          args[field.name] = wrap(input.integrationUserId);
        } else if (typeInputs.some((item) => item.name === field.name) && notificationTypeId) {
          args[field.name] = wrap(notificationTypeId);
        } else if (!collection && isSelfUserShaped(field.name,
          typeof field.description === "string" ? field.description : null)) {
          args[field.name] = input.integrationUserId;
        } else if (sweepPlan && stringish && isProseShaped(field.name)) {
          // Prose always carries the marker on sweep plans: ownership proof is load-bearing,
          // and a constrained prose value faults honestly rather than leaking.
          args[field.name] = wrap(marker);
        } else if (sweepPlan || readPlan || deletePlan) {
          const choice = stringish ? livePicklistChoice(describedFields, field.name) : null;
          const declared = stringish ? descriptorPicklistChoice(field) : undefined;
          if (choice !== null) args[field.name] = wrap(choice);
          else if (declared !== undefined) args[field.name] = wrap(declared);
          else if (field.required === true) {
            args[field.name] = wrap(neutralOwnedValue(typeof field.type === "string" ? field.type : null,
              typeof field.description === "string" ? field.description : null));
          } else {
            omittedInputs.push(field.name);
          }
          // Optional unconstrained non-prose sweep/read/delete inputs omit (discovery-minimal).
        } else if (plan.kind === "scalar_create_via_auth" || field.required !== true) {
          const declared = stringish ? descriptorPicklistChoice(field) : undefined;
          const value = declared !== undefined ? declared : neutralOwnedValue(
            typeof field.type === "string" ? field.type : null,
            typeof field.description === "string" ? field.description : null);
          args[field.name] = wrap(value);
        }
      }
      // Required inputs were refused upfront; only a required input still
      // unbound fails here. Optional sweep/read/delete omissions are
      // discovery-minimal by design and pass through.
      const missing = inputs.filter((field) => typeof field.name === "string" &&
        field.required === true && !Object.hasOwn(args, field.name));
      if (missing.length > 0) {
        return fail("FLOW_FALLBACK_REQUIRED_INPUT_UNRESOLVED",
          `Required input '${missing[0].name}' has no live reference to resolve it from.`);
      }
      nativeAttempted = true;
      const invoked = await request(input.route, "POST", { inputs: [args] });
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, input.verificationWindowMs));
      const assessed = assessOwnedSubstrateOutcome(invoked.status, invoked.body);
      if (!assessed.ok) {
        // Opaque execution faults carry an evidence-fed taxonomy stamp for
        // the planner; otherwise the assessed output text stamps the R5
        // setup/input branches. The assessed code stays stable either way.
        executionFault = await diagnoseSubstrateExecutionFault({
          root, request, status: invoked.status, body: invoked.body,
          route: input.route, describes, cache: evidenceCache,
        });
        executionFault ??= diagnoseSubstrateOutputText(assessed);
        // Retryable-fault consumer: the narrowed (or freshly diagnosed)
        // fault plans its concrete repair. Agent-context faults repair
        // inline through the producer-backed lifecycle — but only when
        // the flow provably creates nothing, since the inline path
        // returns before created-row tracking. Creation-claimed and
        // cleanable-output flows keep the planner's repairPlan for the
        // searcher to drive on a due turn instead.
        const diagnosed =
          executionFault ??
          diagnoseFlowExecutionFault({ status: invoked.status, body: invoked.body });
        repairPlan = diagnosed ? planFlowFaultRepair(diagnosed) : null;
        if (
          diagnosed &&
          repairPlan?.strategy === "agent-customer-context" &&
          !declaresCreation(tail, flowDescription) &&
          !isWideCreation(tail, flowDescription) &&
          cleanableOutputs.length === 0
        ) {
          const repair = await runFlowFaultRepairConsumer({
            fault: diagnosed, root, route: input.route, request, build: input.build,
            ...(typeof input.verificationWindowMs === "number"
              ? { verificationWindowMs: input.verificationWindowMs }
              : {}),
          });
          if (repair && repair.disposition === "repaired") {
            verified = true;
            agentRepairAttempt = { converted: true, code: diagnosed.code };
            return { status: 200, ok: true, body: repair.repairedBody ?? {} };
          }
          if (repair) {
            agentRepairAttempt = {
              converted: false,
              code: diagnosed.code,
              disposition: repair.disposition,
              ...(repair.lifecycleCode ? { lifecycleCode: repair.lifecycleCode } : {}),
              ...(repair.fault && repair.fault.code !== diagnosed.code
                ? { rediagnosedCode: repair.fault.code }
                : {}),
            };
          }
        }
        return {
          status: 422, ok: false,
          body: {
            errorCode: assessed.code, message: assessed.message,
            ...(executionFault ? { managedFlowFault: executionFault } : {}),
            ...(repairPlan ? { repairPlan } : {}),
            ...(agentRepairAttempt ? { agentRepairAttempt } : {}),
          },
        };
      }
      // Generative read probes must return non-empty generative text to verify; an empty
      // summary over owned fixtures proves nothing about the generation path.
      if (readPlan && plan.generative === true) {
        const generated = Object.entries(assessed.outputValues).find(([name, value]) =>
          !name.toLowerCase().startsWith("flow__") && MESSAGE_OUTPUT.test(name) &&
          typeof value === "string" && value.trim().length > 0);
        if (!generated) {
          return { status: 422, ok: false, body: { errorCode: "FLOW_OWNED_PROBE_OUTPUT_FAILED",
            message: "The Flow interview finished but returned no generative text output to verify." } };
        }
      }
      // Delete probes verify target absence best-effort: the flow may delete by its own
      // criteria instead of the fixture, so a surviving fixture cleans up normally.
      if (deletePlan) {
        for (const entry of owned) {
          const check = await request(`${root}/sobjects/${entry.objectName}/${entry.id}`);
          if (check.status === 404) absenceNotes.push(`${entry.objectName}:${entry.id}`);
        }
      }
      // Delete created rows through id/record outputs with probe-window proof.
      // Parents collect first: scalar, collection, and JSON-embedded output
      // identities all surface as candidates, each needing object proof plus
      // probe-window readback. Children sweep by created-parent linkage
      // before any parent deletes, so no delete orphans a tracked child.
      const fixtureIdSet = new Set(Object.values(ids));
      let explainedOutputs = 0;
      const createdParents: Array<{ id: string; objectName: string; outputName: string }> = [];
      for (const output of scannableOutputs) {
        const name = String(output.name);
        // Narrow-cleanable outputs promise a created identity, so proof
        // failures taint the run; broad-scan outputs are opportunistic
        // (an echoed live id is expected), so their proof failures skip
        // silently and only verified parents track.
        const strict = cleanableOutputs.includes(output);
        const value = assessed.outputValues[name] ??
          assessed.outputValues[Object.keys(assessed.outputValues).find((key) => key.toLowerCase() === name.toLowerCase()) ?? ""];
        const candidates: Array<{ id: string; objectName: string | null }> = [];
        if (record(value) && identity(value.Id)) {
          const declared = record(value.attributes) && typeof value.attributes.type === "string" &&
            FIELD_NAME.test(value.attributes.type) ? value.attributes.type as string : null;
          candidates.push({ id: value.Id as string, objectName: declared });
        }
        for (const id of extractEmbeddedIds(value)) {
          if (!candidates.some((candidate) => candidate.id === id)) candidates.push({ id, objectName: null });
        }
        for (const candidate of candidates) {
          if (fixtureIdSet.has(candidate.id)) {
            explainedOutputs += 1;
            continue;
          }
          let objectName = candidate.objectName;
          if (!objectName) {
            const prefix = candidate.id.slice(0, 3);
            const keyed = await request(`${root}/query?q=${encodeURIComponent(
              `SELECT QualifiedApiName FROM EntityDefinition WHERE KeyPrefix = '${prefix}' LIMIT 5`)}`);
            if (!keyed.ok) return keyed;
            const names = entityDefinitionNames(keyed.body);
            if (names.length !== 1) {
              if (strict) cleanupError = `Created-row cleanup for output '${name}' could not prove the owning object; deletion was withheld.`;
              continue;
            }
            objectName = names[0];
          }
          const schema = await request(`${root}/sobjects/${objectName}/describe`);
          if (!schema.ok) return schema;
          if (!record(schema.body) || schema.body.deletable !== true) {
            if (strict) cleanupError = `Created-row cleanup for output '${name}' found '${objectName}' not deletable; deletion was withheld.`;
            continue;
          }
          const read = await request(`${root}/sobjects/${objectName}/${candidate.id}`);
          if (!read.ok || !record(read.body) || read.body.Id !== candidate.id) {
            if (read.status === 404) continue;
            if (strict) cleanupError = `Created-row cleanup for output '${name}' failed ownership readback; deletion was withheld.`;
            continue;
          }
          const createdAt = typeof read.body.CreatedDate === "string" ? Date.parse(read.body.CreatedDate) : NaN;
          if (!Number.isFinite(createdAt) || createdAt < probeStart - 300_000) {
            if (strict) cleanupError = `Created-row cleanup for output '${name}' could not prove probe-window creation; deletion was withheld.`;
            continue;
          }
          createdParents.push({ id: candidate.id, objectName, outputName: name });
        }
      }
      // Children sweep by created-parent linkage before any parent deletes:
      // description-evidenced objects with a lookup to a created parent
      // are queried for probe-window rows and deleted children-first. The
      // creation declaration does not gate this: a probe-window parent
      // proves the flow created rows whatever the description claims.
      // Anything else is never touched.
      if (createdParents.length > 0) {
        const parentObjects = new Set(createdParents.map((parent) => parent.objectName));
        const parentIds = createdParents.map((parent) => parent.id);
        const childCandidates = createdObjectCandidates(flowDescription, input.route)
          .filter((candidate) => !parentObjects.has(candidate));
        const childExact = childCandidates.length
          ? await request(`${root}/query?q=${encodeURIComponent(
            `SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName IN (${childCandidates.map((candidate) => `'${candidate}'`).join(",")})`)}`)
          : null;
        if (childExact && !childExact.ok) return childExact;
        const childLive = childExact ? entityDefinitionNames(childExact.body) : [];
        const childTargets: Array<{ objectName: string; parentFields: string[]; references: string[] }> = [];
        let childDescribes = 0;
        for (const candidate of childCandidates) {
          if (childTargets.length >= 3 || childDescribes >= 6 || !childLive.includes(candidate)) continue;
          const schema = await request(`${root}/sobjects/${candidate}/describe`);
          if (!schema.ok) return schema;
          childDescribes += 1;
          if (!record(schema.body) || !Array.isArray(schema.body.fields)) continue;
          const fields = (schema.body.fields as unknown[]).filter(record);
          if (schema.body.queryable !== true || schema.body.deletable !== true ||
            !fields.some((field) => field.name === "CreatedDate")) {
            cleanupError ??= `Created-child sweep on '${candidate}' found the object not cleanable; a created child row may exist untracked.`;
            continue;
          }
          const parentFields = fields.filter((field) => typeof field.name === "string" && FIELD_NAME.test(field.name) &&
            String(field.type ?? "").toLowerCase() === "reference" && Array.isArray(field.referenceTo) &&
            (field.referenceTo as unknown[]).some((ref) => typeof ref === "string" && parentObjects.has(ref)))
            .map((field) => String(field.name));
          if (parentFields.length === 0) continue;
          const references = [...new Set(fields
            .filter((field) => String(field.type ?? "").toLowerCase() === "reference" && Array.isArray(field.referenceTo))
            .flatMap((field) => field.referenceTo as unknown[])
            .filter((ref): ref is string => typeof ref === "string" && FIELD_NAME.test(ref)))];
          childTargets.push({ objectName: candidate, parentFields, references });
        }
        const childWindowStart = new Date(Math.max(0, probeStart - 60_000)).toISOString();
        for (const target of orderCleanupTargets(childTargets)) {
          const clauses = target.parentFields.flatMap((parentField) =>
            parentIds.map((parentId) => `${parentField} = '${parentId}'`));
          if (clauses.length === 0) continue;
          const found = await request(`${root}/query?q=${encodeURIComponent(
            `SELECT Id FROM ${target.objectName} WHERE CreatedDate >= ${childWindowStart} AND (${clauses.join(" OR ")}) LIMIT 50`)}`);
          if (!found.ok) {
            cleanupError = `Created-child sweep on '${target.objectName}' failed to query; deletion was withheld.`;
            continue;
          }
          const sweptIds = record(found.body) && Array.isArray(found.body.records)
            ? (found.body.records as unknown[]).filter(record).map((row) => row.Id)
              .filter((id): id is string => identity(id) && !fixtureIdSet.has(id) && !parentIds.includes(id)) : [];
          for (const sweptId of sweptIds) {
            const read = await request(`${root}/sobjects/${target.objectName}/${sweptId}`);
            if (!read.ok || !record(read.body) || read.body.Id !== sweptId) {
              if (read.status === 404) continue;
              cleanupError = `Created-child sweep on '${target.objectName}' failed ownership readback; deletion was withheld.`;
              continue;
            }
            const createdAt = typeof read.body.CreatedDate === "string" ? Date.parse(read.body.CreatedDate) : NaN;
            const parentMatch = target.parentFields.some((parentField) =>
              typeof read.body[parentField] === "string" && parentIds.includes(read.body[parentField] as string));
            if (!Number.isFinite(createdAt) || createdAt < probeStart - 300_000 || !parentMatch) {
              cleanupError = `Created-child sweep on '${target.objectName}' could not prove probe-window ownership; deletion was withheld.`;
              continue;
            }
            const deleted = await request(`${root}/sobjects/${target.objectName}/${sweptId}`, "DELETE");
            const gone = await request(`${root}/sobjects/${target.objectName}/${sweptId}`);
            if ((!deleted.ok && deleted.status !== 404) || gone.status !== 404) {
              cleanupError = `Created-child sweep on '${target.objectName}' could not be verified; the record may still exist.`;
              continue;
            }
            createdChildren.push({ objectName: target.objectName, id: sweptId });
          }
        }
      }
      // Parents delete after their swept children.
      for (const parent of createdParents) {
        const deleted = await request(`${root}/sobjects/${parent.objectName}/${parent.id}`, "DELETE");
        const gone = await request(`${root}/sobjects/${parent.objectName}/${parent.id}`);
        if ((!deleted.ok && deleted.status !== 404) || gone.status !== 404) {
          cleanupError = `Created-row cleanup for output '${parent.outputName}' could not be verified; the record may still exist.`;
          continue;
        }
        createdChildren.push({ objectName: parent.objectName, id: parent.id });
      }
      if (declaresCreation(tail, flowDescription) && cleanableOutputs.length > 0 &&
        createdChildren.length === 0 && explainedOutputs === 0) {
        cleanupError ??= "The flow succeeded but no created row was tracked through its outputs; a created row may exist untracked.";
      }
      // Creation-sweep cleanup: probe-window rows on sweep targets carrying the exact
      // marker or referencing an owned fixture are verified and deleted. Anything
      // else is never touched; misses warn but never blind-delete.
      if (sweepPlan && sweepTargets.length > 0) {
        const windowStart = new Date(Math.max(0, probeStart - 60_000)).toISOString();
        const fixtureIdList = Object.values(ids).filter(identity);
        for (const target of orderCleanupTargets(sweepTargets)) {
          const clauses: string[] = [];
          if (target.nameField) clauses.push(`${target.nameField} = '${marker}'`);
          for (const parentField of target.parentFields) {
            for (const fixtureId of fixtureIdList) clauses.push(`${parentField} = '${fixtureId}'`);
          }
          if (clauses.length === 0) continue;
          const found = await request(`${root}/query?q=${encodeURIComponent(
            `SELECT Id FROM ${target.objectName} WHERE CreatedDate >= ${windowStart} AND (${clauses.join(" OR ")}) LIMIT 50`)}`);
          if (!found.ok) {
            cleanupError = `Created-row sweep on '${target.objectName}' failed to query; deletion was withheld.`;
            continue;
          }
          const sweptIds = record(found.body) && Array.isArray(found.body.records)
            ? (found.body.records as unknown[]).filter(record).map((row) => row.Id)
              .filter((id): id is string => identity(id) && !fixtureIdSet.has(id)) : [];
          for (const sweptId of sweptIds) {
            const read = await request(`${root}/sobjects/${target.objectName}/${sweptId}`);
            if (!read.ok || !record(read.body) || read.body.Id !== sweptId) {
              if (read.status === 404) continue;
              cleanupError = `Created-row sweep on '${target.objectName}' failed ownership readback; deletion was withheld.`;
              continue;
            }
            const createdAt = typeof read.body.CreatedDate === "string" ? Date.parse(read.body.CreatedDate) : NaN;
            const markerMatch = target.nameField !== null && typeof read.body[target.nameField] === "string" &&
              (read.body[target.nameField] as string).includes(marker);
            const parentMatch = target.parentFields.some((parentField) =>
              typeof read.body[parentField] === "string" && fixtureIdList.includes(read.body[parentField] as string));
            if (!Number.isFinite(createdAt) || createdAt < probeStart - 300_000 || (!markerMatch && !parentMatch)) {
              cleanupError = `Created-row sweep on '${target.objectName}' could not prove probe-window ownership; deletion was withheld.`;
              continue;
            }
            const deleted = await request(`${root}/sobjects/${target.objectName}/${sweptId}`, "DELETE");
            const gone = await request(`${root}/sobjects/${target.objectName}/${sweptId}`);
            if ((!deleted.ok && deleted.status !== 404) || gone.status !== 404) {
              cleanupError = `Created-row sweep on '${target.objectName}' could not be verified; the record may still exist.`;
              continue;
            }
            createdChildren.push({ objectName: target.objectName, id: sweptId });
          }
        }
        if (createdChildren.length === 0) {
          cleanupError ??= `The flow succeeded but the creation sweep tracked no created row on ${sweepTargets.map((target) => target.objectName).join(", ")}; a created row may exist untracked.`;
        }
      }
      verified = true;
      return invoked;
    })();
  } catch {
    if ((outcome.body as Value)?.errorCode === "FLOW_OWNED_CONTEXT_UNAVAILABLE") {
      outcome = fail("FLOW_OWNED_LIFECYCLE_UNVERIFIED", "The owned substrate lifecycle failed; ownership-scoped cleanup still runs.");
    }
    verified = false;
  } finally {
    residueSweep = await sweepFlowCommunicationResidue(request, root, { contactIds: fixtureContactIds, emails: fixtureEmails });
    if (record(residueSweep) && (residueSweep as Value).queried === true && (residueSweep as Value).verified !== true) {
      cleanupError = "Temporary Flow communication residue cleanup could not be verified.";
    }
    if (owned.length > 0) {
      const cleaned = await cleanupOwnedContext({
        root, request, records: owned, scopes,
        order: [...new Set([...owned.map((entry) => entry.objectName), ...scopes.map((scope) => scope.objectName)])],
      });
      cleanupError ??= cleaned.cleanupError;
      owned.splice(0, owned.length, ...cleaned.ownedRecords);
    }
  }
  return done(outcome, {
    verified: cleanupError ? false : verified,
    marker, mappings, createdChildren,
    ownedRecords: owned, verificationRecordIds: Object.values(fixtureIds), fixtureRecordIds: fixtureIds,
    sweepTargets: sweepTargets.map((target) => target.objectName), omittedInputs,
    ...(absenceNotes.length > 0 ? { absenceNotes } : {}),
    residueSweep,
    ...(executionFault ? { managedFlowFault: executionFault } : {}),
    ...(repairPlan ? { repairPlan } : {}),
    ...(agentRepairAttempt ? { agentRepairAttempt } : {}),
    ...(cleanupError ? { cleanupError } : {}),
  });
}
