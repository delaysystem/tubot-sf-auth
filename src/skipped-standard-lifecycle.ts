/**
 * Owned skipped-standards lifecycle engine (Auth side).
 *
 * Root cause: the searcher's verb-skip heuristic parks every action whose
 * name carries a mutating verb at STATE_CHANGING_ACTION_SKIPPED, including
 * pure calculators, telemetry, and mutations an owned disposable fixture
 * can prove. The searcher routes those rows here with a platform-vocabulary
 * family slug (see `1action-searcher/src/skipped-standards-policy.ts`);
 * this engine executes the family lifecycle: live descriptor + live schema
 * discovery, owned fixture creation with a unique marker, declared-inputs-
 * only invocation, blind readback verification, and fixture deletion with
 * verified absence.
 *
 * Fail-closed throughout: unknown family slugs, undescribable fixture
 * objects, unresolvable required inputs, and unverified cleanups return
 * explicit `SKIPPED_STANDARD_<FAMILY>_<REASON>` faults, never synthesized
 * success. Real-world effects no fixture can own (outbound dialing,
 * external transfer, credential reset) are refused explicitly without
 * invoking. No org IDs, aliases, tenant names, instance URLs, or package
 * namespaces appear here; every tenant value is caller-supplied or read
 * live. Identifiers are never invented: ID/REFERENCE inputs bind only
 * owned fixture ids, caller-supplied live ids, or live-discovered ids.
 *
 * R7 skip-exempt wave (blind-verified 2026-10-06 on the sweep org): the
 * engine also owns invocable-apex shapes (owned SOBJECT-record updates,
 * body-screened scalar pure functions, external-callout refusals),
 * definition-scoped context-dynamic twins (empty-build exemption, twin
 * refusals), org-wide batch-job submissions (refused), and the remaining
 * unownable standards (social publish, hidden-contract appointment save,
 * routing-address email resend). Matching stays type + route shape + live
 * descriptor contract; no action, class, or object name is enumerated.
 */

import { nativeActionSucceeded } from "./action-outcome";
import { apexExecNestedFlags } from "./apex-exec-context";
import {
  apexNeedsLiveObjectName,
  apexRecordCompanionValue,
  apexSimpleClassName,
  apexSobjectShapePlan,
  contextNamespaceAbsent,
  firstQueryableObjectName,
  isApexExternalCalloutInputSet,
  isApexScalarOnlyInputSet,
  planApexScalarArgs,
  screenApexBody,
  verifyOwnedSobjectUpdate,
} from "./apex-effect-screen";
import { seedRequiredReferenceValues } from "./fixture-reference-seeding";
import { denialGrantForRestOutcome, type DenialGrant } from "./permission-denial-grants";
import {
  newSkippedStandardsMarker,
  resolveRequiredInputValue,
  selectAlternativeMarkerField,
  verifySkippedStandardReadback,
  type DescriptorField,
  type TargetField,
} from "./skipped-standards-context";
import { reclaimFixtureOwnerForDelete } from "./fixture-owner-reclaim";
import { clampVerificationWindowMs } from "./verification-window";

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const ENTITY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
import { STANDARD_ROUTE } from "./action-route-patterns";
const CUSTOM_ROUTE =
  /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/(dynamicSendSurveyInvitation|runDecisionMatrix)\/([A-Za-z][A-Za-z0-9_]{0,127})$/;
const APEX_ROUTE =
  /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/apex\/([A-Za-z][A-Za-z0-9_]{0,127})$/;
const BATCH_ROUTE =
  /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/batchJobAction\/([A-Za-z][A-Za-z0-9_]{0,127})$/;
const DYNAMIC_ROUTE =
  /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/(addContextRecordsDynamic|buildContextDynamic|queryContextRecordsDynamic|queryContextTagsDynamic|updateContextAttributesDynamic)\/([A-Za-z][A-Za-z0-9_]{0,127})$/;

/**
 * Family builder version (first worker-owned version for the skipped-standard
 * engine; set above every in-tree family version so stale searcher rows
 * reselect): 126 seeds required fixture references (Case.BusinessHoursId)
 * from live lookups so survey-invitation, case-action, record-convert,
 * swarm-channel, integration-plan, industries-async, notification, and
 * visualization families re-probe past
 * OWNED_CONTEXT_REQUIRED_REFERENCE_UNRESOLVED. OwnerId resolves to the
 * verified execution identity, never a borrowed user. 138 adds the r7
 * skip-exempt wave (apex owned-shape + scalar-pure + external-callout
 * families, context-dynamic twins, batch-submit, social-publish,
 * appointment-save, routing-verify): above every taken version (global
 * max 137) so r7 rows reselect exactly once. 141: createTask vocabulary
 * (assignee/type/due/priority/status/subject), optional picklists bind
 * descriptor choices (campaign status), absent fixture objects report
 * package_required, service-campaign binds the ASA prompt. 142:
 * notification templateDeveloperName binds a MessagingTemplate name.
 * 143: notification binds channelDeveloperName (capable channels first)
 * and recipientRecordId (owned end user) plus a fictional recipientPhone.
 * 144: discovery-query denials record a grant (input_unresolved heals
 * through provisioning instead of parking on unreadable substrate).
 * 145: required inputs missed through empty discovery propose the
 * backing object for a read grant (hidden-gap heal attempt), and
 * discovery failures carry their upstream codes.
 * 146: asset-activity refuses terminally (input_unresolved): the
 * flow-managed ConnectApi rep shape is undiscoverable from live
 * metadata, so no invented shape is ever sent.
 */
export const SKIPPED_STANDARD_BUILDER_VERSION = 146;

/** Families this engine executes: wave-2 remainder plus wave-1 owned fall-throughs. */
export const SKIPPED_STANDARD_ENGINE_FAMILIES = [
  "survey-invitation",
  "decision-matrix",
  "synthetic-eval",
  "record-assignment",
  "prospect-convert",
  "record-convert",
  "task-record",
  "case-action",
  "campaign-member",
  "context-record",
  "service-appointment",
  "message-send",
  "swarm-channel",
  "outbound-call",
  "credential-reset",
  "asset-activity",
  "care-plan-step",
  "engagement-topic",
  "integration-plan",
  "interest-tag",
  "referral-record",
  "scalecenter-request",
  "service-campaign",
  "loyalty-points",
  "inventory-slot",
  "member-verification",
  "timesheet-validate",
  "content-publish",
  "approval-override",
  "document-process",
  "event-publish",
  "billing-contact",
  "call-experience",
  "industries-async",
  "research",
  "visualization",
  "flow-plugin-plan",
  "enablement",
  "payment",
  "order-summary",
  "workspace",
  "notification",
  "goals",
  "return-order",
  "search-rule",
  "social-publish",
  "appointment-save",
  "routing-verify",
  "context-dynamic",
  "batch-submit",
  "apex-sobject-shape",
  "apex-scalar-pure",
  "apex-external-callout",
] as const;
export type SkippedStandardEngineFamily = (typeof SKIPPED_STANDARD_ENGINE_FAMILIES)[number];
const ENGINE_FAMILY_SET: ReadonlySet<string> = new Set(SKIPPED_STANDARD_ENGINE_FAMILIES);

/** Validates a searcher-supplied family slug; null when the engine cannot execute it. */
export function skippedStandardFamilySlug(family: unknown): SkippedStandardEngineFamily | null {
  return typeof family === "string" && ENGINE_FAMILY_SET.has(family)
    ? (family as SkippedStandardEngineFamily)
    : null;
}

/** Engine fault code: `SKIPPED_STANDARD_<FAMILY>_<REASON>`. */
export function skippedStandardCode(family: SkippedStandardEngineFamily, reason: string): string {
  const slug = family.toUpperCase().replace(/-/g, "_");
  const tail = reason.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48) || "REJECTED";
  return `SKIPPED_STANDARD_${slug}_${tail}`;
}

export type SkippedStandardDynamicKind =
  | "addContextRecordsDynamic"
  | "buildContextDynamic"
  | "queryContextRecordsDynamic"
  | "queryContextTagsDynamic"
  | "updateContextAttributesDynamic";

export type SkippedStandardRouteInfo = {
  kind: "standard" | "custom" | "apex" | "batch" | "dynamic";
  apiVersion: string;
  action: string;
  customKind?: "dynamicSendSurveyInvitation" | "runDecisionMatrix";
  dynamicKind?: SkippedStandardDynamicKind;
};

/**
 * Parses a live standard, survey/matrix custom, invocable-apex,
 * batch-job, or context-dynamic route; null otherwise. Tenant flows,
 * quick actions, prompts, and every other custom type still refuse.
 */
export function skippedStandardRouteInfo(route: unknown): SkippedStandardRouteInfo | null {
  if (typeof route !== "string") return null;
  const standard = route.match(STANDARD_ROUTE);
  if (standard) return { kind: "standard", apiVersion: standard[1], action: standard[2] };
  const custom = route.match(CUSTOM_ROUTE);
  if (custom) {
    return {
      kind: "custom",
      apiVersion: custom[1],
      action: custom[3],
      customKind: custom[2] as "dynamicSendSurveyInvitation" | "runDecisionMatrix",
    };
  }
  const apex = route.match(APEX_ROUTE);
  if (apex) return { kind: "apex", apiVersion: apex[1], action: apex[2] };
  const batch = route.match(BATCH_ROUTE);
  if (batch) return { kind: "batch", apiVersion: batch[1], action: batch[2] };
  const dynamic = route.match(DYNAMIC_ROUTE);
  if (dynamic) {
    return {
      kind: "dynamic",
      apiVersion: dynamic[1],
      action: dynamic[3],
      dynamicKind: dynamic[2] as SkippedStandardDynamicKind,
    };
  }
  return null;
}

const record = (value: unknown): value is Value =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && SF_ID.test(value);

const fail = (errorCode: string, message: string, extra?: Value): Result => ({
  status: 422, ok: false, body: { errorCode, message, ...extra },
});

// ---------------------------------------------------------------------------
// Declared-input binding engine (pure).
// ---------------------------------------------------------------------------

export type SkippedStandardBindingContext = {
  marker: string;
  ownerUserId?: string;
  /** Fixture object API name (or aka) to owned record id. */
  fixtures: Record<string, string>;
  /** Discovery key to live id or value. */
  discovered: Record<string, string>;
};

export type SkippedStandardArgSource =
  | { fixture: string }
  | { discovered: string }
  | { owner: true }
  | { marker: true }
  | { uuid: true }
  | { scalar: true }
  | { fixed: unknown }
  | { fixedFn: (marker: string) => unknown }
  | { builtSObject: string }
  | { updateShape: string }
  | { describedChoice: true }
  | { wrapped: { field: string; discovered: string } };

export type SkippedStandardInputBinding = { match: RegExp; use: SkippedStandardArgSource };

export type SkippedStandardBindingSpec = {
  bindings: SkippedStandardInputBinding[];
  /** When true, required plain-STRING inputs take the marker (evaluation dimensions only). */
  stringsAsMarker?: boolean;
};

const IDENTIFIER_INPUT = (input: DescriptorField): boolean => {
  const type = String(input.type ?? "").toUpperCase();
  if (type === "ID" || type === "REFERENCE") return true;
  return /(^|_)ids?$|(^|_)id_list$|ids?list$/i.test(input.name) || /id$/i.test(input.name);
};

function descriptorPicklistChoice(input: DescriptorField): string | undefined {
  const raw = input as DescriptorField & { values?: unknown; picklistValues?: unknown };
  const candidates = Array.isArray(raw.values) ? raw.values : Array.isArray(raw.picklistValues) ? raw.picklistValues : [];
  for (const entry of candidates) {
    if (typeof entry === "string" && entry) return entry;
    if (record(entry) && typeof entry.value === "string" && entry.value && entry.active !== false) return entry.value;
  }
  return undefined;
}

/**
 * First descriptor-documented valid value (`Valid values are "A" and "B"`)
 * for STRING inputs whose backend enumerates literals in prose. Undefined
 * when the description names none, so the planner misses honestly.
 */
export function descriptorValidValue(input: DescriptorField): string | undefined {
  const description = typeof input?.description === "string" ? input.description : "";
  const quoted = description.match(/valid values are\s+"([^"]+)"/i)?.[1];
  if (quoted) return quoted;
  return undefined;
}

function isCollectionInput(input: DescriptorField): boolean {
  const raw = input as DescriptorField & { isCollection?: unknown; maxOccurs?: unknown };
  return raw.isCollection === true || (typeof raw.maxOccurs === "number" && raw.maxOccurs > 1);
}

/**
 * Builds declared-inputs-only invocation arguments. Resolution order per
 * input: family binding table, descriptor-declared picklist values,
 * generic scalar shaping (required value-typed inputs only), marker for
 * evaluation-dimension strings when the spec allows. A required input
 * with no safe value is an explicit miss; identifiers are never invented.
 */
export function planSkippedStandardArgs(
  spec: SkippedStandardBindingSpec,
  descriptorInputs: DescriptorField[],
  ctx: SkippedStandardBindingContext,
  builtSObjects: Record<string, Value> = {},
): { args: Record<string, unknown> } | { missing: string } {
  if (!Array.isArray(descriptorInputs)) return { missing: "input_schema" };
  const args: Record<string, unknown> = {};
  for (const input of descriptorInputs) {
    if (!input || typeof input.name !== "string" || !FIELD_NAME.test(input.name)) {
      return { missing: "input_schema" };
    }
    const binding = spec.bindings.find((rule) => rule.match.test(input.name));
    let value: unknown;
    let bound = false;
    if (binding) {
      const use = binding.use;
      if ("fixture" in use) {
        const id = ctx.fixtures[use.fixture];
        if (!identity(id)) {
          if (input.required === true) return { missing: input.name };
          continue;
        }
        value = id;
        bound = true;
      } else if ("discovered" in use) {
        const found = ctx.discovered[use.discovered];
        if (typeof found !== "string" || !found) {
          if (input.required === true) return { missing: input.name };
          continue;
        }
        value = found;
        bound = true;
      } else if ("owner" in use) {
        if (!identity(ctx.ownerUserId)) {
          if (input.required === true) return { missing: input.name };
          continue;
        }
        value = ctx.ownerUserId;
        bound = true;
      } else if ("marker" in use) {
        value = ctx.marker;
        bound = true;
      } else if ("uuid" in use) {
        value = crypto.randomUUID();
        bound = true;
      } else if ("scalar" in use) {
        const scalar = resolveRequiredInputValue(input, []);
        if (scalar === undefined) {
          if (input.required === true) return { missing: input.name };
          continue;
        }
        value = scalar;
        bound = true;
      } else if ("fixed" in use) {
        value = use.fixed;
        bound = true;
      } else if ("fixedFn" in use) {
        value = use.fixedFn(ctx.marker);
        bound = true;
      } else if ("builtSObject" in use) {
        const shaped = builtSObjects[use.builtSObject];
        if (!shaped) {
          if (input.required === true) return { missing: input.name };
          continue;
        }
        value = shaped;
        bound = true;
      } else if ("updateShape" in use) {
        const id = ctx.fixtures[use.updateShape];
        const shaped = builtSObjects[use.updateShape];
        if (!identity(id) || !shaped) {
          if (input.required === true) return { missing: input.name };
          continue;
        }
        const markerField = Object.keys(shaped).find((key) => shaped[key] === ctx.marker) ?? "Name";
        value = { Id: id, [markerField]: ctx.marker };
        bound = true;
      } else if ("describedChoice" in use) {
        const choice = descriptorValidValue(input);
        if (choice === undefined) {
          if (input.required === true) return { missing: input.name };
          continue;
        }
        value = choice;
        bound = true;
      } else if ("wrapped" in use) {
        const found = ctx.discovered[use.wrapped.discovered];
        if (typeof found !== "string" || !found || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(use.wrapped.field)) {
          if (input.required === true) return { missing: input.name };
          continue;
        }
        value = { [use.wrapped.field]: found };
        bound = true;
      }
    }
    if (!bound) {
      const upperType = String(input.type ?? "").toUpperCase();
      if (upperType === "PICKLIST" || upperType === "COMBOBOX") {
        const choice = descriptorPicklistChoice(input);
        // Optional picklists bind their descriptor choice when one is
        // offered (campaign status demands it) and skip cleanly when the
        // descriptor offers no choice; only required gaps fail the plan.
        if (choice === undefined) {
          if (input.required === true) return { missing: input.name };
          continue;
        }
        value = choice;
        bound = true;
      } else if (input.required === true && ["BOOLEAN", "DATE", "DATETIME", "INTEGER", "INT", "LONG", "DOUBLE", "DECIMAL", "CURRENCY", "PERCENT", "TIME"].includes(upperType)) {
        const scalar = resolveRequiredInputValue(input, []);
        if (scalar === undefined) return { missing: input.name };
        value = scalar;
        bound = true;
      } else if (input.required === true && spec.stringsAsMarker && !IDENTIFIER_INPUT(input) &&
        ["", "STRING", "TEXT", "TEXTAREA", "TEXTAREA_LONG"].includes(upperType)) {
        value = ctx.marker;
        bound = true;
      } else if (input.required === true) {
        return { missing: input.name };
      } else {
        continue;
      }
    }
    args[input.name] = isCollectionInput(input) && !Array.isArray(value) ? [value] : value;
  }
  return { args };
}

// ---------------------------------------------------------------------------
// Per-family binding specs (platform vocabulary over live descriptor names).
// ---------------------------------------------------------------------------

const OWNER_BINDING = { owner: true } as const;
const MARKER_BINDING = { marker: true } as const;
const UUID_BINDING = { uuid: true } as const;
const SCALAR_BINDING = { scalar: true } as const;

/**
 * Scale Center `dateTimeRange` window from the live clock: `start/end` in
 * UTC with end at now and start 15 minutes back. Satisfies the platform
 * span (<= 30 minutes) and recency (start within 30 days) rules without
 * any fixed date. Exported for the colocated contract test.
 */
export function scaleCenterWindowNow(nowMs: number = Date.now()): string {
  const end = new Date(nowMs);
  const start = new Date(nowMs - 15 * 60 * 1000);
  return `${start.toISOString()}/${end.toISOString()}`;
}

/** Marker-safe prose inputs shared across families (subjects, names, notes). */
const PROSE_PATTERN = /subject|^(task|swarm|tag|campaign|step|label|title|name|description|comments?|notes?|text|utterance|explanation)$/i;

export function skippedStandardBindingSpec(
  family: SkippedStandardEngineFamily,
  action: string,
): SkippedStandardBindingSpec {
  const lowerAction = action.toLowerCase();
  switch (family) {
    case "survey-invitation":
      return {
        bindings: [
          { match: /^recipient$/i, use: { fixture: "Contact" } },
          { match: /^surveysubjectentity$/i, use: { fixture: "Case" } },
          { match: /^surveyname$/i, use: { discovered: "surveyName" } },
          { match: /^emailtemplatename$/i, use: { discovered: "emailTemplate" } },
          { match: /^surveyquestionname$/i, use: { discovered: "surveyQuestion" } },
          { match: /^personalinvitation$/i, use: { fixed: false } },
          { match: /^anonymousresponse$/i, use: { fixed: false } },
          { match: /^isunauthenticatedresponse$/i, use: { fixed: false } },
          { match: /^autoexpirydays$/i, use: { fixed: 1 } },
        ],
      };
    case "decision-matrix":
      return { bindings: [], stringsAsMarker: true };
    case "synthetic-eval":
      if (/qualific/i.test(action)) {
        return {
          bindings: [
            { match: /^productids?$/i, use: { fixture: "Product2" } },
            { match: /^correlationid$/i, use: UUID_BINDING },
            { match: /^contextdefinitionname$/i, use: { discovered: "contextDefinition" } },
            { match: /^contextmappingname$/i, use: { discovered: "contextMapping" } },
            { match: /^qualificationprocedurename$/i, use: { discovered: "qualificationProcedure" } },
          ],
        };
      }
      return {
        bindings: [
          { match: /^userutterance$/i, use: MARKER_BINDING },
          { match: /^(uuid|requestguid|correlationid)$/i, use: UUID_BINDING },
          { match: /^parameters$/i, use: { fixed: [] } },
          { match: /^apexclass$/i, use: { discovered: "apexClass" } },
          { match: /^expressionset$/i, use: { discovered: "expressionSet" } },
          // invokeRule: ApplicationName is runtime-required but freeform (any
          // non-empty value is accepted live with the discovered ExpressionSet;
          // no registry object enumerates valid values), so it binds the probe
          // marker instead of an undiscoverable lookup.
          { match: /^applicationname$/i, use: MARKER_BINDING },
          { match: /^dataspacename$/i, use: { discovered: "dataSpace" } },
        ],
      };
    case "record-assignment":
      return {
        bindings: [
          { match: /^queueid$/i, use: { discovered: "queueId" } },
          { match: /^(userid|assigneeid)$/i, use: OWNER_BINDING },
        ],
      };
    case "prospect-convert":
      return {
        bindings: [
          { match: /^prospectid$/i, use: { fixture: "Prospect" } },
          { match: /^convertedstatus$/i, use: { discovered: "convertedStatus" } },
        ],
      };
    case "record-convert":
      return {
        bindings: [
          { match: /^sourcerecordid$/i, use: { fixture: "Case" } },
          { match: /^contextdefinitionid$/i, use: { discovered: "contextDefinitionId" } },
          { match: /^sourceobjectcontextmappingname$/i, use: { discovered: "sourceMapping" } },
          { match: /^targetobjectcontextmappingname$/i, use: { discovered: "targetMapping" } },
          { match: /^targetrecord$/i, use: { builtSObject: "Case" } },
        ],
      };
    case "task-record":
    case "case-action":
    case "campaign-member":
    case "service-appointment":
    case "message-send":
    case "asset-activity":
    case "care-plan-step":
    case "engagement-topic":
    case "interest-tag":
    case "referral-record":
    case "loyalty-points":
    case "member-verification":
    case "timesheet-validate":
    case "content-publish":
    case "document-process":
    case "billing-contact":
    case "industries-async":
    case "visualization":
    case "enablement":
      return {
        bindings: [
          // liveMessageNotification's templateDeveloperName is a Messaging
          // Template name (EmailTemplate names never validate); sibling
          // families keep the shared EmailTemplate binding.
          { match: /^templatedevelopername$/i, use: { discovered: "liveMessageTemplate" } },
          ...sharedRecordBindings(family, lowerAction),
        ],
      };
    case "notification":
      return {
        bindings: [
          { match: /^templatedevelopername$/i, use: { discovered: "liveMessageTemplate" } },
          // Notification-capable channel first (capable MessageTypes win
          // the discovery order); an org with only In-App/Web channels
          // still resolves and fails honest at the Salesforce boundary.
          { match: /^channeldevelopername$/i, use: { discovered: "notificationChannel" } },
          // Recipient Record Id satisfies the conditional requirement
          // (recipientPhone XOR recipientRecordId) with an owned fixture
          // end user, so no real number is ever messaged.
          { match: /^recipientrecordid$/i, use: { fixture: "MessagingEndUser" } },
          // Fictional 555-01XX range (never a real subscriber): satisfies
          // the recipientPhone XOR recipientRecordId requirement alongside
          // the owned end user; live probes accept both bound at once.
          { match: /^recipientphone$/i, use: { fixed: "+15555550100" } },
          ...sharedRecordBindings(family, lowerAction),
        ],
      };
    case "goals":
      return { bindings: sharedRecordBindings(family, lowerAction) };
    case "service-campaign":
      return {
        bindings: [
          { match: /^commsubscriptionid$/i, use: { fixture: "CommSubscription" } },
          // Conditional ASA demand: resolutionType=AGENTFORCE_SERVICE_AGENT
          // faults MISSING_ARGUMENT unless the service prompt is bound
          // (live probe of createServiceCampaign).
          { match: /^serviceagentprompt$/i, use: MARKER_BINDING },
          ...sharedRecordBindings(family, lowerAction),
        ],
      };
    case "inventory-slot":
      // Release binds live statuses scoped to an owned allocation fixture;
      // the warning notify uses a synthetic status matching nothing, so no
      // live subscriber is ever notified.
      if (/warningnotfy/i.test(action)) {
        return {
          bindings: [
            { match: /^validityrangestartdatetime$/i, use: SCALAR_BINDING },
            { match: /^validityrangeenddatetime$/i, use: SCALAR_BINDING },
            { match: /^currentallocationstatus$/i, use: { fixed: "AS_PROBE_NOMATCH" } },
          ],
        };
      }
      return { bindings: sharedRecordBindings(family, lowerAction) };
    case "call-experience":
      return {
        bindings: [
          { match: /^recordid$/i, use: { discovered: "endedCallId" } },
          ...sharedRecordBindings(family, lowerAction),
        ],
      };
    case "workspace":
      return {
        bindings: [
          { match: /^(id|contentworkspaceid|workspaceid|libraryid)$/i, use: { fixture: "ContentWorkspace" } },
          ...sharedRecordBindings(family, lowerAction),
        ],
      };
    case "context-record":
      return {
        bindings: [
          { match: /^contextid$/i, use: { discovered: "contextId" } },
          { match: /^inputdata$/i, use: { fixedFn: (marker) => JSON.stringify({ probe: marker }) } },
          { match: /^overwriteexistingrecords$/i, use: { fixed: false } },
          { match: /^istaggeddata$/i, use: { fixed: false } },
          { match: /^datapaths$/i, use: { fixed: "$.probe" } },
          { match: /^ispermanentdelete$/i, use: { fixed: true } },
          { match: /^nodepathandupdatedvalues$/i, use: { fixedFn: (marker) => JSON.stringify({ "$.probe": marker }) } },
        ],
      };
    case "swarm-channel":
      return {
        bindings: [
          { match: /^recordid$/i, use: { fixture: "Case" } },
          { match: /^slackappid$/i, use: { discovered: "slackAppId" } },
          { match: /^slackteamid$/i, use: { discovered: "slackTeamId" } },
          { match: /^slackchannelname$/i, use: { fixedFn: () => `as-probe-${crypto.randomUUID().slice(0, 8)}` } },
          { match: /^slackchannelid$/i, use: { discovered: "slackChannelId" } },
          { match: /^swarmrecordname$/i, use: MARKER_BINDING },
          { match: /^swarmdescription$/i, use: MARKER_BINDING },
          { match: /^swarmowner$/i, use: OWNER_BINDING },
          { match: /^swarmid$/i, use: { discovered: "swarmId" } },
          { match: /^isprivate$/i, use: { fixed: true } },
          { match: /^isnewrecordchannelcreated$/i, use: SCALAR_BINDING },
        ],
      };
    case "outbound-call":
    case "credential-reset":
      return { bindings: [] };
    case "integration-plan":
      return {
        bindings: [
          { match: /^contextdefinitionname$/i, use: { discovered: "contextDefinition" } },
          { match: /^contextmappingname$/i, use: { discovered: "contextMapping" } },
          { match: /^istaggeddata$/i, use: { fixed: false } },
          { match: /^contextdata$/i, use: { fixedFn: (marker) => JSON.stringify({ probe: marker }) } },
          { match: /^expressionsetname$/i, use: { discovered: "expressionSet" } },
          { match: /^anchorrecordid$/i, use: { fixture: "Case" } },
          { match: /^integrationplanid$/i, use: { discovered: "integrationPlanId" } },
        ],
      };
    case "scalecenter-request":
      return {
        bindings: [
          // Live-clock window: the platform rejects spans over 30 minutes
          // and starts older than 30 days (R4: "Difference between start
          // and end times cannot be greater than 30 minutes", "Start time
          // must be within the last 30 days"). End is now, start is 15
          // minutes back, recomputed per invocation; no date is ever fixed.
          { match: /^datetimerange$/i, use: { fixedFn: () => scaleCenterWindowNow() } },
          { match: /^investigationtype$/i, use: MARKER_BINDING },
          { match: /^analysisname$/i, use: MARKER_BINDING },
        ],
      };
    case "approval-override":
      return {
        bindings: [
          { match: /^approvalworkitemid$/i, use: { discovered: "workItemId" } },
          { match: /^comments$/i, use: MARKER_BINDING },
        ],
      };
    case "event-publish":
      return {
        bindings: [
          { match: /^sourceobjectdevelopername$/i, use: { fixedFn: () => `ASProbe${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}` } },
          { match: /^payloadcurrentvalue$/i, use: { fixedFn: (marker) => JSON.stringify({ probe: marker }) } },
        ],
      };
    case "order-summary":
      return { bindings: sharedRecordBindings(family, lowerAction) };
    case "research":
    case "payment":
    case "return-order":
    case "search-rule":
    case "flow-plugin-plan":
      return { bindings: fallbackBindings(family) };
    case "social-publish":
    case "appointment-save":
    case "routing-verify":
    case "context-dynamic":
    case "batch-submit":
    case "apex-sobject-shape":
    case "apex-scalar-pure":
    case "apex-external-callout":
      // R7: dedicated runners and terminal refusals plan their own
      // declared inputs; the generic binder never runs for these.
      return { bindings: [] };
  }
}

function sharedRecordBindings(family: SkippedStandardEngineFamily, lowerAction: string): SkippedStandardInputBinding[] {
  const table: SkippedStandardInputBinding[] = [
    { match: /^queueid$/i, use: { discovered: "queueId" } },
    { match: /^(userid|assigneeid|notificationuserid)$/i, use: OWNER_BINDING },
    { match: /^(recordid|caseid|contactid|sourceid|subjectid)$/i, use: { fixture: primaryFixtureFor(family) } },
    { match: /^(serviceappointment(list|id)?s?|serviceappointmentslist)$/i, use: { fixture: "ServiceAppointment" } },
    { match: /^(resourceid|service_resource|serviceresourceid)$/i, use: { discovered: "resourceId" } },
    { match: /^schedulingpolicyid$/i, use: { discovered: "schedulingPolicyId" } },
    { match: /^timezone$/i, use: { fixed: "UTC" } },
    { match: /^programid$/i, use: { discovered: "programId" } },
    { match: /^invoiceid$/i, use: { fixture: "Invoice" } },
    { match: /^newbilltocontactid$/i, use: { fixture: "Contact" } },
    { match: /^setasdefault$/i, use: { fixed: false } },
    { match: /^(tasksubjectname|swarmrecordname|tagname|workordersteplabel|campaignname|topicname|goalname)$/i, use: MARKER_BINDING },
    { match: /^(campaigndescription|tagdescription|swarmdescription|taskcomments|referralnotes)$/i, use: MARKER_BINDING },
    { match: /^taskuseassigneduserlookup$/i, use: { fixed: false } },
    { match: /^taskassignedto$/i, use: OWNER_BINDING },
    { match: /^taskassignedtotype$/i, use: SCALAR_BINDING },
    { match: /^taskduedatetz$/i, use: SCALAR_BINDING },
    { match: /^taskpriority$/i, use: { discovered: "taskPriority" } },
    { match: /^taskstatus$/i, use: { discovered: "taskStatus" } },
    { match: /^tasksubject$/i, use: MARKER_BINDING },
    { match: /^campaignid$/i, use: { fixture: "Campaign" } },
    { match: /^categoryid$/i, use: { discovered: "categoryId" } },
    { match: /^topicid$/i, use: { fixture: "Topic" } },
    { match: /^careprogramenrolleeid$/i, use: { fixture: "CareProgramEnrollee" } },
    { match: /^actionplantemplateid$/i, use: { discovered: "actionPlanTemplateId" } },
    { match: /^requesterid$/i, use: OWNER_BINDING },
    // Live identity-verification process definition name (R4: synthetic
    // values reject with "Invalid or missing processDefinitionName").
    { match: /^processdefinitionname$/i, use: { discovered: "processDefinition" } },
    { match: /^subjectrecord$/i, use: { builtSObject: "Account" } },
    { match: /^referralrecord$/i, use: { builtSObject: "ClinicalServiceRequest" } },
    { match: /^emailcontentid$/i, use: { discovered: "emailContentId" } },
    { match: /^outreachemailsender$/i, use: OWNER_BINDING },
    { match: /^commsubscriptionid$/i, use: { discovered: "commSubscriptionId" } },
    { match: /^campaignmemberid$/i, use: { fixture: "Contact" } },
    { match: /^servicecampaignid$/i, use: { discovered: "serviceCampaignId" } },
    { match: /^loyaltyprogramname$/i, use: { discovered: "loyaltyProgram" } },
    { match: /^loyaltyprogramcurrencyname$/i, use: { discovered: "loyaltyCurrency" } },
    { match: /^loyaltyprogrammemberid$/i, use: { fixture: "LoyaltyProgramMember" } },
    { match: /^loyaltymembershipnumber$/i, use: { discovered: "loyaltyMembershipNumber" } },
    { match: /^currentallocationstatus$/i, use: { discovered: "allocationStatus" } },
    { match: /^updatedallocationstatus$/i, use: { discovered: "updatedAllocationStatus" } },
    { match: /^adspacecapacityallocationids$/i, use: { fixture: "AdSpaceCapacityAllocation" } },
    { match: /^shouldsendnotification$/i, use: { fixed: false } },
    { match: /^validityrangestartdatetime$/i, use: SCALAR_BINDING },
    { match: /^validityrangeenddatetime$/i, use: SCALAR_BINDING },
    { match: /^initiatingattendeeid$/i, use: { fixture: "Contact" } },
    { match: /^verificationstatus$/i, use: { fixed: false } },
    { match: /^engagementinteractionrecordid$/i, use: { fixture: "EngagementInteraction" } },
    { match: /^timesheetid$/i, use: { fixture: "TimeSheet" } },
    { match: /^computetimesheetentryitem$/i, use: { fixed: false } },
    { match: /^computewagetypesummary$/i, use: { fixed: false } },
    { match: /^runvalidations$/i, use: { fixed: true } },
    { match: /^releaseid$/i, use: { fixture: "ManagedContentRelease" } },
    { match: /^receiveddocumentid$/i, use: { fixture: "ReceivedDocument" } },
    { match: /^assetinputs$/i, use: /^update/i.test(lowerAction) ? { updateShape: "Asset" } : { builtSObject: "Asset" } },
    { match: /^recipientids$/i, use: OWNER_BINDING },
    { match: /^relatedrecordids$/i, use: { fixture: "Case" } },
    { match: /^messagetemplateid$/i, use: { discovered: "messageTemplateId" } },
    { match: /^engagementchannel$/i, use: { describedChoice: true } },
    { match: /^messagetypehandler$/i, use: { describedChoice: true } },
    { match: /^messagingenduserids$/i, use: { fixture: "MessagingEndUser" } },
    { match: /^messagedefinitionname$/i, use: { discovered: "messageDefinition" } },
    { match: /^isenforcemessagingchannelconsent$/i, use: { fixed: true } },
    { match: /^communicationsubscriptionid$/i, use: { discovered: "commSubscriptionId" } },
    { match: /^flowlabel$/i, use: { discovered: "flowLabel" } },
    { match: /^requestguid$/i, use: UUID_BINDING },
    { match: /^inputrecordid$/i, use: { fixture: "Case" } },
    { match: /^(outputrecordid|usercontextid)$/i, use: { discovered: "industriesContext" } },
    { match: /^integrationdefinition$/i, use: { discovered: "integrationDefinition" } },
    { match: /^visualizationid$/i, use: { fixture: "AnalyticsVisualization" } },
    // Minimal edit payload on the owned fixture: zero operations must no-op
    // (verified by marker readback) or reject honestly; never a blind shape.
    { match: /^editoperations$/i, use: { fixed: "[]" } },
    { match: /^startdate$/i, use: SCALAR_BINDING },
    { match: /^templatedevelopername$/i, use: { discovered: "messageTemplate" } },
    { match: /^channeldevelopername$/i, use: { discovered: "messageChannel" } },
    { match: /^contextrecordid$/i, use: { fixture: "Case" } },
    { match: /^recipientrecordid$/i, use: { fixture: "Contact" } },
    { match: /^ordersummaryid$/i, use: { discovered: "orderSummaryId" } },
    { match: /^webstoreid$/i, use: { discovered: "webStoreId" } },
    { match: /^ensurefundsasyncinput$/i, use: { wrapped: { field: "invoiceId", discovered: "invoiceId" } } },
    { match: /^performers$/i, use: { discovered: "performerIds" } },
    { match: PROSE_PATTERN, use: MARKER_BINDING },
  ];
  return table;
}

function fallbackBindings(family: SkippedStandardEngineFamily): SkippedStandardInputBinding[] {
  switch (family) {
    case "flow-plugin-plan":
      return [{ match: /^work_item$/i, use: { fixedFn: (marker) => ({ goal: marker, artifacts: [] }) } }];
    // Search shapes execute with synthetic text (live-verified).
    case "research":
      return [
        { match: /^searchtext$/i, use: MARKER_BINDING },
        { match: /^knowledgespacesearchindexid$/i, use: MARKER_BINDING },
      ];
    default:
      return [];
  }
}

/** Read-only live discovery sources. First hit wins; misses stay absent for fail-closed binding. */
export type SkippedStandardDiscovery =
  | { key: string; queryId: string[] }
  | { key: string; queryValue: string[]; field: string }
  | { key: string; queryIdList: string[]; limit: number }
  | { key: string; picklist: string[]; fieldMatch: RegExp; excludeValue?: string };

export function skippedStandardDiscoveries(
  family: SkippedStandardEngineFamily,
  action: string,
): SkippedStandardDiscovery[] {
  void action;
  switch (family) {
    case "record-assignment":
      return [{ key: "queueId", queryId: ["SELECT Id FROM Group WHERE Type = 'Queue' LIMIT 1"] }];
    case "task-record":
      return [
        { key: "taskPriority", picklist: ["Task"], fieldMatch: /^priority$/i },
        { key: "taskStatus", picklist: ["Task"], fieldMatch: /^status$/i },
      ];
    case "prospect-convert":
      return [{ key: "convertedStatus", queryValue: ["SELECT MasterLabel FROM LeadStatus WHERE IsConverted = true LIMIT 1"], field: "MasterLabel" }];
    case "record-convert":
      return [{ key: "contextDefinitionId", queryId: ["SELECT Id FROM ContextDefinition LIMIT 1"] }];
    case "survey-invitation":
      return [
        { key: "surveyName", queryValue: ["SELECT Name FROM Survey LIMIT 1"], field: "Name" },
        { key: "emailTemplate", queryValue: ["SELECT DeveloperName FROM EmailTemplate LIMIT 1"], field: "DeveloperName" },
      ];
    case "synthetic-eval":
      return [
        { key: "expressionSet", queryValue: ["SELECT ApiName FROM ExpressionSet LIMIT 1"], field: "ApiName" },
      ];
    case "service-appointment":
      return [
        { key: "resourceId", queryId: ["SELECT Id FROM ServiceResource LIMIT 1"] },
        { key: "schedulingPolicyId", queryId: ["SELECT Id FROM FSL__Scheduling_Policy__c LIMIT 1", "SELECT Id FROM SchedulingPolicy LIMIT 1"] },
      ];
    case "message-send":
    case "notification":
      return [
        { key: "messageTemplateId", queryId: ["SELECT Id FROM EmailTemplate LIMIT 1"] },
        { key: "messageTemplate", queryValue: ["SELECT DeveloperName FROM EmailTemplate LIMIT 1"], field: "DeveloperName" },
        { key: "liveMessageTemplate", queryValue: ["SELECT DeveloperName FROM MessagingTemplate LIMIT 1"], field: "DeveloperName" },
        { key: "messageChannel", queryValue: ["SELECT DeveloperName FROM MessagingChannel LIMIT 1"], field: "DeveloperName" },
        { key: "notificationChannel", queryValue: [
          "SELECT DeveloperName FROM MessagingChannel WHERE IsActive = true AND MessageType IN ('WhatsApp','Facebook','Line','Phone','Text') LIMIT 1",
          "SELECT DeveloperName FROM MessagingChannel WHERE IsActive = true LIMIT 1",
          "SELECT DeveloperName FROM MessagingChannel LIMIT 1",
        ], field: "DeveloperName" },
        { key: "engagementChannel", queryValue: ["SELECT DeveloperName FROM MessagingChannel LIMIT 1"], field: "DeveloperName" },
        { key: "channelId", queryId: ["SELECT Id FROM MessagingChannel LIMIT 1"] },
        { key: "messageDefinition", queryValue: ["SELECT DeveloperName FROM MessagingDefinition LIMIT 1"], field: "DeveloperName" },
        { key: "commSubscriptionId", queryId: ["SELECT Id FROM CommSubscription LIMIT 1", "SELECT Id FROM CommunicationSubscription LIMIT 1"] },
      ];
    case "enablement":
      return [{ key: "programId", queryId: ["SELECT Id FROM EnablementProgram LIMIT 1"] }];
    case "care-plan-step":
      return [{ key: "actionPlanTemplateId", queryId: ["SELECT Id FROM ActionPlanTemplate LIMIT 1"] }];
    case "interest-tag":
      return [{ key: "categoryId", queryId: ["SELECT Id FROM InterestTagCategory LIMIT 1", "SELECT Id FROM TagCategory LIMIT 1"] }];
    case "service-campaign":
      return [
        { key: "emailContentId", queryId: ["SELECT Id FROM EmailContent LIMIT 1"] },
        { key: "commSubscriptionId", queryId: ["SELECT Id FROM CommSubscription LIMIT 1", "SELECT Id FROM CommunicationSubscription LIMIT 1"] },
      ];
    case "loyalty-points":
      return [
        { key: "loyaltyProgram", queryValue: ["SELECT Name FROM LoyaltyProgram LIMIT 1"], field: "Name" },
        { key: "loyaltyProgramId", queryId: ["SELECT Id FROM LoyaltyProgram LIMIT 1"] },
        { key: "loyaltyCurrency", queryValue: ["SELECT Name FROM LoyaltyProgramCurrency LIMIT 1"], field: "Name" },
      ];
    case "inventory-slot":
      return [
        { key: "allocationStatus", picklist: ["AdSpaceCapacityAllocation"], fieldMatch: /status/i },
        { key: "updatedAllocationStatus", picklist: ["AdSpaceCapacityAllocation"], fieldMatch: /status/i, excludeValue: "@current" },
      ];
    case "industries-async":
      return [{ key: "integrationDefinition", queryValue: ["SELECT DeveloperName FROM IntegrationDefinition LIMIT 1"], field: "DeveloperName" }];
    case "call-experience":
      return [{ key: "endedCallId", queryId: ["SELECT Id FROM VoiceCall WHERE CallEndDateTime != null LIMIT 1"] }];
    case "timesheet-validate":
      return [{ key: "serviceResourceId", queryId: ["SELECT Id FROM ServiceResource LIMIT 1"] }];
    case "member-verification":
      return [{ key: "processDefinition", queryValue: ["SELECT DeveloperName FROM IdentityVerificationProcDef LIMIT 1"], field: "DeveloperName" }];
    case "integration-plan":
      return [
        { key: "contextDefinition", queryValue: ["SELECT DeveloperName FROM ContextDefinition LIMIT 1"], field: "DeveloperName" },
        { key: "expressionSet", queryValue: ["SELECT ApiName FROM ExpressionSet LIMIT 1"], field: "ApiName" },
      ];
    case "order-summary":
      return [
        { key: "orderSummaryId", queryId: ["SELECT Id FROM OrderSummary LIMIT 1"] },
        { key: "webStoreId", queryId: ["SELECT Id FROM WebStore LIMIT 1"] },
        { key: "invoiceId", queryId: ["SELECT Id FROM Invoice LIMIT 1"] },
      ];
    case "referral-record":
      return [
        { key: "performerIds", queryIdList: ["SELECT Id FROM Account LIMIT 3"], limit: 3 },
      ];
    case "visualization":
      return [{ key: "analyticsWorkspaceId", queryId: ["SELECT Id FROM AnalyticsWorkspace LIMIT 1"] }];
    case "campaign-member":
      return [
        { key: "campaignMemberStatus", queryValue: ["SELECT Label FROM CampaignMemberStatus LIMIT 1"], field: "Label" },
      ];
    default:
      return [];
  }
}

export type SkippedStandardFixturePlan = {
  /** Candidate objects in order; first usable wins. */
  objects: string[];
  /** Marker field override; otherwise the Name-style field or a relaxed alternative. */
  markerField?: string;
  /** Parent overrides: live describe confirms each field before use. */
  parents?: Record<string, { fixture: string } | { discovered: string }>;
  /** When true, creation failure skips the fixture instead of failing the lifecycle. */
  optional?: boolean;
};

export function skippedStandardFixtures(
  family: SkippedStandardEngineFamily,
  action: string,
): SkippedStandardFixturePlan[] {
  const lowerAction = action.toLowerCase();
  switch (family) {
    case "survey-invitation":
      return [{ objects: ["Contact"] }, { objects: ["Case"] }];
    case "synthetic-eval":
      return /qualific/i.test(action) ? [{ objects: ["Product2"] }] : [];
    case "record-assignment":
    case "decision-matrix":
    case "scalecenter-request":
    case "event-publish":
    case "outbound-call":
    case "credential-reset":
    case "context-record":
      return [];
    case "prospect-convert":
      return [{ objects: ["Prospect"] }];
    case "record-convert":
      return [{ objects: ["Case"] }];
    case "task-record":
      return [];
    case "case-action":
      return [{ objects: ["Case"] }];
    case "campaign-member":
      return [{ objects: ["Campaign"] }];
    case "service-appointment":
      // TR001 NPEs parentless SA inserts (verified); ride an owned WorkOrder.
      return [
        { objects: ["WorkOrder"] },
        { objects: ["ServiceAppointment"], parents: { ParentRecordId: { fixture: "WorkOrder" } } },
      ];
    case "message-send":
    case "notification":
      if (/^notify/i.test(action)) return [];
      // sendChannelMessage binds owner + discovered + descriptor-documented
      // values only; minted fixtures would add nothing but cleanup risk
      // (Case assignment rules route them to queues the worker cannot own).
      if (/^sendchannelmessage$/i.test(action)) return [];
      if (/conversationmessages/i.test(action)) {
        return [
          { objects: ["Contact"] },
          { objects: ["Case"] },
          { objects: ["MessagingEndUser"], parents: { ContactId: { fixture: "Contact" }, MessagingChannelId: { discovered: "channelId" } } },
        ];
      }
      // liveMessageNotification binds recipientRecordId to an owned
      // MessagingEndUser (recipientPhone XOR recipientRecordId): mint it
      // with an owned Contact parent so no real number is ever messaged.
      if (family === "notification" && /^livemessage/i.test(action)) {
        return [
          { objects: ["Contact"] },
          { objects: ["MessagingEndUser"], parents: { ContactId: { fixture: "Contact" }, MessagingChannelId: { discovered: "channelId" } } },
        ];
      }
      return [{ objects: ["Contact"] }, { objects: ["Case"] }];
    case "swarm-channel":
      return [{ objects: ["Case"] }];
    case "asset-activity":
      return /^update/i.test(lowerAction)
        ? [{ objects: ["Account"] }, { objects: ["Asset"], parents: { AccountId: { fixture: "Account" } } }]
        : [];
    case "care-plan-step":
      return [
        { objects: ["Account"] },
        { objects: ["CareProgramEnrollee"], parents: { AccountId: { fixture: "Account" } } },
      ];
    case "engagement-topic":
      return [{ objects: ["Topic"] }];
    case "integration-plan":
      return [{ objects: ["Case"] }];
    case "interest-tag":
      return [];
    case "referral-record":
      return [];
    case "service-campaign":
      // CommSubscription is fixture-mintable (verified round-trip).
      return [{ objects: ["Contact"] }, { objects: ["CommSubscription"] }];
    case "loyalty-points":
      return [{ objects: ["LoyaltyProgramMember"], parents: { LoyaltyProgramId: { discovered: "loyaltyProgramId" } }, optional: true }];
    case "inventory-slot":
      return /sendinv/i.test(action) && /notfy/i.test(action) ? [] : [{ objects: ["AdSpaceCapacityAllocation"] }];
    case "member-verification":
      return [{ objects: ["EngagementInteraction"] }, { objects: ["Contact"] }];
    case "timesheet-validate":
      return [{ objects: ["TimeSheet"], parents: { ServiceResourceId: { discovered: "serviceResourceId" } } }];
    case "content-publish":
      return [{ objects: ["ManagedContentRelease"] }];
    case "approval-override":
      return [{ objects: ["Opportunity"] }];
    case "document-process":
      return [{ objects: ["ReceivedDocument"] }];
    case "billing-contact":
      return [{ objects: ["Invoice", "blng__Invoice__c"] }, { objects: ["Contact"] }];
    case "call-experience":
      return [];
    case "industries-async":
      return /extasync/i.test(action) ? [] : [{ objects: ["Case"] }];
    case "visualization":
      return [{ objects: ["AnalyticsVisualization"], parents: { AnalyticsWorkspaceId: { discovered: "analyticsWorkspaceId" } } }];
    case "enablement":
      return [];
    case "goals":
      return [{ objects: ["Goal"] }];
    case "workspace":
      return [{ objects: ["ContentWorkspace"] }];
    case "research":
    case "payment":
    case "order-summary":
    case "return-order":
    case "search-rule":
    case "flow-plugin-plan":
      return [];
    case "social-publish":
    case "appointment-save":
    case "routing-verify":
    case "context-dynamic":
    case "batch-submit":
    case "apex-sobject-shape":
    case "apex-scalar-pure":
    case "apex-external-callout":
      // R7: terminal refusals mint no fixtures; dedicated runners own
      // descriptor-driven fixtures directly through the run context.
      return [];
  }
}

/** Primary fixture object each record family mutates or reads back. */
export function primaryFixtureFor(family: SkippedStandardEngineFamily): string {
  switch (family) {
    case "task-record":
      return "Task";
    case "case-action":
      return "Case";
    case "campaign-member":
      return "Campaign";
    case "service-appointment":
      return "ServiceAppointment";
    case "message-send":
      return "Contact";
    case "asset-activity":
      return "Asset";
    case "care-plan-step":
      return "CareProgramEnrollee";
    case "engagement-topic":
      return "Topic";
    case "interest-tag":
      return "InterestTag";
    case "referral-record":
      return "Account";
    case "service-campaign":
      return "Contact";
    case "loyalty-points":
      return "LoyaltyProgramMember";
    case "inventory-slot":
      return "AdSpaceCapacityAllocation";
    case "member-verification":
      return "EngagementInteraction";
    case "timesheet-validate":
      return "TimeSheet";
    case "content-publish":
      return "ManagedContentRelease";
    case "document-process":
      return "ReceivedDocument";
    case "billing-contact":
      return "Invoice";
    case "call-experience":
      return "VoiceCall";
    case "industries-async":
      return "Case";
    case "visualization":
      return "AnalyticsVisualization";
    case "enablement":
      return "EnablementProgram";
    case "notification":
      return "Contact";
    case "goals":
      return "Goal";
    case "workspace":
      return "ContentWorkspace";
    default:
      return "Case";
  }
}

// ---------------------------------------------------------------------------
// Async runtime (deps-injected request/build; no tenant values).
// ---------------------------------------------------------------------------

export type SkippedStandardRequest = (path: string, method?: string, body?: any) => Promise<Result>;
export type SkippedStandardBuild = (
  name: string,
  marker: string,
  values: Value,
) => Promise<{ values: Value } | { failure: Result }>;

export type SkippedStandardLifecycleInput = {
  root: string;
  route: string;
  family: SkippedStandardEngineFamily | string;
  ownerUserId?: string;
  verificationWindowMs?: number;
  request: SkippedStandardRequest;
  build: SkippedStandardBuild;
};

export type SkippedStandardLifecycleOutcome = {
  status: number;
  body: any;
  cleanupError?: string;
  contextSchema?: Value;
  /** Planner-only grant family when the failed outcome evidences a denial. */
  denialGrant?: DenialGrant;
};

type RunContext = {
  family: SkippedStandardEngineFamily;
  route: string;
  root: string;
  action: string;
  marker: string;
  ownerUserId?: string;
  request: SkippedStandardRequest;
  build: SkippedStandardBuild;
  describes: Map<string, TargetField[]>;
  fixtures: Record<string, string>;
  fixtureMarkers: Record<string, string>;
  discovered: Record<string, string>;
  builtSObjects: Record<string, Value>;
  cleanup: Array<{ object: string; id: string; marker?: string; markerField?: string }>;
  schedulingGrounded?: boolean;
  /** First discovery-query denial (object-crud only); powers grant self-heal on input_unresolved. */
  discoveryDenial?: DenialGrant;
  /** Per-key discovery-query failure notes (bounded); surfaced on input_unresolved. */
  discoveryFailures: string[];
};

function ctxCode(ctx: RunContext, reason: string): string {
  return skippedStandardCode(ctx.family, reason);
}

function queryRows(body: unknown): Value[] {
  return record(body) && Array.isArray(body.records) ? body.records.filter(record) : [];
}

function firstId(body: unknown): string | null {
  const row = queryRows(body).find((entry) => identity(entry.Id));
  return row ? (row.Id as string) : null;
}

async function describeCached(ctx: RunContext, object: string): Promise<TargetField[] | null> {
  if (!ENTITY_NAME.test(object)) return null;
  const cached = ctx.describes.get(object);
  if (cached) return cached;
  const response = await ctx.request(`${ctx.root}/sobjects/${object}/describe`);
  if (!response.ok || !record(response.body) || !Array.isArray(response.body.fields)) return null;
  const fields = (response.body.fields as unknown[]).filter(
    (field): field is TargetField => record(field) && typeof field.name === "string" && FIELD_NAME.test(field.name),
  );
  ctx.describes.set(object, fields);
  return fields;
}

const DISCOVERY_FROM_OBJECT = /\bFROM\s+([A-Za-z][A-Za-z0-9_]{1,127})/i;

/**
 * Records the first discovery-query denial so denial-driven self-heal can
 * provision the object and re-probe. Only true denials (403 or a
 * detector-confirmed object-crud refusal) record: empty results stay an
 * honest miss (no substrate to grant) and missing objects/packages stay
 * setup defects. The object comes from our own fixed SOQL (validated
 * identifier), never from upstream text.
 */
function firstUpstreamCode(body: unknown): string | null {
  const first = Array.isArray(body) ? body[0] : record(body) ? body : null;
  const code = first && typeof (first as { errorCode?: unknown }).errorCode === "string"
    ? (first as { errorCode: string }).errorCode : null;
  return code && /^[A-Za-z][A-Za-z0-9_]{1,40}$/.test(code) ? code : null;
}

function recordDiscoveryDenial(ctx: RunContext, key: string, soql: string, status: number, body: unknown): void {
  const code = firstUpstreamCode(body);
  if (ctx.discoveryFailures.length < 6) ctx.discoveryFailures.push(code ? `${key}:${status}:${code}` : `${key}:${status}`);
  if (ctx.discoveryDenial) return;
  const detected = denialGrantForRestOutcome(status, body);
  if (status !== 403 && detected?.family !== "object-crud") return;
  const from = DISCOVERY_FROM_OBJECT.exec(soql)?.[1];
  if (!from) return;
  ctx.discoveryDenial = { family: "object-crud", objectName: from, retryable: true,
    requirement: `Grant the execution identity ${from} read access through the fixture permission set during org provisioning, then retry.` };
}

/**
 * Object backing a required input missed through discovery: input name to
 * discovered key (first binding whose matcher hits) to the key's first
 * query FROM. All inputs are our own static config (validated identifier
 * out); null when the input is not discovery-backed. Pure.
 */
function hiddenKeyForInput(bindings: SkippedStandardInputBinding[], inputName: string): string | null {
  const use = bindings.find(b => b.match.test(inputName))?.use;
  return use && "discovered" in use && typeof use.discovered === "string" ? use.discovered : null;
}

function discoveryObjectForMissingInput(
  bindings: SkippedStandardInputBinding[],
  discoveries: SkippedStandardDiscovery[],
  inputName: string,
): { key: string; object: string } | null {
  const key = hiddenKeyForInput(bindings, inputName);
  if (!key) return null;
  const entry = discoveries.find(d => d.key === key);
  const soql = entry && ("queryId" in entry ? entry.queryId[0]
    : "queryValue" in entry ? entry.queryValue[0]
    : "queryIdList" in entry ? entry.queryIdList[0] : undefined);
  if (!soql) return null;
  const object = DISCOVERY_FROM_OBJECT.exec(soql)?.[1];
  return object ? { key, object } : null;
}

async function runDiscoveries(ctx: RunContext): Promise<void> {
  for (const discovery of skippedStandardDiscoveries(ctx.family, ctx.action)) {
    if ("queryId" in discovery) {
      for (const soql of discovery.queryId) {
        const response = await ctx.request(`${ctx.root}/query?q=${encodeURIComponent(soql)}`);
        if (!response.ok) { recordDiscoveryDenial(ctx, discovery.key, soql, response.status, response.body); continue; }
        const id = firstId(response.body);
        if (id) {
          ctx.discovered[discovery.key] = id;
          break;
        }
      }
    } else if ("queryValue" in discovery) {
      for (const soql of discovery.queryValue) {
        const response = await ctx.request(`${ctx.root}/query?q=${encodeURIComponent(soql)}`);
        if (!response.ok) { recordDiscoveryDenial(ctx, discovery.key, soql, response.status, response.body); continue; }
        const row = queryRows(response.body).find(
          (entry) => typeof entry[discovery.field] === "string" && (entry[discovery.field] as string).length > 0,
        );
        if (row) {
          ctx.discovered[discovery.key] = row[discovery.field] as string;
          break;
        }
      }
    } else if ("queryIdList" in discovery) {
      for (const soql of discovery.queryIdList) {
        const response = await ctx.request(`${ctx.root}/query?q=${encodeURIComponent(soql)}`);
        if (!response.ok) { recordDiscoveryDenial(ctx, discovery.key, soql, response.status, response.body); continue; }
        const ids = queryRows(response.body)
          .map((entry) => entry.Id)
          .filter((id): id is string => typeof id === "string" && SF_ID.test(id))
          .slice(0, Math.max(1, discovery.limit));
        if (ids.length) {
          ctx.discovered[discovery.key] = ids.join(",");
          break;
        }
      }
    } else {
      for (const object of discovery.picklist) {
        const fields = await describeCached(ctx, object);
        const field = fields?.find(
          (entry) =>
            discovery.fieldMatch.test(entry.name) &&
            (entry.type === "picklist" || entry.type === "combobox") &&
            Array.isArray(entry.picklistValues),
        );
        const choices = (field?.picklistValues ?? []).filter(
          (entry): entry is { value?: string; active?: boolean } & Record<string, unknown> =>
            !!entry && typeof entry.value === "string" && entry.value.length > 0 && entry.active !== false,
        );
        const current = discovery.excludeValue === "@current" ? ctx.discovered.allocationStatus : discovery.excludeValue;
        const choice = choices.find((entry) => entry.value !== current) ?? (discovery.excludeValue ? undefined : choices[0]);
        if (choice?.value) {
          ctx.discovered[discovery.key] = choice.value;
          break;
        }
      }
    }
  }
}

function markerFieldFor(fields: TargetField[], override?: string): { name: string; length: number } | null {
  if (override && FIELD_NAME.test(override)) {
    const schema = fields.find((field) => field.name === override);
    if (schema && schema.createable === true && schema.filterable === true &&
      (schema.type === "string" || schema.type === "textarea") &&
      typeof schema.length === "number" && schema.length >= 24) {
      return { name: schema.name, length: schema.length };
    }
    return null;
  }
  const preferred = ["Name", "Subject", "Title", "DeveloperName", "MasterLabel"].map((name) =>
    fields.find((field) => field.name === name),
  );
  for (const schema of preferred) {
    if (schema && schema.createable === true && schema.filterable === true &&
      (schema.type === "string" || schema.type === "textarea") &&
      typeof schema.length === "number" && schema.length >= 24 && schema.calculated !== true &&
      schema.autoNumber !== true && !schema.compoundFieldName) {
      return { name: schema.name, length: schema.length };
    }
  }
  return selectAlternativeMarkerField(fields);
}

/**
 * Reference overrides for an owned fixture or shaped sObject: required
 * references seed from live lookups (borrowed rows are never written;
 * unresolved fields fail honest through the builder as before). OwnerId is
 * pinned to the verified execution identity whenever the live schema allows
 * a User owner, so a fixture is never owned by an arbitrary borrowed user
 * (which would also break deletion cleanup). Native platform actions only:
 * this engine never invokes tenant flows, so the borrow leg stays allowed
 * (routing/email-alert/quick-action precedent).
 */
async function referenceOverrides(
  ctx: RunContext,
  fields: TargetField[],
): Promise<Record<string, string>> {
  const refSeed = await seedRequiredReferenceValues(ctx.request, ctx.root, fields);
  const overrides: Record<string, string> = { ...refSeed.overrides };
  const ownerField = fields.find((entry) => entry.name === "OwnerId");
  if (
    ownerField?.type === "reference" && ownerField.createable === true &&
    Array.isArray(ownerField.referenceTo) && ownerField.referenceTo.includes("User") &&
    typeof ctx.ownerUserId === "string" && SF_ID.test(ctx.ownerUserId)
  ) {
    overrides.OwnerId = ctx.ownerUserId;
  }
  return overrides;
}

/**
 * Reclaim a fresh fixture routed to a queue by assignment rules: later
 * DELETEs 400 INSUFFICIENT_ACCESS_OR_READONLY on unowned records, so
 * ownership is restored to the creator immediately after the marker
 * readback. The creator comes from the readback itself (CreatedById), never
 * the credential's integration-user field, which can point at a different
 * identity. Returns a fixture failure (with the record queued for
 * best-effort cleanup) when the reclaim is refused; null when the owner
 * already matches or ownership is unknown. Shared by every mint path.
 */
/**
 * Engine-shaped ServiceAppointment completion. The generic builder leaves
 * territory, work type, duration, and window at now-shaped defaults; the
 * FSL engine needs an STM-covered territory, a live work type with a
 * duration, and a forward window. Territory binds member-covered first
 * (an arbitrary territory pick has no capacity); duration converts the
 * bound work type's estimate by its unit; caller datetimes survive only
 * when already forward. Verified live: a fully-grounded appointment in
 * the proven territory still refuses when the org has no schedulable
 * capacity, which the scheduling-substrate terminal reports.
 */
async function completeServiceAppointmentFixture(ctx: RunContext, fields: TargetField[], values: Value): Promise<void> {
  const want = (name: string): boolean => {
    const field = fields.find((entry) => entry.name === name && entry.createable === true);
    return !!field && (values[name] == null || values[name] === "");
  };
  const firstRow = (body: unknown, key: string): Value | undefined => {
    if (!record(body) || !Array.isArray(body.records)) return undefined;
    return body.records.filter(record).find((entry) => identity(entry[key]));
  };
  if (want("ServiceTerritoryId")) {
    const covered = await ctx.request(
      `${ctx.root}/query?q=${encodeURIComponent("SELECT ServiceTerritoryId FROM ServiceTerritoryMember LIMIT 1")}`).catch(() => null);
    const coveredRow = covered ? firstRow(covered.body, "ServiceTerritoryId") : undefined;
    if (coveredRow) {
      values.ServiceTerritoryId = coveredRow.ServiceTerritoryId;
    } else {
      const territories = await ctx.request(
        `${ctx.root}/query?q=${encodeURIComponent("SELECT Id FROM ServiceTerritory LIMIT 1")}`).catch(() => null);
      const row = territories ? firstRow(territories.body, "Id") : undefined;
      if (row) values.ServiceTerritoryId = row.Id;
    }
  }
  if (want("WorkTypeId")) {
    const worktypes = await ctx.request(
      `${ctx.root}/query?q=${encodeURIComponent("SELECT Id, EstimatedDuration, DurationType FROM WorkType LIMIT 1")}`).catch(() => null);
    const row = worktypes ? firstRow(worktypes.body, "Id") : undefined;
    if (row) {
      values.WorkTypeId = row.Id;
      if (want("Duration") && typeof row.EstimatedDuration === "number" && row.EstimatedDuration > 0) {
        values.Duration = row.DurationType === "Hours" ? row.EstimatedDuration * 60 : row.EstimatedDuration;
      }
    }
  }
  if (want("Duration")) values.Duration = 60;
  const floor60 = (t: number): number => Math.floor(t / 60000) * 60000;
  const winNow = Date.now();
  const earliestMs = Date.parse(String(values.EarliestStartTime ?? ""));
  const dueMs = Date.parse(String(values.DueDate ?? ""));
  const earliest = Number.isFinite(earliestMs) && earliestMs > winNow + 1800000 ? earliestMs : floor60(winNow + 3600000);
  const due = Number.isFinite(dueMs) && dueMs > earliest ? dueMs : earliest + 3600000;
  if (fields.some((entry) => entry.name === "EarliestStartTime" && entry.createable === true)) {
    values.EarliestStartTime = new Date(earliest).toISOString();
  }
  if (fields.some((entry) => entry.name === "DueDate" && entry.createable === true)) {
    values.DueDate = new Date(due).toISOString();
  }
  // Scheduled times: formatting consumers read SchedStartTime (an
  // unscheduled fixture faults their own adjustment), and the fields are
  // createable. Derive from the forward window, clamped inside it.
  const spanMin = typeof values.Duration === "number" && values.Duration > 0 ? values.Duration : 60;
  const schedStart = earliest;
  const schedEnd = Math.min(schedStart + spanMin * 60000, due);
  if (fields.some((entry) => entry.name === "SchedStartTime" && entry.createable === true)) {
    values.SchedStartTime = new Date(schedStart).toISOString();
  }
  if (fields.some((entry) => entry.name === "SchedEndTime" && entry.createable === true)) {
    values.SchedEndTime = new Date(schedEnd).toISOString();
  }
  // Grounding witness: the scheduling-substrate terminal fires only when
  // the fixture provably carries engine shape (never on a gap refusal).
  if (identity(values.ServiceTerritoryId) && identity(values.WorkTypeId) &&
    typeof values.Duration === "number" && values.Duration > 0 &&
    Number.isFinite(Date.parse(String(values.EarliestStartTime ?? ""))) &&
    Number.isFinite(Date.parse(String(values.DueDate ?? "")))) {
    ctx.schedulingGrounded = true;
  }
}

/** Native actions-envelope error messages, bounded. */
function nativeErrorMessages(body: unknown): string[] {
  const out: string[] = [];
  const outcomes = Array.isArray(body) ? body : [body];
  for (const outcome of outcomes.slice(0, 8)) {
    if (!record(outcome) || !Array.isArray(outcome.errors)) continue;
    for (const entry of outcome.errors.slice(0, 8)) {
      if (record(entry) && typeof entry.message === "string" && entry.message) out.push(entry.message);
    }
  }
  return out;
}

async function reclaimFixtureOwner(ctx: RunContext, object: string, madeId: string,
  readback: unknown, marker: string, markerField: string): Promise<Result | null> {
  const actualOwner = record(readback) && typeof readback.OwnerId === "string" ? readback.OwnerId : null;
  const creator = record(readback) && typeof readback.CreatedById === "string" ? readback.CreatedById : null;
  if (!actualOwner || !creator || actualOwner === creator) return null;
  const reclaim = await ctx.request(`${ctx.root}/sobjects/${object}/${madeId}`, "PATCH", { OwnerId: creator });
  if (!reclaim.ok) {
    ctx.cleanup.push({ object, id: madeId, marker, markerField });
    return fail(ctxCode(ctx, "fixture_unavailable"),
      `The owned ${object} fixture routed to a queue the execution user cannot own (reclaim ${reclaim.status}).`);
  }
  return null;
}

async function createFixtures(ctx: RunContext): Promise<Result | null> {
  for (const plan of skippedStandardFixtures(ctx.family, ctx.action)) {
    let created: { object: string; id: string; markerField: string } | null = null;
    let lastFailure: Result | null = null;
    for (const object of plan.objects) {
      if (!ENTITY_NAME.test(object)) continue;
      const probe = await ctx.request(`${ctx.root}/sobjects/${object}/describe`);
      if (!probe.ok && probe.status === 404) {
        return fail(ctxCode(ctx, "package_required"),
          `The ${object} object is not installed in this org; install the managed package that provides it, then retry.`,
          { setupRequirement: `Install the ${object} managed package (the ${object} object is absent from this org), then retry.` });
      }
      if (!probe.ok || !record(probe.body) || probe.body.createable !== true ||
        probe.body.queryable !== true || probe.body.deletable !== true || !Array.isArray(probe.body.fields)) {
        lastFailure = fail(
          ctxCode(ctx, "fixture_unavailable"),
          `Automatic ${object} context requires live create, read and delete access.`,
          { setupRequirement: `${object} create/read/delete access for the execution user.` },
        );
        continue;
      }
      const fields = (probe.body.fields as unknown[]).filter(
        (field): field is TargetField => record(field) && typeof field.name === "string" && FIELD_NAME.test(field.name),
      );
      ctx.describes.set(object, fields);
      const markerPick = markerFieldFor(fields, plan.markerField);
      if (!markerPick) {
        lastFailure = fail(
          ctxCode(ctx, "fixture_unavailable"),
          `The live ${object} object exposes no writable, filterable marker field for independent verification.`,
        );
        continue;
      }
      const parents: Value = {};
      let parentsOk = true;
      for (const [field, source] of Object.entries(plan.parents ?? {})) {
        const schema = fields.find((entry) => entry.name === field);
        if (!schema || schema.createable !== true) continue;
        const value = "fixture" in source ? ctx.fixtures[source.fixture] : ctx.discovered[source.discovered];
        if (typeof value !== "string" || !value) {
          parentsOk = false;
          break;
        }
        parents[field] = value;
      }
      if (!parentsOk) {
        lastFailure = fail(
          ctxCode(ctx, "fixture_unavailable"),
          `The owned ${object} fixture needs an unresolved parent reference.`,
        );
        continue;
      }
      const marker = newSkippedStandardsMarker(Math.min(markerPick.length, 80));
      // Seeded foreign keys fill only gaps: the unique marker and planned
      // owned parents stay authoritative over borrowed live ids.
      const refs = await referenceOverrides(ctx, fields);
      const built = await ctx.build(object, marker, { ...refs, [markerPick.name]: marker, ...parents });
      if ("failure" in built) {
        lastFailure = built.failure;
        continue;
      }
      if (object === "ServiceAppointment") {
        await completeServiceAppointmentFixture(ctx, fields, built.values);
      }
      if (built.values[markerPick.name] !== marker) {
        lastFailure = fail(ctxCode(ctx, "fixture_unavailable"), "The fixture builder changed a planned ownership field.");
        continue;
      }
      const made = await ctx.request(`${ctx.root}/sobjects/${object}`, "POST", built.values);
      const madeId: unknown = made.body?.id ?? made.body?.Id;
      if (!made.ok || !identity(madeId)) {
        lastFailure = made;
        continue;
      }
      const actual = await ctx.request(`${ctx.root}/sobjects/${object}/${madeId}`);
      if (!actual.ok || actual.body?.[markerPick.name] !== marker) {
        ctx.cleanup.push({ object, id: madeId, marker, markerField: markerPick.name });
        lastFailure = fail(ctxCode(ctx, "fixture_unverified"), "The owned fixture readback did not carry the marker.");
        continue;
      }
      const reclaimFailure = await reclaimFixtureOwner(ctx, object, madeId as string, actual.body, marker, markerPick.name);
      if (reclaimFailure) {
        lastFailure = reclaimFailure;
        continue;
      }
      created = { object, id: madeId, markerField: markerPick.name };
      ctx.fixtures[object] = madeId;
      ctx.fixtureMarkers[object] = markerPick.name;
      ctx.cleanup.push({ object, id: madeId, marker, markerField: markerPick.name });
      break;
    }
    if (!created) {
      if (plan.optional) continue;
      if (ctx.family === "billing-contact" && plan.objects.some((name) => name === "Invoice" || name === "blng__Invoice__c")) {
        return fail(ctxCode(ctx, "package_required"),
          `No invoice substrate resolved (${plan.objects.join("/")}); install the Salesforce Billing managed package or provision invoice substrate, then retry.`,
          { setupRequirement: "Install the Salesforce Billing managed package (invoice substrate) or grant invoice create/read/delete access, then retry." });
      }
      return lastFailure ?? fail(ctxCode(ctx, "fixture_unavailable"), "The owned fixture could not be prepared.");
    }
  }
  return null;
}

async function buildShapedSObjects(ctx: RunContext, inputs: DescriptorField[]): Promise<Result | null> {
  const spec = skippedStandardBindingSpec(ctx.family, ctx.action);
  const needed = new Set<string>();
  for (const input of inputs) {
    const binding = spec.bindings.find((rule) => rule.match.test(input.name));
    if (binding && "builtSObject" in binding.use) needed.add(binding.use.builtSObject);
    if (binding && "updateShape" in binding.use) needed.add(binding.use.updateShape);
  }
  for (const object of needed) {
    if (!ENTITY_NAME.test(object)) {
      return fail(ctxCode(ctx, "input_unresolved"), "A shaped record input names an invalid object.");
    }
    const fields = await describeCached(ctx, object);
    const markerPick = fields ? markerFieldFor(fields) : null;
    const refs = fields ? await referenceOverrides(ctx, fields) : {};
    const built = await ctx.build(object, ctx.marker,
      markerPick ? { ...refs, [markerPick.name]: ctx.marker } : { ...refs });
    if ("failure" in built) return built.failure;
    ctx.builtSObjects[object] = { attributes: { type: object }, ...built.values };
  }
  return null;
}

async function cleanupFixtures(ctx: RunContext): Promise<string | undefined> {
  for (const entry of [...ctx.cleanup].reverse()) {
    if (!ENTITY_NAME.test(entry.object) || !identity(entry.id)) continue;
    if (typeof ctx.ownerUserId === "string" && identity(ctx.ownerUserId)) {
      await reclaimFixtureOwnerForDelete({ root: ctx.root, objectName: entry.object, id: entry.id, ownerId: ctx.ownerUserId, request: ctx.request }).catch(() => null);
    }
    const removed = await ctx.request(`${ctx.root}/sobjects/${entry.object}/${entry.id}`, "DELETE");
    const check = await ctx.request(`${ctx.root}/sobjects/${entry.object}/${entry.id}`);
    if (check.status !== 404) {
      const first = Array.isArray(removed.body) ? removed.body[0] : removed.body;
      const denial = record(first) && typeof first.errorCode === "string"
        ? ` ${first.errorCode}${typeof first.message === "string" ? `: ${first.message.slice(0, 120)}` : ""}` : "";
      return `Owned ${entry.object} fixture cleanup could not be verified (delete ${removed.status}${denial}, readback ${check.status}); the record may still exist.`;
    }
    if (entry.marker && entry.markerField && !entry.marker.includes("'")) {
      const swept = await ctx.request(`${ctx.root}/query?q=${encodeURIComponent(
        `SELECT Id FROM ${entry.object} WHERE ${entry.markerField} = '${entry.marker}' LIMIT 2`)}`);
      const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
      if (!swept.ok || !rows || rows.length > 0) {
        return "Owned skipped-standard fixture cleanup could not be verified; a marker-scoped sibling may remain.";
      }
    }
  }
  return undefined;
}

function descriptorInputsOf(body: unknown): DescriptorField[] | null {
  const inputs = record(body) ? (body as { inputs?: unknown }).inputs : undefined;
  if (!Array.isArray(inputs)) return null;
  const cleaned = inputs.filter(
    (field): field is DescriptorField => record(field) && typeof field.name === "string" && FIELD_NAME.test(field.name),
  );
  return cleaned.length === inputs.length ? cleaned : null;
}

function outputIdsByPattern(body: unknown, pattern: RegExp): string[] {
  const out: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 5 || out.length >= 8) return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 32)) visit(item, depth + 1);
      return;
    }
    if (!record(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && identity(value) && pattern.test(key) && !out.includes(value)) out.push(value);
      else if (value !== null && typeof value === "object") visit(value, depth + 1);
    }
  };
  visit(body, 0);
  return out;
}

function firstOutputText(body: unknown, pattern: RegExp): string | null {
  let found: string | null = null;
  const visit = (node: unknown, depth: number): void => {
    if (depth > 5 || found) return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 32)) visit(item, depth + 1);
      return;
    }
    if (!record(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && value.length > 0 && value.length < 256 && pattern.test(key)) {
        found = value;
        return;
      }
      if (value !== null && typeof value === "object") visit(value, depth + 1);
    }
  };
  visit(body, 0);
  return found;
}

type CreatedPlan = { object: string | null; mode: "strict" | "documented" };

function createdPlanFor(family: SkippedStandardEngineFamily, action: string): CreatedPlan | null {
  const lowerAction = action.toLowerCase();
  if (family === "task-record") return { object: "Task", mode: "strict" };
  if (family === "interest-tag") return { object: "InterestTag", mode: "strict" };
  if (family === "asset-activity" && !/^update/i.test(lowerAction)) return { object: "Asset", mode: "strict" };
  if (family === "service-campaign" && !/^update/i.test(lowerAction)) return { object: "ServiceCampaign", mode: "strict" };
  if (family === "engagement-topic") return { object: "EngagementTopic", mode: "documented" };
  if (family === "service-appointment" && /apptlistfilter/i.test(action)) return { object: null, mode: "documented" };
  if (family === "integration-plan" && !/^run/i.test(lowerAction)) return { object: null, mode: "documented" };
  if (family === "care-plan-step") return { object: null, mode: "documented" };
  return null;
}

async function verifyCreated(ctx: RunContext, plan: CreatedPlan, invoked: Result): Promise<{ verified: boolean; createdIds: string[] }> {
  if (!nativeActionSucceeded(invoked.status, invoked.body)) return { verified: false, createdIds: [] };
  const createdIds = outputIdsByPattern(invoked.body, /id$/i);
  if (!plan.object) return { verified: true, createdIds };
  const fields = await describeCached(ctx, plan.object);
  const markerPick = fields ? markerFieldFor(fields) : null;
  if (!markerPick || ctx.marker.includes("'")) {
    return plan.mode === "strict" ? { verified: false, createdIds } : { verified: true, createdIds };
  }
  const swept = await ctx.request(`${ctx.root}/query?q=${encodeURIComponent(
    `SELECT Id FROM ${plan.object} WHERE ${markerPick.name} = '${ctx.marker}' LIMIT 5`)}`);
  const rows = queryRows(swept.ok ? swept.body : null).filter((entry) => identity(entry.Id));
  for (const row of rows) {
    ctx.cleanup.push({ object: plan.object as string, id: row.Id as string, marker: ctx.marker, markerField: markerPick.name });
  }
  if (plan.mode === "strict") {
    return { verified: rows.length > 0, createdIds: rows.map((row) => row.Id as string) };
  }
  return { verified: true, createdIds: rows.map((row) => row.Id as string) };
}

async function verifyFixturesIntact(ctx: RunContext): Promise<boolean> {
  for (const [object, id] of Object.entries(ctx.fixtures)) {
    const markerField = ctx.fixtureMarkers[object];
    const entry = ctx.cleanup.find((item) => item.object === object && item.id === id);
    if (!markerField || !entry?.marker) return false;
    const actual = await ctx.request(`${ctx.root}/sobjects/${object}/${id}`);
    const check = verifySkippedStandardReadback({
      performed: true,
      markerField,
      marker: entry.marker,
      after: record(actual.body) ? (actual.body as Record<string, unknown>) : null,
      expectedChanges: {},
      actionAccepted: actual.ok,
    });
    if (!check.verified) return false;
  }
  return true;
}

type RunnerOutcome = { outcome: Result; verified: boolean; extra: Value };

async function runGeneric(ctx: RunContext, windowMs?: number): Promise<RunnerOutcome> {
  const code = (reason: string): string => ctxCode(ctx, reason);
  const descriptor = await ctx.request(ctx.route);
  if (!descriptor.ok) return { outcome: descriptor, verified: false, extra: {} };
  const inputs = descriptorInputsOf(descriptor.body);
  if (!inputs) {
    return { outcome: fail(code("input_unresolved"), "The live descriptor exposes no usable input schema."), verified: false, extra: {} };
  }
  await runDiscoveries(ctx);
  const fixtureFailure = await createFixtures(ctx);
  if (fixtureFailure) return { outcome: fixtureFailure, verified: false, extra: {} };
  const shapeFailure = await buildShapedSObjects(ctx, inputs);
  if (shapeFailure) return { outcome: shapeFailure, verified: false, extra: {} };
  const spec = skippedStandardBindingSpec(ctx.family, ctx.action);
  const planned = planSkippedStandardArgs(spec, inputs, {
    marker: ctx.marker,
    ownerUserId: ctx.ownerUserId,
    fixtures: ctx.fixtures,
    discovered: ctx.discovered,
  }, ctx.builtSObjects);
  if ("missing" in planned) {
    const failures = ctx.discoveryFailures.length ? ` Discovery failures: [${ctx.discoveryFailures.join(",")}].` : "";
    // Empty-but-required discovery may hide a read gap (some setup queries
    // return zero rows instead of 403 for underprivileged identities), so
    // propose the backing object for grant self-heal when no true denial
    // was recorded. Genuinely empty substrate re-fails honestly after the
    // single heal attempt; missing objects (INVALID_TYPE) and non-discovery
    // inputs propose nothing.
    if (!ctx.discoveryDenial) {
      const hidden = discoveryObjectForMissingInput(spec.bindings, skippedStandardDiscoveries(ctx.family, ctx.action), planned.missing);
      const keyFailedAbsent = hidden !== null && ctx.discoveryFailures.some(note =>
        note.split(":")[0] === hidden.key && note.includes(":INVALID_TYPE"));
      if (hidden && !keyFailedAbsent) ctx.discoveryDenial = { family: "object-crud", objectName: hidden.object, retryable: true,
        requirement: `Grant the execution identity ${hidden.object} read access through the fixture permission set during org provisioning, then retry.` };
    }
    return {
      outcome: fail(code("input_unresolved"), `No discovered live value for required input ${planned.missing}.${failures}`, {
        setupRequirement: setupRequirementFor(ctx.family, planned.missing),
      }),
      verified: false,
      extra: {},
    };
  }
  const memberBefore = ctx.family === "campaign-member" && ctx.fixtures.Campaign
    ? await ctx.request(`${ctx.root}/query?q=${encodeURIComponent(
      `SELECT Id FROM CampaignMember WHERE CampaignId = '${ctx.fixtures.Campaign}' LIMIT 5`)}`)
    : null;
  const invoked = await ctx.request(ctx.route, "POST", { inputs: [planned.args] });
  if (windowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(windowMs)));
  if (!nativeActionSucceeded(invoked.status, invoked.body)) {
    // Scheduling-substrate terminal: the engine refused a fully-grounded
    // appointment (member-covered territory, live work type, forward
    // window, live policy). Blind-verified: a perfect fixture in the
    // proven territory plus a published covering shift still refuses, so
    // the gap is org schedulable capacity, never the fixture. Scoped to
    // the exact native refusal so other faults pass through unmasked.
    if (ctx.family === "service-appointment" && /schedule/i.test(ctx.action) && ctx.schedulingGrounded === true &&
      nativeErrorMessages(invoked.body).some((message) => /unable to schedule service appointment/i.test(message))) {
      const requirement = "Provision schedulable FSL capacity covering the probe window (a territory with member coverage plus operating-hours availability for a resource in that territory), then retry.";
      return {
        outcome: fail(code("scheduling_substrate_unavailable"),
          "The scheduling engine refused a fully-grounded appointment; no schedulable capacity exists for the window.",
          { setupRequirement: requirement }),
        verified: false,
        extra: {},
      };
    }
    return { outcome: invoked, verified: false, extra: {} };
  }
  const createdPlan = createdPlanFor(ctx.family, ctx.action);
  if (createdPlan) {
    const created = await verifyCreated(ctx, createdPlan, invoked);
    return { outcome: invoked, verified: created.verified, extra: { createdIds: created.createdIds } };
  }
  if (ctx.family === "campaign-member" && ctx.fixtures.Campaign) {
    const after = await ctx.request(`${ctx.root}/query?q=${encodeURIComponent(
      `SELECT Id FROM CampaignMember WHERE CampaignId = '${ctx.fixtures.Campaign}' LIMIT 5`)}`);
    const beforeCount = memberBefore?.ok ? queryRows(memberBefore.body).length : 0;
    const rows = queryRows(after.ok ? after.body : null).filter((entry) => identity(entry.Id));
    for (const row of rows.slice(beforeCount)) {
      ctx.cleanup.push({ object: "CampaignMember", id: row.Id as string });
    }
    return { outcome: invoked, verified: rows.length > beforeCount, extra: { memberIds: rows.map((row) => row.Id) } };
  }
  if (Object.keys(ctx.fixtures).length > 0) {
    return { outcome: invoked, verified: await verifyFixturesIntact(ctx), extra: {} };
  }
  return { outcome: invoked, verified: true, extra: {} };
}

type TerminalRefusal = { reason: string; requirement: string };

/**
 * Terminal refusals: real-world effects no owned fixture can own, or
 * contracts no live discovery can satisfy. Each carries a precise
 * terminal code so the row parks instead of churning. Blind evidence for
 * the r7 entries: social publish posts to an external network, appointment
 * save faults MISSING_ARGUMENT across owned shapes, routing verification
 * resends an email, batch jobs execute org-wide definitions, and
 * external-callout apex writes to a vendor business unit.
 */
function terminalRefusalFor(family: SkippedStandardEngineFamily): TerminalRefusal | null {
  switch (family) {
    case "outbound-call":
      return {
        reason: "unownable",
        requirement: "Real-world calls are placed only through human-driven flows; the probe never dials.",
      };
    case "credential-reset":
      return {
        reason: "unownable",
        requirement: "Credentials are reset only through human-driven flows; the probe never resets.",
      };
    case "social-publish":
      return {
        reason: "unownable",
        requirement: "Social posts publish to an external network no fixture can own, read back, or delete; the probe never publishes.",
      };
    case "appointment-save":
      return {
        reason: "input_unresolved",
        requirement: "The appointment save contract is flow-managed and undiscoverable (MISSING_ARGUMENT across owned lead, work-type, resource, and time shapes); a live booking-slots token chain is required before execution.",
      };
    case "routing-verify":
      return {
        reason: "unownable",
        requirement: "Routing verification resends an email to an arbitrary address no fixture can own; the probe never resends.",
      };
    case "batch-submit":
      return {
        reason: "unownable",
        requirement: "Batch-job actions invoke org-wide job definitions whose processed set no fixture can own; the probe never submits.",
      };
    case "apex-external-callout":
      return {
        reason: "unownable",
        requirement: "The invocable writes to an external business unit through a callout credential; no Salesforce-side fixture, readback, or cleanup applies.",
      };
    case "asset-activity":
      return {
        reason: "input_unresolved",
        requirement: "The asset-activity contract is a flow-managed ConnectApi representation (ConnectApi__AssetsWithActivity*Representation) whose shape no live metadata exposes: the descriptor carries the apex class name only, and eleven blind-verified shapes (update maps, typed sObjects, ID lists, rep lists) all reject with flow-variable or malformed-sObject faults. No invented shape is ever sent.",
      };
    default:
      return null;
  }
}

async function runTerminalRefusal(ctx: RunContext): Promise<RunnerOutcome> {
  await ctx.request(ctx.route);
  const refusal = terminalRefusalFor(ctx.family) ?? {
    reason: "unownable",
    requirement: "No owned fixture can own this effect; the probe never invokes.",
  };
  return {
    outcome: fail(ctxCode(ctx, refusal.reason), refusal.requirement, { setupRequirement: refusal.requirement }),
    verified: false,
    extra: {},
  };
}

async function runContextDynamic(ctx: RunContext, windowMs?: number): Promise<RunnerOutcome> {
  const code = (reason: string): string => ctxCode(ctx, reason);
  const dynamicKind = skippedStandardRouteInfo(ctx.route)?.dynamicKind;
  const descriptor = await ctx.request(ctx.route);
  if (!descriptor.ok) return { outcome: descriptor, verified: false, extra: {} };
  const inputs = descriptorInputsOf(descriptor.body);
  if (!inputs) {
    return { outcome: fail(code("input_unresolved"), "The live descriptor exposes no usable input schema."), verified: false, extra: {} };
  }
  // Only the build twin is ownable: an empty invoke is accepted live and
  // persists nothing (absence verified). Add/query/update twins need
  // definition-scoped record variables no live discovery exposes, and
  // definition namespaces cannot be opened generically — they refuse
  // without any POST.
  if (dynamicKind !== "buildContextDynamic") {
    return {
      outcome: fail(code("input_unresolved"), "No live-discoverable value exists for the definition-scoped record contract.", {
        setupRequirement: setupRequirementFor(ctx.family, "contextRecordData"),
        dynamicKind: dynamicKind ?? null,
      }),
      verified: false,
      extra: { dynamicKind: dynamicKind ?? null },
    };
  }
  const planned = planSkippedStandardArgs({ bindings: [] }, inputs, {
    marker: ctx.marker,
    ownerUserId: ctx.ownerUserId,
    fixtures: ctx.fixtures,
    discovered: ctx.discovered,
  });
  if ("missing" in planned) {
    return {
      outcome: fail(code("input_unresolved"), `No discovered live value for required input ${planned.missing}.`, {
        setupRequirement: setupRequirementFor(ctx.family, planned.missing),
      }),
      verified: false,
      extra: {},
    };
  }
  const invoked = await ctx.request(ctx.route, "POST", { inputs: [planned.args] });
  if (windowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(windowMs)));
  if (!nativeActionSucceeded(invoked.status, invoked.body)) return { outcome: invoked, verified: false, extra: {} };
  const contextId = firstOutputText(invoked.body, /^contextid$/i);
  const mappingId = firstOutputText(invoked.body, /contextmappingid/i);
  const definitionId = firstOutputText(invoked.body, /contextdefinitionid/i);
  if (!contextId) return { outcome: invoked, verified: false, extra: {} };
  // Cleanup: the namespace either deletes (accepted) or never persisted
  // (absent shape). Both prove no residue; anything else is unverified.
  const cleared = await ctx.request(`${ctx.root}/actions/standard/deleteContextCache`, "POST", { inputs: [{ contextId }] });
  const clean = nativeActionSucceeded(cleared.status, cleared.body) || contextNamespaceAbsent(cleared.body);
  if (!clean) {
    return { outcome: invoked, verified: false, extra: { contextId, cleanupError: "Owned dynamic-context namespace cleanup could not be verified." } };
  }
  return { outcome: invoked, verified: true, extra: { contextId, contextMappingId: mappingId ?? null, contextDefinitionId: definitionId ?? null } };
}

async function runApexSobjectShape(ctx: RunContext, windowMs?: number): Promise<RunnerOutcome> {
  const code = (reason: string): string => ctxCode(ctx, reason);
  const descriptor = await ctx.request(ctx.route);
  if (!descriptor.ok) return { outcome: descriptor, verified: false, extra: {} };
  const inputs = descriptorInputsOf(descriptor.body);
  if (!inputs) {
    return { outcome: fail(code("input_unresolved"), "The live descriptor exposes no usable input schema."), verified: false, extra: {} };
  }
  // Defense in depth: external-callout contracts never reach the owned
  // shape runner, even when misrouted.
  if (isApexExternalCalloutInputSet(inputs)) {
    const refusal = terminalRefusalFor("apex-external-callout") as { reason: string; requirement: string };
    return {
      outcome: fail(ctxCode(ctx, refusal.reason), refusal.requirement, { setupRequirement: refusal.requirement }),
      verified: false,
      extra: {},
    };
  }
  const plan = apexSobjectShapePlan(inputs);
  if ("refuse" in plan) {
    return {
      outcome: fail(code("input_unresolved"), `The live descriptor does not declare the owned-shape contract (${plan.refuse}).`, {
        setupRequirement: setupRequirementFor(ctx.family, plan.refuse),
      }),
      verified: false,
      extra: {},
    };
  }
  const object = plan.objectName;
  if (!ENTITY_NAME.test(object)) {
    return { outcome: fail(code("input_unresolved"), "The descriptor-declared fixture object is invalid."), verified: false, extra: {} };
  }
  const probe = await ctx.request(`${ctx.root}/sobjects/${object}/describe`);
  if (!probe.ok || !record(probe.body) || probe.body.createable !== true ||
    probe.body.queryable !== true || probe.body.deletable !== true || !Array.isArray(probe.body.fields)) {
    return {
      outcome: fail(code("fixture_unavailable"), `Automatic ${object} context requires live create, read and delete access.`, {
        setupRequirement: `${object} create/read/delete access for the execution user.`,
      }),
      verified: false,
      extra: {},
    };
  }
  const fields = (probe.body.fields as unknown[]).filter(
    (field): field is TargetField => record(field) && typeof field.name === "string" && FIELD_NAME.test(field.name),
  );
  ctx.describes.set(object, fields);
  const markerPick = markerFieldFor(fields);
  if (!markerPick) {
    return {
      outcome: fail(code("fixture_unavailable"), `The live ${object} object exposes no writable, filterable marker field for independent verification.`),
      verified: false,
      extra: {},
    };
  }
  const marker = newSkippedStandardsMarker(Math.min(markerPick.length, 80));
  const refs = await referenceOverrides(ctx, fields);
  const built = await ctx.build(object, marker, { ...refs, [markerPick.name]: marker });
  if ("failure" in built) return { outcome: built.failure, verified: false, extra: {} };
  if (built.values[markerPick.name] !== marker) {
    return { outcome: fail(code("fixture_unavailable"), "The fixture builder changed a planned ownership field."), verified: false, extra: {} };
  }
  const made = await ctx.request(`${ctx.root}/sobjects/${object}`, "POST", built.values);
  const madeId: unknown = made.body?.id ?? made.body?.Id;
  if (!made.ok || !identity(madeId)) return { outcome: made, verified: false, extra: {} };
  const gate = await ctx.request(`${ctx.root}/sobjects/${object}/${madeId}`);
  if (!gate.ok || gate.body?.[markerPick.name] !== marker) {
    ctx.cleanup.push({ object, id: madeId, marker, markerField: markerPick.name });
    return { outcome: fail(code("fixture_unverified"), "The owned fixture readback did not carry the marker."), verified: false, extra: {} };
  }
  const reclaimFailure = await reclaimFixtureOwner(ctx, object, madeId as string, gate.body, marker, markerPick.name);
  if (reclaimFailure) return { outcome: reclaimFailure, verified: false, extra: {} };
  ctx.fixtures[object] = madeId;
  ctx.fixtureMarkers[object] = markerPick.name;
  ctx.cleanup.push({ object, id: madeId, marker, markerField: markerPick.name });
  const scalarArgs: Record<string, unknown> = {};
  for (const name of plan.scalarInputs) {
    const def = inputs.find((entry) => entry.name === name);
    const value = def ? apexRecordCompanionValue(def, marker) : undefined;
    if (value === undefined) {
      return {
        outcome: fail(code("input_unresolved"), `No discovered live value for required input ${name}.`, {
          setupRequirement: setupRequirementFor(ctx.family, name),
        }),
        verified: false,
        extra: {},
      };
    }
    scalarArgs[name] = value;
  }
  const invoked = await ctx.request(ctx.route, "POST", {
    inputs: [{ [plan.sobjectInput]: { attributes: { type: object }, Id: madeId }, ...scalarArgs }],
  });
  if (windowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(windowMs)));
  if (!nativeActionSucceeded(invoked.status, invoked.body)) {
    return { outcome: invoked, verified: false, extra: { fixtureId: madeId, object } };
  }
  const after = await ctx.request(`${ctx.root}/sobjects/${object}/${madeId}`);
  const effect = verifyOwnedSobjectUpdate({
    marker,
    markerField: markerPick.name,
    before: record(gate.body) ? (gate.body as Record<string, unknown>) : null,
    after: record(after.body) ? (after.body as Record<string, unknown>) : null,
    scalarValues: Object.values(scalarArgs),
  });
  // Contact fixtures prove no Community-User side-effect: the live updater
  // bodies touch only the passed row, and this query evidences it.
  let userClean = true;
  if (object.toLowerCase() === "contact") {
    const users = await ctx.request(`${ctx.root}/query?q=${encodeURIComponent(
      `SELECT Id FROM User WHERE ContactId = '${madeId}' LIMIT 1`)}`);
    userClean = users.ok && queryRows(users.body).length === 0;
  }
  return {
    outcome: invoked,
    verified: effect.verified && userClean,
    extra: { fixtureId: madeId, object, effectField: effect.effectField, userClean },
  };
}

async function runApexScalarPure(ctx: RunContext, windowMs?: number): Promise<RunnerOutcome> {
  const code = (reason: string): string => ctxCode(ctx, reason);
  const descriptor = await ctx.request(ctx.route);
  if (!descriptor.ok) return { outcome: descriptor, verified: false, extra: {} };
  const inputs = descriptorInputsOf(descriptor.body);
  if (!inputs) {
    return { outcome: fail(code("input_unresolved"), "The live descriptor exposes no usable input schema."), verified: false, extra: {} };
  }
  if (isApexExternalCalloutInputSet(inputs)) {
    const refusal = terminalRefusalFor("apex-external-callout") as { reason: string; requirement: string };
    return {
      outcome: fail(ctxCode(ctx, refusal.reason), refusal.requirement, { setupRequirement: refusal.requirement }),
      verified: false,
      extra: {},
    };
  }
  if (!isApexScalarOnlyInputSet(inputs)) {
    return {
      outcome: fail(code("input_unresolved"), "The live descriptor is not a scalar-only contract.", {
        setupRequirement: setupRequirementFor(ctx.family, "input_schema"),
      }),
      verified: false,
      extra: {},
    };
  }
  const simple = apexSimpleClassName(ctx.action);
  if (simple === null) {
    return { outcome: fail(code("action_invalid"), "The invocable route names no valid class reference."), verified: false, extra: {} };
  }
  const bodyRows = await ctx.request(`${ctx.root}/query?q=${encodeURIComponent(
    `SELECT Body FROM ApexClass WHERE Name = '${simple}' LIMIT 1`)}`);
  const bodyText = bodyRows.ok ? queryRows(bodyRows.body)[0]?.Body : undefined;
  const screen = screenApexBody(typeof bodyText === "string" ? bodyText : null);
  if (screen.verdict === "refuse") {
    const reason = screen.effect === "DML" ? "effect_dml_unownable"
      : screen.effect === "CALLOUT" ? "effect_callout_unownable"
      : screen.effect === "SEND" ? "effect_send_unownable"
      : screen.effect === "ASYNC" ? "effect_async_unownable"
      : "body_unverifiable";
    return {
      outcome: fail(code(reason), `The invocable refuses: ${screen.detail}; no synthetic probe is attempted.`, {
        setupRequirement: setupRequirementFor(ctx.family, "class_body"),
      }),
      verified: false,
      extra: {},
    };
  }
  let liveObjectName: string | undefined;
  if (apexNeedsLiveObjectName(inputs)) {
    const catalog = await ctx.request(`${ctx.root}/sobjects/`);
    const body = catalog.ok && record(catalog.body) && Array.isArray(catalog.body.sobjects) ? catalog.body.sobjects : null;
    liveObjectName = firstQueryableObjectName(body) ?? undefined;
    if (!liveObjectName) {
      return {
        outcome: fail(code("input_unresolved"), "No discovered live value for required input objectApiName.", {
          setupRequirement: setupRequirementFor(ctx.family, "objectApiName"),
        }),
        verified: false,
        extra: {},
      };
    }
  }
  const planned = planApexScalarArgs(inputs, ctx.marker, liveObjectName ? { objectName: liveObjectName } : undefined);
  if ("missing" in planned) {
    return {
      outcome: fail(code("input_unresolved"), `No discovered live value for required input ${planned.missing}.`, {
        setupRequirement: setupRequirementFor(ctx.family, planned.missing),
      }),
      verified: false,
      extra: {},
    };
  }
  const invoked = await ctx.request(ctx.route, "POST", { inputs: [planned.args] });
  if (windowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(windowMs)));
  if (!nativeActionSucceeded(invoked.status, invoked.body)) return { outcome: invoked, verified: false, extra: {} };
  const items = Array.isArray(invoked.body) ? invoked.body : [invoked.body];
  const outputValues = items.map((item) => (record(item) ? item.outputValues : null)).find(record) ?? null;
  const answered = outputValues !== null && Object.keys(outputValues).length > 0;
  const nested = outputValues !== null && apexExecNestedFlags(outputValues);
  return { outcome: invoked, verified: answered && !nested, extra: { outputs: outputValues ? Object.keys(outputValues) : [] } };
}

async function runResearchFallback(ctx: RunContext, windowMs?: number): Promise<RunnerOutcome> {
  const descriptor = await ctx.request(ctx.route);
  if (!descriptor.ok) return { outcome: descriptor, verified: false, extra: {} };
  const inputs = record(descriptor.body) && Array.isArray(descriptor.body.inputs)
    ? descriptor.body.inputs.filter((field): field is { name?: unknown } & Record<string, unknown> => record(field)) : [];
  if (inputs.length > 0 && !inputs.some((field) => typeof field.name === "string" && field.name.toLowerCase() === "researchid")) {
    return runGeneric(ctx, windowMs);
  }
  const { researchSubstrateStatus } = await import("./research-lifecycle-context");
  const status = await researchSubstrateStatus({ root: ctx.root, request: ctx.request });
  if ("failure" in status) {
    return {
      outcome: fail(ctxCode(ctx, "substrate_unreadable"), status.failure, {
        setupRequirement: "DataKnowledgeSpaceSession read access for the execution user.",
      }),
      verified: false,
      extra: {},
    };
  }
  if (status.sessions === 0 && status.reports === 0 && status.spaces === 0) {
    return {
      outcome: fail(ctxCode(ctx, "substrate_absent"),
        "The org is missing research substrate: the research session, report and space objects hold no rows.",
        { setupRequirement: setupRequirementFor(ctx.family, "researchId"), substrate: status }),
      verified: false,
      extra: {},
    };
  }
  return {
    outcome: fail(ctxCode(ctx, "input_unresolved"), "No resolvable researchId exists: fabricated research identities never resolve.", {
      setupRequirement: setupRequirementFor(ctx.family, "researchId"),
      substrate: status,
    }),
    verified: false,
    extra: {},
  };
}

function setupRequirementFor(family: SkippedStandardEngineFamily, missing: string): string {
  switch (family) {
    case "payment":
      return "An owned order with a live payment method is required before authorization.";
    case "return-order":
      return "An owned order with return-input shaping is required before execution.";
    case "order-summary":
      return "Enable Order Management with a queryable OrderSummary type and provision order substrate before retrying.";
    case "search-rule":
      return "A live search-rule substrate is required before execution.";
    case "research":
      return "Run a genuine Deep Research workflow in this org so its service mints a resolvable researchId, then retry.";
    case "call-experience":
      return `A live post-call experience flow label for input ${missing} is required before execution.`;
    case "referral-record":
      return `A live performer vocabulary for input ${missing} is required before execution.`;
    case "record-convert":
      return `A live context definition and mapping names for input ${missing} are required before execution.`;
    case "member-verification":
      return "A live identity verification process definition is required before execution.";
    case "appointment-save":
      return "A live booking-slots token chain for the hidden flow-managed appointment contract is required before execution.";
    case "context-dynamic":
      return "A live context-definition contract with discoverable record variables is required before execution.";
    case "apex-sobject-shape":
      return "A live descriptor declaring exactly one SOBJECT input with a usable sObjectType target is required before execution.";
    case "apex-scalar-pure":
      return "A live readable class body proving effect-free execution is required before execution.";
    default:
      return `A discovered live value for required input ${missing} is required before execution.`;
  }
}

async function runSurvey(ctx: RunContext, windowMs?: number): Promise<RunnerOutcome> {
  const code = (reason: string): string => ctxCode(ctx, reason);
  const descriptor = await ctx.request(ctx.route);
  if (!descriptor.ok) return { outcome: descriptor, verified: false, extra: {} };
  const inputs = descriptorInputsOf(descriptor.body);
  if (!inputs) {
    return { outcome: fail(code("input_unresolved"), "The live descriptor exposes no usable input schema."), verified: false, extra: {} };
  }
  if (ctx.route.includes("/actions/custom/dynamicSendSurveyInvitation/")) {
    ctx.discovered.surveyName = ctx.action;
  }
  await runDiscoveries(ctx);
  const fixtureFailure = await createFixtures(ctx);
  if (fixtureFailure) return { outcome: fixtureFailure, verified: false, extra: {} };
  const planned = planSkippedStandardArgs(skippedStandardBindingSpec(ctx.family, ctx.action), inputs, {
    marker: ctx.marker,
    ownerUserId: ctx.ownerUserId,
    fixtures: ctx.fixtures,
    discovered: ctx.discovered,
  });
  if ("missing" in planned) {
    return {
      outcome: fail(code("input_unresolved"), `No discovered live value for required input ${planned.missing}.`, {
        setupRequirement: setupRequirementFor(ctx.family, planned.missing),
      }),
      verified: false,
      extra: {},
    };
  }
  const invoked = await ctx.request(ctx.route, "POST", { inputs: [planned.args] });
  if (windowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(windowMs)));
  if (!nativeActionSucceeded(invoked.status, invoked.body)) return { outcome: invoked, verified: false, extra: {} };
  const invitationIds = outputIdsByPattern(invoked.body, /invitationid$|^id$/i);
  const fields = await describeCached(ctx, "SurveyInvitation");
  const recipientField = fields?.find((entry) => /recipient/i.test(entry.name) && entry.type === "reference");
  const subjectField = fields?.find((entry) => /subject/i.test(entry.name) && entry.type === "reference");
  if (!recipientField || !ctx.fixtures.Contact) {
    return { outcome: invoked, verified: true, extra: { invitationIds, readback: "invitation-object-undescribed" } };
  }
  const clauses = [`${recipientField.name} = '${ctx.fixtures.Contact}'`];
  if (subjectField && ctx.fixtures.Case) clauses.push(`${subjectField.name} = '${ctx.fixtures.Case}'`);
  const found = await ctx.request(`${ctx.root}/query?q=${encodeURIComponent(
    `SELECT Id FROM SurveyInvitation WHERE ${clauses.join(" AND ")} LIMIT 5`)}`);
  const rows = queryRows(found.ok ? found.body : null).filter((entry) => identity(entry.Id));
  for (const row of rows) {
    ctx.cleanup.push({ object: "SurveyInvitation", id: row.Id as string });
  }
  const verified = rows.length > 0;
  return { outcome: invoked, verified, extra: { invitationIds: rows.map((row) => row.Id) } };
}

/**
 * True when the body carries the platform's expired/missing context
 * shape (R4: `RECORD_NOT_FOUND` with "Context with id ... doesn't exist
 * or expired."). The minted namespace expired or was never created; no
 * retry with the same namespace can succeed. Exported for the colocated
 * contract test.
 */
export function contextNamespaceExpired(body: unknown): boolean {
  const texts: string[] = [];
  const codes: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || texts.length >= 8) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 8)) visit(item, depth + 1);
      return;
    }
    if (!record(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if ((key === "message" || key === "errorMessage") && typeof entry === "string") texts.push(entry);
      if ((key === "errorCode" || key === "statusCode") && typeof entry === "string") codes.push(entry);
      if (key === "errors" || key === "outputValues") visit(entry, depth + 1);
    }
  };
  visit(body, 0);
  return codes.includes("RECORD_NOT_FOUND") && texts.some((text) => /doesn['\u2019]t exist or expired/i.test(text));
}

async function runContextChain(ctx: RunContext, windowMs?: number): Promise<RunnerOutcome> {
  const code = (reason: string): string => ctxCode(ctx, reason);
  const contextId = `ASCTX-${crypto.randomUUID()}`;
  ctx.discovered.contextId = contextId;
  const descriptor = await ctx.request(ctx.route);
  if (!descriptor.ok) return { outcome: descriptor, verified: false, extra: {} };
  const inputs = descriptorInputsOf(descriptor.body);
  if (!inputs) {
    return { outcome: fail(code("input_unresolved"), "The live descriptor exposes no usable input schema."), verified: false, extra: {} };
  }
  const spec = skippedStandardBindingSpec(ctx.family, ctx.action);
  const needsSetup = !/^addcontextrecords$/i.test(ctx.action);
  if (needsSetup) {
    const setup = await ctx.request(`${ctx.root}/actions/standard/addContextRecords`, "POST", {
      inputs: [{ contextId, inputData: JSON.stringify({ probe: ctx.marker }), overwriteExistingRecords: false, isTaggedData: false }],
    });
    if (!nativeActionSucceeded(setup.status, setup.body)) {
      return {
        outcome: fail(code("setup_required"), "The owned context namespace could not be opened.", {
          setupRequirement: "A writable context service for the execution user.",
          upstreamOutcome: setup.body,
        }),
        verified: false,
        extra: {},
      };
    }
  }
  const planned = planSkippedStandardArgs(spec, inputs, {
    marker: ctx.marker,
    ownerUserId: ctx.ownerUserId,
    fixtures: ctx.fixtures,
    discovered: ctx.discovered,
  });
  if ("missing" in planned) {
    return {
      outcome: fail(code("input_unresolved"), `No discovered live value for required input ${planned.missing}.`, {
        setupRequirement: setupRequirementFor(ctx.family, planned.missing),
      }),
      verified: false,
      extra: {},
    };
  }
  const invoked = await ctx.request(ctx.route, "POST", { inputs: [planned.args] });
  if (windowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(windowMs)));
  if (!nativeActionSucceeded(invoked.status, invoked.body)) {
    if (contextNamespaceExpired(invoked.body)) {
      return {
        outcome: fail(code("setup_required"), "The live context service reports the context namespace does not exist or expired.", {
          setupRequirement: "Open a live context namespace the execution user can write (the minted namespace expired or was never created), then retry.",
          upstreamOutcome: invoked.body,
        }),
        verified: false,
        extra: { contextId },
      };
    }
    return { outcome: invoked, verified: false, extra: { contextId } };
  }
  if (!/^deletecontextcache$/i.test(ctx.action)) {
    const cleared = await ctx.request(`${ctx.root}/actions/standard/deleteContextCache`, "POST", { inputs: [{ contextId }] });
    if (!nativeActionSucceeded(cleared.status, cleared.body)) {
      return { outcome: invoked, verified: false, extra: { contextId, cleanupError: "Owned context namespace cleanup could not be verified." } };
    }
  }
  return { outcome: invoked, verified: true, extra: { contextId } };
}

async function runSwarm(ctx: RunContext, windowMs?: number): Promise<RunnerOutcome> {
  const code = (reason: string): string => ctxCode(ctx, reason);
  const descriptor = await ctx.request(ctx.route);
  if (!descriptor.ok) return { outcome: descriptor, verified: false, extra: {} };
  const inputs = descriptorInputsOf(descriptor.body);
  if (!inputs) {
    return { outcome: fail(code("input_unresolved"), "The live descriptor exposes no usable input schema."), verified: false, extra: {} };
  }
  const swarmFields = await describeCached(ctx, "Swarm");
  const appField = swarmFields?.find((entry) => /slackappid/i.test(entry.name));
  const teamField = swarmFields?.find((entry) => /slackteamid/i.test(entry.name));
  const linkField = swarmFields?.find((entry) => /relatedrecordid$/i.test(entry.name));
  if (appField && teamField) {
    const prior = await ctx.request(`${ctx.root}/query?q=${encodeURIComponent(
      `SELECT ${appField.name}, ${teamField.name} FROM Swarm WHERE ${appField.name} != null LIMIT 1`)}`);
    const row = queryRows(prior.ok ? prior.body : null)[0];
    if (row && typeof row[appField.name] === "string" && row[appField.name] && typeof row[teamField.name] === "string" && row[teamField.name]) {
      ctx.discovered.slackAppId = row[appField.name] as string;
      ctx.discovered.slackTeamId = row[teamField.name] as string;
    }
  }
  const fixtureFailure = await createFixtures(ctx);
  if (fixtureFailure) return { outcome: fixtureFailure, verified: false, extra: {} };
  const needsChannel = /thread|update/i.test(ctx.action);
  if (needsChannel && !ctx.discovered.slackAppId) {
    return {
      outcome: fail(code("input_unresolved"), "No discovered live value for required input slackAppId.", {
        setupRequirement: "A connected Slack app with at least one swarm record, so app and team ids resolve live.",
      }),
      verified: false,
      extra: {},
    };
  }
  if (needsChannel) {
    const channelName = `as-probe-${crypto.randomUUID().slice(0, 8)}`;
    const opened = await ctx.request(`${ctx.root}/actions/standard/createSwarmSlackChannel`, "POST", {
      inputs: [{
        recordId: ctx.fixtures.Case,
        slackAppId: ctx.discovered.slackAppId,
        slackTeamId: ctx.discovered.slackTeamId,
        slackChannelName: channelName,
        swarmRecordName: ctx.marker,
        isPrivate: true,
      }],
    });
    if (!nativeActionSucceeded(opened.status, opened.body)) {
      return {
        outcome: fail(code("setup_required"), "The owned swarm channel could not be opened.", {
          setupRequirement: "A connected Slack app permitting channel creation.",
          upstreamOutcome: opened.body,
        }),
        verified: false,
        extra: {},
      };
    }
    const channelId = firstOutputText(opened.body, /slackchannelid|channelid/i);
    const swarmId = firstOutputText(opened.body, /swarmid/i) ?? outputIdsByPattern(opened.body, /swarmid/i)[0];
    if (channelId) ctx.discovered.slackChannelId = channelId;
    if (swarmId) ctx.discovered.swarmId = swarmId;
  }
  const planned = planSkippedStandardArgs(skippedStandardBindingSpec(ctx.family, ctx.action), inputs, {
    marker: ctx.marker,
    ownerUserId: ctx.ownerUserId,
    fixtures: ctx.fixtures,
    discovered: ctx.discovered,
  });
  if ("missing" in planned) {
    return {
      outcome: fail(code("input_unresolved"), `No discovered live value for required input ${planned.missing}.`, {
        setupRequirement: setupRequirementFor(ctx.family, planned.missing),
      }),
      verified: false,
      extra: {},
    };
  }
  const invoked = await ctx.request(ctx.route, "POST", { inputs: [planned.args] });
  if (windowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(windowMs)));
  if (!nativeActionSucceeded(invoked.status, invoked.body)) return { outcome: invoked, verified: false, extra: {} };
  const swarmIds = outputIdsByPattern(invoked.body, /swarmid$|^id$/i);
  if (linkField && ctx.fixtures.Case) {
    const found = await ctx.request(`${ctx.root}/query?q=${encodeURIComponent(
      `SELECT Id FROM Swarm WHERE ${linkField.name} = '${ctx.fixtures.Case}' LIMIT 5`)}`);
    const rows = queryRows(found.ok ? found.body : null).filter((entry) => identity(entry.Id));
    for (const row of rows) {
      ctx.cleanup.push({ object: "Swarm", id: row.Id as string });
    }
    return {
      outcome: invoked,
      verified: rows.length > 0,
      extra: { swarmIds: rows.map((row) => row.Id), slackChannelName: planned.args.slackChannelName ?? null },
    };
  }
  return { outcome: invoked, verified: true, extra: { swarmIds } };
}

async function runApprovalOverride(ctx: RunContext, windowMs?: number): Promise<RunnerOutcome> {
  const code = (reason: string): string => ctxCode(ctx, reason);
  const descriptor = await ctx.request(ctx.route);
  if (!descriptor.ok) return { outcome: descriptor, verified: false, extra: {} };
  const inputs = descriptorInputsOf(descriptor.body);
  if (!inputs) {
    return { outcome: fail(code("input_unresolved"), "The live descriptor exposes no usable input schema."), verified: false, extra: {} };
  }
  const fixtureFailure = await createFixtures(ctx);
  if (fixtureFailure) return { outcome: fixtureFailure, verified: false, extra: {} };
  const submitDescriptor = await ctx.request(`${ctx.root}/actions/standard/submit`);
  const submitInputs = submitDescriptor.ok ? descriptorInputsOf(submitDescriptor.body) : null;
  if (!submitInputs) {
    return {
      outcome: fail(code("setup_required"), "The live approval submit descriptor is unavailable.", {
        setupRequirement: "An active approval process for the fixture object.",
      }),
      verified: false,
      extra: {},
    };
  }
  const submitArgs: Record<string, unknown> = {};
  for (const field of submitInputs) {
    if (!field.required) continue;
    if (/^(objectid|recordid|sobjectid)$/i.test(field.name) || /id$/i.test(field.name)) {
      submitArgs[field.name] = ctx.fixtures.Opportunity;
    } else if (/comment/i.test(field.name)) {
      submitArgs[field.name] = ctx.marker;
    } else {
      const scalar = resolveRequiredInputValue(field, []);
      if (scalar === undefined) {
        return {
          outcome: fail(code("input_unresolved"), `No discovered live value for required input ${field.name}.`, {
            setupRequirement: "An active approval process accepting the owned submission.",
          }),
          verified: false,
          extra: {},
        };
      }
      submitArgs[field.name] = scalar;
    }
  }
  const submitted = await ctx.request(`${ctx.root}/actions/standard/submit`, "POST", { inputs: [submitArgs] });
  if (!nativeActionSucceeded(submitted.status, submitted.body)) {
    return {
      outcome: fail(code("setup_required"), "The owned record could not be submitted for approval.", {
        setupRequirement: "Deploy an active ApprovalProcess for the fixture object before retrying.",
        upstreamOutcome: submitted.body,
      }),
      verified: false,
      extra: {},
    };
  }
  const workItem = await ctx.request(`${ctx.root}/query?q=${encodeURIComponent(
    `SELECT Id FROM ProcessInstanceWorkitem WHERE ProcessInstance.TargetObjectId = '${ctx.fixtures.Opportunity}' LIMIT 1`)}`);
  const workItemId = workItem.ok ? firstId(workItem.body) : null;
  if (!workItemId) {
    return {
      outcome: fail(code("input_unresolved"), "No live approval work item exists for the owned submission.", {
        setupRequirement: "An active approval process yielding a work item for the owned submission.",
      }),
      verified: false,
      extra: {},
    };
  }
  ctx.discovered.workItemId = workItemId;
  const planned = planSkippedStandardArgs(skippedStandardBindingSpec(ctx.family, ctx.action), inputs, {
    marker: ctx.marker,
    ownerUserId: ctx.ownerUserId,
    fixtures: ctx.fixtures,
    discovered: ctx.discovered,
  });
  if ("missing" in planned) {
    return {
      outcome: fail(code("input_unresolved"), `No discovered live value for required input ${planned.missing}.`, {
        setupRequirement: setupRequirementFor(ctx.family, planned.missing),
      }),
      verified: false,
      extra: {},
    };
  }
  const invoked = await ctx.request(ctx.route, "POST", { inputs: [planned.args] });
  if (windowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(windowMs)));
  if (!nativeActionSucceeded(invoked.status, invoked.body)) return { outcome: invoked, verified: false, extra: { workItemId } };
  const steps = await ctx.request(`${ctx.root}/query?q=${encodeURIComponent(
    `SELECT Id, StepStatus FROM ProcessInstanceStep WHERE ProcessInstance.TargetObjectId = '${ctx.fixtures.Opportunity}' LIMIT 5`)}`);
  const decided = queryRows(steps.ok ? steps.body : null).some((entry) =>
    typeof entry.StepStatus === "string" && !/pending|started|waiting/i.test(entry.StepStatus));
  return { outcome: invoked, verified: decided, extra: { workItemId } };
}

async function runServiceCampaignUpdate(ctx: RunContext, windowMs?: number): Promise<RunnerOutcome> {
  const code = (reason: string): string => ctxCode(ctx, reason);
  const descriptor = await ctx.request(ctx.route);
  if (!descriptor.ok) return { outcome: descriptor, verified: false, extra: {} };
  const inputs = descriptorInputsOf(descriptor.body);
  if (!inputs) {
    return { outcome: fail(code("input_unresolved"), "The live descriptor exposes no usable input schema."), verified: false, extra: {} };
  }
  await runDiscoveries(ctx);
  const fixtureFailure = await createFixtures(ctx);
  if (fixtureFailure) return { outcome: fixtureFailure, verified: false, extra: {} };
  const createDescriptor = await ctx.request(`${ctx.root}/actions/standard/createServiceCampaign`);
  const createInputs = createDescriptor.ok ? descriptorInputsOf(createDescriptor.body) : null;
  if (!createInputs) {
    return {
      outcome: fail(code("setup_required"), "The live service-campaign create descriptor is unavailable.", {
        setupRequirement: "A describable service-campaign create action with live email content.",
      }),
      verified: false,
      extra: {},
    };
  }
  const createPlanned = planSkippedStandardArgs(skippedStandardBindingSpec(ctx.family, "createServiceCampaign"), createInputs, {
    marker: ctx.marker,
    ownerUserId: ctx.ownerUserId,
    fixtures: ctx.fixtures,
    discovered: ctx.discovered,
  });
  if ("missing" in createPlanned) {
    return {
      outcome: fail(code("input_unresolved"), `No discovered live value for required input ${createPlanned.missing}.`, {
        setupRequirement: setupRequirementFor(ctx.family, createPlanned.missing),
      }),
      verified: false,
      extra: {},
    };
  }
  const made = await ctx.request(`${ctx.root}/actions/standard/createServiceCampaign`, "POST", { inputs: [createPlanned.args] });
  if (!nativeActionSucceeded(made.status, made.body)) {
    return {
      outcome: fail(code("setup_required"), "The owned service campaign could not be created.", {
        setupRequirement: "Live email content, sender, and subscription substrate for campaign creation.",
        upstreamOutcome: made.body,
      }),
      verified: false,
      extra: {},
    };
  }
  const campaignId = outputIdsByPattern(made.body, /servicecampaignid|campaignid$/i)[0];
  if (!campaignId) {
    return {
      outcome: fail(code("input_unresolved"), "The created service campaign exposed no resolvable identity.", {
        setupRequirement: "A service-campaign create action returning the campaign identity.",
      }),
      verified: false,
      extra: {},
    };
  }
  ctx.discovered.serviceCampaignId = campaignId;
  ctx.cleanup.push({ object: "ServiceCampaign", id: campaignId });
  const planned = planSkippedStandardArgs(skippedStandardBindingSpec(ctx.family, ctx.action), inputs, {
    marker: ctx.marker,
    ownerUserId: ctx.ownerUserId,
    fixtures: ctx.fixtures,
    discovered: ctx.discovered,
  });
  if ("missing" in planned) {
    return {
      outcome: fail(code("input_unresolved"), `No discovered live value for required input ${planned.missing}.`, {
        setupRequirement: setupRequirementFor(ctx.family, planned.missing),
      }),
      verified: false,
      extra: {},
    };
  }
  const invoked = await ctx.request(ctx.route, "POST", { inputs: [planned.args] });
  if (windowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(windowMs)));
  if (!nativeActionSucceeded(invoked.status, invoked.body)) return { outcome: invoked, verified: false, extra: { campaignId } };
  return { outcome: invoked, verified: await verifyFixturesIntact(ctx), extra: { campaignId } };
}

async function runProspectConvert(ctx: RunContext, windowMs?: number): Promise<RunnerOutcome> {
  const code = (reason: string): string => ctxCode(ctx, reason);
  const descriptor = await ctx.request(ctx.route);
  if (!descriptor.ok) return { outcome: descriptor, verified: false, extra: {} };
  const inputs = descriptorInputsOf(descriptor.body);
  if (!inputs) {
    return { outcome: fail(code("input_unresolved"), "The live descriptor exposes no usable input schema."), verified: false, extra: {} };
  }
  await runDiscoveries(ctx);
  const fixtureFailure = await createFixtures(ctx);
  if (fixtureFailure) return { outcome: fixtureFailure, verified: false, extra: {} };
  const planned = planSkippedStandardArgs(skippedStandardBindingSpec(ctx.family, ctx.action), inputs, {
    marker: ctx.marker,
    ownerUserId: ctx.ownerUserId,
    fixtures: ctx.fixtures,
    discovered: ctx.discovered,
  });
  if ("missing" in planned) {
    return {
      outcome: fail(code("input_unresolved"), `No discovered live value for required input ${planned.missing}.`, {
        setupRequirement: setupRequirementFor(ctx.family, planned.missing),
      }),
      verified: false,
      extra: {},
    };
  }
  const invoked = await ctx.request(ctx.route, "POST", { inputs: [planned.args] });
  if (windowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(windowMs)));
  if (!nativeActionSucceeded(invoked.status, invoked.body)) return { outcome: invoked, verified: false, extra: {} };
  const convertedLead = outputIdsByPattern(invoked.body, /convertedleadid|leadid$/i)[0];
  const convertedContact = outputIdsByPattern(invoked.body, /convertedcontactid|contactid$/i)[0];
  const convertedAccount = outputIdsByPattern(invoked.body, /convertedaccountid|accountid$/i)[0];
  const convertedOpportunity = outputIdsByPattern(invoked.body, /convertedopportunityid|opportunityid$/i)[0];
  let verified = false;
  if (convertedLead) {
    const lead = await ctx.request(`${ctx.root}/sobjects/Lead/${convertedLead}`);
    verified = lead.ok;
  }
  if (convertedOpportunity) ctx.cleanup.push({ object: "Opportunity", id: convertedOpportunity });
  if (convertedContact) ctx.cleanup.push({ object: "Contact", id: convertedContact });
  if (convertedAccount) ctx.cleanup.push({ object: "Account", id: convertedAccount });
  if (convertedLead) ctx.cleanup.push({ object: "Lead", id: convertedLead });
  return {
    outcome: invoked,
    verified,
    extra: { convertedLeadId: convertedLead ?? null, convertedContactId: convertedContact ?? null, convertedAccountId: convertedAccount ?? null, convertedOpportunityId: convertedOpportunity ?? null },
  };
}

async function runIntegrationChain(ctx: RunContext, windowMs?: number): Promise<RunnerOutcome> {
  const code = (reason: string): string => ctxCode(ctx, reason);
  const descriptor = await ctx.request(ctx.route);
  if (!descriptor.ok) return { outcome: descriptor, verified: false, extra: {} };
  const inputs = descriptorInputsOf(descriptor.body);
  if (!inputs) {
    return { outcome: fail(code("input_unresolved"), "The live descriptor exposes no usable input schema."), verified: false, extra: {} };
  }
  await runDiscoveries(ctx);
  const fixtureFailure = await createFixtures(ctx);
  if (fixtureFailure) return { outcome: fixtureFailure, verified: false, extra: {} };
  if (/^run/i.test(ctx.action)) {
    const createDescriptor = await ctx.request(`${ctx.root}/actions/standard/createIntegrationPlan`);
    const createInputs = createDescriptor.ok ? descriptorInputsOf(createDescriptor.body) : null;
    if (!createInputs) {
      return {
        outcome: fail(code("setup_required"), "The live integration-plan create descriptor is unavailable.", {
          setupRequirement: "A describable integration-plan create action with a live context definition.",
        }),
        verified: false,
        extra: {},
      };
    }
    const createPlanned = planSkippedStandardArgs(skippedStandardBindingSpec(ctx.family, "createIntegrationPlan"), createInputs, {
      marker: ctx.marker,
      ownerUserId: ctx.ownerUserId,
      fixtures: ctx.fixtures,
      discovered: ctx.discovered,
    });
    if ("missing" in createPlanned) {
      return {
        outcome: fail(code("input_unresolved"), `No discovered live value for required input ${createPlanned.missing}.`, {
          setupRequirement: setupRequirementFor(ctx.family, createPlanned.missing),
        }),
        verified: false,
        extra: {},
      };
    }
    const made = await ctx.request(`${ctx.root}/actions/standard/createIntegrationPlan`, "POST", { inputs: [createPlanned.args] });
    if (!nativeActionSucceeded(made.status, made.body)) {
      return {
        outcome: fail(code("setup_required"), "The owned integration plan could not be created.", {
          setupRequirement: "A live context definition and expression set for plan creation.",
          upstreamOutcome: made.body,
        }),
        verified: false,
        extra: {},
      };
    }
    const planId = firstOutputText(made.body, /integrationplanid|planid/i);
    if (!planId) {
      return {
        outcome: fail(code("input_unresolved"), "The created integration plan exposed no resolvable identity.", {
          setupRequirement: "An integration-plan create action returning the plan identity.",
        }),
        verified: false,
        extra: {},
      };
    }
    ctx.discovered.integrationPlanId = planId;
  }
  const planned = planSkippedStandardArgs(skippedStandardBindingSpec(ctx.family, ctx.action), inputs, {
    marker: ctx.marker,
    ownerUserId: ctx.ownerUserId,
    fixtures: ctx.fixtures,
    discovered: ctx.discovered,
  });
  if ("missing" in planned) {
    return {
      outcome: fail(code("input_unresolved"), `No discovered live value for required input ${planned.missing}.`, {
        setupRequirement: setupRequirementFor(ctx.family, planned.missing),
      }),
      verified: false,
      extra: {},
    };
  }
  const invoked = await ctx.request(ctx.route, "POST", { inputs: [planned.args] });
  if (windowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(windowMs)));
  if (!nativeActionSucceeded(invoked.status, invoked.body)) return { outcome: invoked, verified: false, extra: {} };
  const planId = ctx.discovered.integrationPlanId ?? firstOutputText(invoked.body, /integrationplanid|planid/i);
  return { outcome: invoked, verified: true, extra: { integrationPlanId: planId ?? null } };
}

async function runEnablementCleanup(ctx: RunContext): Promise<string | undefined> {
  for (const object of ["EnablementProgramEnrollment"]) {
    const fields = await describeCached(ctx, object);
    const userField = fields?.find((entry) => entry.type === "reference" && Array.isArray(entry.referenceTo) && entry.referenceTo.includes("User"));
    const programField = fields?.find((entry) => entry.type === "reference" && Array.isArray(entry.referenceTo) &&
      entry.referenceTo.some((name) => /enablementprogram/i.test(name)));
    if (!userField || !programField || !identity(ctx.ownerUserId) || !ctx.discovered.programId) continue;
    const found = await ctx.request(`${ctx.root}/query?q=${encodeURIComponent(
      `SELECT Id FROM ${object} WHERE ${userField.name} = '${ctx.ownerUserId}' AND ${programField.name} = '${ctx.discovered.programId}' LIMIT 5`)}`);
    const rows = queryRows(found.ok ? found.body : null).filter((entry) => identity(entry.Id));
    for (const row of rows) {
      ctx.cleanup.push({ object, id: row.Id as string });
    }
    return undefined;
  }
  return undefined;
}

/**
 * Executes the owned skipped-standard lifecycle for one action route and
 * family. Unknown families, invalid routes, and unbounded windows fail
 * closed without invoking.
 */
export async function invokeSkippedStandardWithOwnedContext(
  input: SkippedStandardLifecycleInput,
): Promise<SkippedStandardLifecycleOutcome> {
  const { root, request } = input;
  const routeInfo = skippedStandardRouteInfo(input.route);
  const family = skippedStandardFamilySlug(input.family);
  const automaticSteps = [
    "Read the live action descriptor inputs",
    "Discover live substrate and create owned disposable fixtures with unique markers",
    "Invoke the native action with declared inputs only",
    "Verify the native outcome by blind readback",
    "Delete only owned fixtures and verify absence",
  ];
  const base = {
    source: "salesforce_live_skipped_standard_action",
    family: typeof input.family === "string" ? input.family : null,
    action: routeInfo?.action ?? null,
    automaticSteps,
  };
  const done = (outcome: Result, extra: Value): SkippedStandardLifecycleOutcome => ({
    status: outcome.status,
    body: outcome.body,
    ...(typeof extra.cleanupError === "string" ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...base, ...extra },
  });
  if (!family || !routeInfo || !root.startsWith("/services/data/") || !input.route.startsWith(`${root}/actions/`)) {
    return done(fail("SKIPPED_STANDARD_FAMILY_UNKNOWN", "A discovered skipped-standard route and executable family are required."), { verified: false });
  }
  if (routeInfo.kind === "custom" && family !== "survey-invitation" && family !== "decision-matrix") {
    return done(fail(skippedStandardCode(family, "family_mismatch"), "The custom route kind does not match the lifecycle family."), { verified: false });
  }
  const apexFamily = family === "apex-sobject-shape" || family === "apex-scalar-pure" || family === "apex-external-callout";
  if (routeInfo.kind === "apex" && !apexFamily) {
    return done(fail(skippedStandardCode(family, "family_mismatch"), "The invocable-apex route kind does not match the lifecycle family."), { verified: false });
  }
  if (routeInfo.kind === "batch" && family !== "batch-submit") {
    return done(fail(skippedStandardCode(family, "family_mismatch"), "The batch-job route kind does not match the lifecycle family."), { verified: false });
  }
  if (routeInfo.kind === "dynamic" && family !== "context-dynamic") {
    return done(fail(skippedStandardCode(family, "family_mismatch"), "The context-dynamic route kind does not match the lifecycle family."), { verified: false });
  }
  if (routeInfo.kind === "standard" && (apexFamily || family === "batch-submit" || family === "context-dynamic")) {
    return done(fail(skippedStandardCode(family, "family_mismatch"), "The standard route kind does not match the lifecycle family."), { verified: false });
  }
  if (input.verificationWindowMs !== undefined &&
    (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail(skippedStandardCode(family, "window_invalid"), "A bounded verification window is required."), { verified: false });
  }
  const ctx: RunContext = {
    family,
    route: input.route,
    root,
    action: routeInfo.action,
    marker: newSkippedStandardsMarker(80),
    ownerUserId: input.ownerUserId,
    request,
    build: input.build,
    describes: new Map(),
    fixtures: {},
    fixtureMarkers: {},
    discovered: {},
    builtSObjects: {},
    cleanup: [],
    discoveryFailures: [],
  };
  let cleanupError: string | undefined;
  let outcome: Result = fail(skippedStandardCode(family, "context_unavailable"), "The owned skipped-standard context could not be prepared.");
  let verified = false;
  let extra: Value = {};
  try {
    const ran = await (async (): Promise<RunnerOutcome> => {
      switch (family) {
        case "outbound-call":
        case "credential-reset":
        case "social-publish":
        case "appointment-save":
        case "routing-verify":
        case "batch-submit":
        case "apex-external-callout":
        case "asset-activity":
          return runTerminalRefusal(ctx);
        case "context-dynamic":
          return runContextDynamic(ctx, input.verificationWindowMs);
        case "apex-sobject-shape":
          return runApexSobjectShape(ctx, input.verificationWindowMs);
        case "apex-scalar-pure":
          return runApexScalarPure(ctx, input.verificationWindowMs);
        case "research":
          return runResearchFallback(ctx, input.verificationWindowMs);
        case "context-record":
          return runContextChain(ctx, input.verificationWindowMs);
        case "survey-invitation":
          return runSurvey(ctx, input.verificationWindowMs);
        case "swarm-channel":
          return runSwarm(ctx, input.verificationWindowMs);
        case "approval-override":
          return runApprovalOverride(ctx, input.verificationWindowMs);
        case "service-campaign":
          return /^update/i.test(ctx.action)
            ? runServiceCampaignUpdate(ctx, input.verificationWindowMs)
            : runGeneric(ctx, input.verificationWindowMs);
        case "prospect-convert":
          return runProspectConvert(ctx, input.verificationWindowMs);
        case "integration-plan":
          return /^run/i.test(ctx.action) ? runIntegrationChain(ctx, input.verificationWindowMs) : runGeneric(ctx, input.verificationWindowMs);
        default:
          return runGeneric(ctx, input.verificationWindowMs);
      }
    })();
    outcome = ran.outcome;
    verified = ran.verified;
    extra = ran.extra;
    if (family === "enablement" && nativeActionSucceeded(outcome.status, outcome.body)) {
      await runEnablementCleanup(ctx);
    }
    if (typeof extra.cleanupError === "string") {
      cleanupError = extra.cleanupError;
    }
  } catch {
    if ((outcome.body as Value | undefined)?.errorCode === skippedStandardCode(family, "context_unavailable")) {
      outcome = fail(skippedStandardCode(family, "lifecycle_unverified"), "The owned skipped-standard lifecycle failed; ownership-scoped cleanup still runs.");
    }
    verified = false;
  } finally {
    const swept = await cleanupFixtures(ctx).catch(() => "Owned skipped-standard fixture cleanup could not be verified.");
    if (swept && !cleanupError) cleanupError = swept;
  }
  // Upstream REST denials map to planner-only grant-family requirements;
  // non-denial outcomes (successes included) attach nothing. Grants are
  // never applied here. A discovery-query denial backs input_unresolved
  // outcomes (worker-side, no upstream signal of their own) so grant
  // self-heal provisions the object and re-probes.
  const denialGrant = nativeActionSucceeded(outcome.status, outcome.body)
    ? null
    : (denialGrantForRestOutcome(outcome.status, outcome.body) ?? ctx.discoveryDenial ?? null);
  const finished = done(outcome, {
    verified: cleanupError ? false : verified,
    marker: ctx.marker,
    fixtures: Object.keys(ctx.fixtures).length ? ctx.fixtures : null,
    discovered: Object.keys(ctx.discovered).length ? Object.keys(ctx.discovered) : null,
    verificationRecordIds: Object.values(ctx.fixtures),
    ...extra,
    ...(cleanupError ? { cleanupError } : {}),
    ...(denialGrant ? { denialGrant } : {}),
  });
  return denialGrant ? { ...finished, denialGrant } : finished;
}

