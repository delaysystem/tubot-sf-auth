/** Managed-flow fault taxonomy.
 *
 * Maps opaque upstream Salesforce managed-flow failures to stable,
 * actionable setup-requirement codes. Every branch is grounded in a fault
 * actually observed through blind CLI verification (independent
 * `sf api request rest` reproduction plus debug-trace element evidence),
 * never in a guessed message.
 *
 * Zero-hardcoding contract: no org IDs, aliases, instance URLs, tenant
 * names, or customer values appear here or in any output. Only
 * Salesforce-standard vocabulary (standard object/field names documented
 * by the platform) and caller-supplied, identifier-validated names are
 * ever interpolated. Raw upstream messages are matched, never echoed.
 */

export type ManagedFlowFaultInput = {
  /** HTTP status of the Actions invocation. */
  status: number;
  /** Sanitized upstream messages already collected by the caller. */
  messages: string[];
  /** Upstream error/status codes already collected by the caller. */
  codes: string[];
  /** outputValues.errorMessage when the envelope succeeded but reported one. */
  outputErrorMessage?: string | null;
  /** True when every returned row has isSuccess=true with no errors array. */
  envelopeSucceeded?: boolean;
  /** True when a live admin describe HAS the field a fault calls missing.
   * Distinguishes hidden-from-execution-user fields (permission gap) from
   * fields absent from the org schema itself (package/schema skew). */
  adminFieldVisible?: boolean;
  /** True when the summarizer's source metadata is independently readable
   * (e.g. the analytics report-type describe returns 200). */
  sourceMetadataReadable?: boolean;
  /** Independently verified invocable the executing interview references but
   * the tenant does not expose (absent from both the live actions
   * descriptor and the ApexClass table). */
  missingInvocable?: string;
  /** Schema element the executing interview references but the live admin
   * schema does not expose to any user. */
  missingSchemaField?: { objectName: string; fieldName: string };
  /** True when the live action descriptor declares at least one input.
   * Splits vendor-internal faults (no inputs: nothing request-side can
   * change the outcome) from input-gap faults (retryable with live
   * structured values). Unknown defaults to the retryable shape: a
   * stranded convertible row is worse than a bounded re-probe. */
  hasInputs?: boolean;
  /** Declared live-descriptor input names. Guards opaque-message branches
   * the same way the other evidence signals do: the branch matches only
   * when a fixed platform-vocabulary input is declared. */
  inputNames?: string[];
};

export type ManagedFlowFault = {
  code:
    | "INVITATION_URL_PREFIX_REQUIRED"
    | "FLOW_QUICK_ACTION_UNRESOLVED"
    | "FLOW_ACTION_ELEMENT_UNRESOLVED"
    | "FLOW_LOOKUP_FIELD_ACCESS_REQUIRED"
    | "PERSON_ACCOUNTS_REQUIRED"
    | "FLOW_LOOKUP_SCHEMA_SKEW"
    | "SEGMENT_CONTEXT_REQUIRED"
    | "SUMMARIZER_BACKEND_UNAVAILABLE"
    | "PROMPT_SESSION_CONTEXT_REQUIRED"
    | "PROMPT_DATA_PROVIDER_UNAVAILABLE"
    | "MANAGED_INVOCABLE_INTERNAL"
    | "AGENTIC_RETRIEVAL_BACKEND_FAULT"
    | "UPSTREAM_ERROR_ID_FAULT"
    | "FLOW_RUN_PERMISSION_REQUIRED"
    | "MANAGED_FLOW_INTERVIEW_START_GACK"
    | "MANAGED_FLOW_EXECUTION_FAULT"
    | "FLOW_EXECUTION_INVOCABLE_MISSING"
    | "FLOW_EXECUTION_SCHEMA_SKEW"
    | "FLOW_AGENT_CONTEXT_REQUIRED"
    | "FLOW_PACKAGE_PERMISSION_REQUIRED"
    | "FLOW_EXTERNAL_CALLOUT_UNAVAILABLE"
    | "FLOW_INPUT_IDENTIFIER_REQUIRED"
    | "MANAGED_TRIGGER_NULL_FAULT"
    | "PACKAGE_TRIGGER_DATA_REQUIRED"
    | "CALLOUT_ENDPOINT_SETUP_REQUIRED"
    | "VENDOR_DML_ROW_FAULT"
    | "INTEGRATION_PROCEDURE_INPUT_UNAVAILABLE"
    | "UDD_TARGET_ENTITY_UNRESOLVABLE"
    | "OWNED_CART_SUBSTRATE_REQUIRED"
    | "VENDOR_EMPTY_RESULT_FAULT"
    | "STRUCTURED_INPUT_VALUE_REQUIRED"
    | "LIVE_INPUT_VALUE_REQUIRED"
    | "DYNAMIC_QUERY_IDENTIFIER_REQUIRED"
    | "JSON_DOCUMENT_INPUT_REQUIRED"
    | "MODEL_INFERENCE_UNAVAILABLE"
    | "SESSION_ASSIGNMENT_REQUIRED"
    | "ALPHANUMERIC_CONTEXT_NAME_REQUIRED"
    | "DECLARED_INPUT_SHAPE_REQUIRED"
    | "PARDOT_DATA_ACCESS_REQUIRED"
    | "SCHEMA_IDENTIFIER_VALUE_REQUIRED"
    | "FLOW_UPSTREAM_ACCESS_REQUIRED"
    | "FLOW_SETUP_RECORD_REQUIRED"
    | "FIELD_ACCESS_REQUIRED";
  /** Fixed setup-requirement text with only validated identifiers. */
  requirement: string;
  /** True when a documented setup change can unblock a retry. */
  retryable: boolean;
  objectName?: string;
  fieldName?: string;
  /** Live setup noun a retry must discover (spaces allowed, letters only). */
  setupNoun?: string;
  actionElement?: string;
  providerName?: string;
  invocableName?: string;
  inputName?: string;
};

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const validName = (value: unknown): value is string =>
  typeof value === "string" && IDENTIFIER.test(value);

/** Prompt data-provider tokens are namespaced (e.g. Kind:name), so the
 * separator is allowed here and nowhere else. */
const PROVIDER_TOKEN = /^[A-Za-z][A-Za-z0-9_:]{0,127}$/;
const validProvider = (value: unknown): value is string =>
  typeof value === "string" && PROVIDER_TOKEN.test(value);

/** External invocable tokens carry one optional dotted segment
 * (e.g. Servicenow.GetServiceRequest); anything else is rejected. */
const CALLOUT_TOKEN = /^[A-Za-z][A-Za-z0-9_]{0,62}(?:\.[A-Za-z][A-Za-z0-9_]{0,62})?$/;
const validCallout = (value: unknown): value is string =>
  typeof value === "string" && CALLOUT_TOKEN.test(value);

/** Generic nouns that never name a usable flow input identifier. */
const NULL_INPUT_STOPLIST = new Set([
  "flow",
  "interview",
  "result",
  "response",
  "output",
  "input",
  "value",
  "argument",
  "it",
  "this",
  "that",
]);

/** Trigger tokens carry a namespace plus handler (`FSL.TR001_Service_BeforeInsert`). */
const TRIGGER_TOKEN =
  /^[A-Za-z][A-Za-z0-9_]{0,62}\.[A-Za-z][A-Za-z0-9_]{0,62}$/;
const validTrigger = (value: unknown): value is string =>
  typeof value === "string" && TRIGGER_TOKEN.test(value);

/** Platform-vocabulary inputs that bind live schema identifiers (object or
 * field API names). Declaring one proves an opaque fault is input-caused:
 * blind values never resolve schema. */
const SCHEMA_IDENTIFIER_INPUTS = new Set([
  "objectname",
  "objectapiname",
  "sobjectname",
  "sobjectapiname",
  "entityname",
  "entityapiname",
  "fieldname",
  "fieldapiname",
]);

/** Validated DML field names from a `Required fields are missing` / field
 * fault list (`[Name, CartId]`). Cap keeps the requirement bounded. */
const dmlFieldNames = (text: string): string[] => {
  const list = /\[([A-Za-z][A-Za-z0-9_, ]{0,255})\]/.exec(text)?.[1];
  if (!list) return [];
  return [...new Set(list.split(",").map((name) => name.trim()))]
    .filter(validName)
    .slice(0, 5);
};

const firstMatch = (texts: string[], pattern: RegExp): string | null => {
  for (const text of texts) {
    if (typeof text !== "string") continue;
    const found = text.match(pattern);
    if (found) return found[0];
  }
  return null;
};

/** Salesforce-standard person-account-only Account fields. Absent from the
 * live schema exactly when Person Accounts are not enabled. */
const PERSON_ACCOUNT_FIELDS = new Set([
  "IsPersonAccount",
  "PersonContactId",
  "PersonEmail",
]);

/** Classify an upstream managed-flow failure. Returns null when no
 * evidenced branch matches so the existing generic pipeline keeps
 * its verdict untouched. */
export function classifyManagedFlowFault(
  input: ManagedFlowFaultInput,
): ManagedFlowFault | null {
  if (!input || !Array.isArray(input.messages) || !Array.isArray(input.codes))
    return null;
  const texts = [
    ...input.messages.filter((v) => typeof v === "string"),
    typeof input.outputErrorMessage === "string"
      ? input.outputErrorMessage
      : "",
  ].filter((v) => v.length > 0);
  const codes = input.codes.filter((v) => typeof v === "string");

  // (1) Scheduler invitation prefix. Observed on
  // saveAppointmentInvitationDetails in two orgs with real fixtures: ten
  // request-side property names and two site origins all rejected
  // identically. The prefix lives in the managed invitation generation
  // flow, configured by an admin as a community or website URL.
  if (
    firstMatch(
      texts,
      /invitation URL prefix is missing in your invitation generation flow/i,
    )
  ) {
    return {
      code: "INVITATION_URL_PREFIX_REQUIRED",
      requirement:
        "Configure the Invitation URL Prefix (an Experience Cloud community or website URL) " +
        "in the org's Generate Appointment Invitation flow. No request-side invitation property supplies it.",
      retryable: true,
    };
  }

  // (2) Success envelope carrying a quickAction resolution failure.
  // Observed on SvcCopilotTmpl__CloseCase: the managed flow's FlowActionCall
  // element resolves a bare quick-action name that 404s in orgs whose
  // metadata is 2GP-namespaced, while succeeding where it is unpackaged.
  // Curly quotes appear in the live message and are matched literally.
  if (input.envelopeSucceeded === true) {
    // (2a) Legacy quickAction-only branch, kept stable for existing verdicts.
    const quickActionFault = texts.find((text) =>
      /couldn.t execute the .+ action element of the quickAction type/i.test(
        text,
      ),
    );
    if (quickActionFault) {
      const element = /couldn.t execute the ["\u201c\u201d]([^""\u201c\u201d]{1,128})["\u201c\u201d] action element/i
        .exec(quickActionFault)?.[1]
        ?.trim();
      return {
        code: "FLOW_QUICK_ACTION_UNRESOLVED",
        requirement:
          "The managed flow's quickAction element resolves a bare action name that the live " +
          "quick-action catalog does not expose. Align the org's packaging (2GP-namespaced versus " +
          "unpackaged metadata) with the name the managed flow resolves instead of creating substitute configuration.",
        retryable: true,
        ...(validName(element) ? { actionElement: element } : {}),
      };
    }
    // (2b) Generalized branch: the same fault shape carries arbitrary managed
    // element types (getCmdbCiDetails, executeCmdbCiUpdate, ...). Observed
    // live inside accepted envelopes as ciMessage/promptMessage/deleteMessage
    // outputs with empty data and no mutation.
    const elementFault = texts.find((text) =>
      /couldn.t execute the .+ action element of the [A-Za-z][A-Za-z0-9_]{1,127} type/i.test(
        text,
      ),
    );
    if (elementFault) {
      const match =
        /couldn.t execute the ["\u201c\u201d]([^""\u201c\u201d]{1,128})["\u201c\u201d] action element of the ([A-Za-z][A-Za-z0-9_]{1,127}) type/i.exec(
          elementFault,
        );
      const element = match?.[1]?.trim();
      const elementType = match?.[2];
      if (validName(element) && validName(elementType)) {
        return {
          code: "FLOW_ACTION_ELEMENT_UNRESOLVED",
          requirement:
            `The managed flow's ${elementType} element '${element}' does not resolve in this org; ` +
            "align the installed package version with the element the managed flow references (packaging/version skew), " +
            "then retry. No request-side input substitutes for the missing backend element.",
          retryable: true,
          actionElement: element,
        };
      }
    }
    // (2c) Spanish-locale variant of (2b): "No hemos podido ejecutar el
    // elemento de acción "X" del tipo Y." Without this the worker falsely
    // converts Spanish-org ITOM/retriever faults that English orgs park.
    const spanishFault = texts.find((text) =>
      /no hemos podido ejecutar el elemento de acci[oó]n/i.test(text),
    );
    if (spanishFault) {
      const match =
        /no hemos podido ejecutar el elemento de acci[oó]n ["\u201c\u201d]([^""\u201c\u201d]{1,128})["\u201c\u201d] del tipo ([A-Za-z][A-Za-z0-9_]{1,127})/i.exec(
          spanishFault,
        );
      const element = match?.[1]?.trim();
      const elementType = match?.[2];
      if (validName(element) && validName(elementType)) {
        return {
          code: "FLOW_ACTION_ELEMENT_UNRESOLVED",
          requirement:
            `The managed flow's ${elementType} element '${element}' does not resolve in this org; ` +
            "align the installed package version with the element the managed flow references (packaging/version skew), " +
            "then retry. No request-side input substitutes for the missing backend element.",
          retryable: true,
          actionElement: element,
        };
      }
    }
  }

  // (3)/(4) Managed lookup references a column the runtime cannot see.
  // Observed via debug trace: "No such column 'X' on entity 'Y'".
  const missingColumn = texts
    .map((text) =>
      /No such column '([A-Za-z][A-Za-z0-9_]*)' on entity '([A-Za-z][A-Za-z0-9_]*)'/.exec(
        text,
      ),
    )
    .find(Boolean);
  if (missingColumn) {
    const [, field, object] = missingColumn as unknown as [string, string, string];
    if (!validName(field) || !validName(object)) return null;
    if (
      object === "Account" &&
      PERSON_ACCOUNT_FIELDS.has(field) &&
      input.adminFieldVisible !== true
    ) {
      return {
        code: "PERSON_ACCOUNTS_REQUIRED",
        requirement:
          "The managed flow queries person-account fields absent from the live Account schema. " +
          "Enable Person Accounts through Setup (an irreversible org change) before retrying.",
        retryable: true,
        objectName: object,
        fieldName: field,
      };
    }
    if (input.adminFieldVisible === true) {
      return {
        code: "FLOW_LOOKUP_FIELD_ACCESS_REQUIRED",
        requirement:
          `Grant the execution identity read access to ${object}.${field}, which the live admin schema ` +
          "exposes but the execution user cannot see, then retry.",
        retryable: true,
        objectName: object,
        fieldName: field,
      };
    }
    if (input.adminFieldVisible === false) {
      return {
        code: "FLOW_LOOKUP_SCHEMA_SKEW",
        requirement:
          `The managed flow references ${object}.${field}, which the live org schema does not expose ` +
          "to any user. No permission grant fixes this; the managed package expects a newer platform schema.",
        retryable: false,
        objectName: object,
        fieldName: field,
      };
    }
    return null;
  }

  // (5) Segmentation validation with no resolvable segment.
  // Observed on segmentation__validateSegmentMember: HTTP 200 isSuccess=true
  // with a Java null-segment error for blind identifiers. Live ACTIVE
  // published segments exist and resolve past this fault.
  if (
    firstMatch(
      texts,
      /segmentWithCriteriaAndType.+is null/i,
    )
  ) {
    return {
      code: "SEGMENT_CONTEXT_REQUIRED",
      requirement:
        "Invoke with a live published MarketSegment identifier discovered from the org and a real " +
        "profile input instead of probe values. Blind identifiers never resolve segment context.",
      retryable: true,
    };
  }

  // (6) Summarizer backend fault with readable source metadata.
  // Observed on summarizeCustomReportType: INTERNAL_ERROR for every live
  // custom and standard report-type name while the analytics report-type
  // describe returns full metadata. The failure is upstream of inputs.
  if (
    codes.includes("INTERNAL_ERROR") &&
    input.sourceMetadataReadable === true
  ) {
    return {
      code: "SUMMARIZER_BACKEND_UNAVAILABLE",
      requirement:
        "The summarization backend rejects every live report-type name while the report-type metadata " +
        "itself is readable. No input discovery or metadata provisioning fixes this upstream fault.",
      retryable: false,
    };
  }

  // (7) Prompt grounding paths resolve against live session context.
  // Observed on the session-tracing prompt family in two orgs: two
  // request shapes (direct object, value-wrapped) rejected identically
  // with UndefinedResolutionError for required grounding paths, via both
  // the execution identity and the admin identity. Synthetic probe values
  // never resolve template grounding.
  if (
    firstMatch(texts, /UndefinedResolutionError/i) &&
    firstMatch(texts, /is missing but it is required/i)
  ) {
    return {
      code: "PROMPT_SESSION_CONTEXT_REQUIRED",
      requirement:
        "Invoke with a live recorded session grounding context discovered from the org instead of " +
        "probe values. The prompt template resolves its required grounding paths from live session " +
        "state that synthetic inputs never supply.",
      retryable: true,
    };
  }

  // (8) Prompt data provider is not provisioned in the tenant.
  // Observed on answerWithKnowledge (named retriever rejected while the
  // descriptor requires it) and summarizeMessagingSession (referenced flow
  // absent from live FlowDefinitions), identically via execution and admin
  // identities. The failure is upstream of request inputs.
  {
    const provider = texts
      .map((text) =>
        /Error occurs resolving a data provider:\s*([A-Za-z][A-Za-z0-9_:]{1,128})\s*\.\s*The data provider is either invalid or no longer exists/i.exec(
          text,
        )?.[1],
      )
      .find((value): value is string => typeof value === "string");
    if (provider) {
      return {
        code: "PROMPT_DATA_PROVIDER_UNAVAILABLE",
        requirement:
          "Provision or repair the prompt template's data provider in this tenant (retriever or " +
          "referenced flow) before retrying. No request-side value substitutes for the missing provider.",
        retryable: true,
        ...(validProvider(provider) ? { providerName: provider } : {}),
      };
    }
  }

  // (9) Managed invocable rejects with only its bare class name.
  // Observed on selectDataspace (with and without the live Active
  // dataspace name), getGoals, getOverviewInsight, and
  // getAttributionInsight: identical UNKNOWN_EXCEPTION bare-name faults
  // via execution and admin identities with no Apex trace codes. The
  // fault is platform-internal, independent of inputs and identity.
  if (codes.includes("UNKNOWN_EXCEPTION")) {
    const bare = texts.find((text) =>
      /^\s*Invocable[A-Za-z][A-Za-z0-9_]*\s*$/.test(text),
    );
    if (bare) {
      return {
        code: "MANAGED_INVOCABLE_INTERNAL",
        requirement:
          "The managed invocable faults platform-internally with no actionable detail across inputs " +
          "and identities. No input discovery, grant, or provisioning fixes this upstream fault; preserve it.",
        retryable: false,
      };
    }

    // (10) Managed agentic-retrieval backend exception.
    // Observed on answerQuestionsWithAgenticRetriever with a valid query
    // via both identities: the Knowledge Answers retrieval backend
    // raises before returning retrieval context.
    if (
      texts.find((text) =>
        /^\s*KA:\s*Invocable[A-Za-z][A-Za-z0-9_]*:\s*generateResponse:\s*Exception\s*$/i.test(
          text,
        ),
      )
    ) {
      return {
        code: "AGENTIC_RETRIEVAL_BACKEND_FAULT",
        requirement:
          "The managed agentic-retrieval backend raises before returning retrieval context for valid " +
          "inputs. No input or permission change fixes this upstream fault; preserve it.",
        retryable: false,
      };
    }

    // (11) Opaque platform error-ID fault.
    // Observed on getChannelTypes and getCampaignObjectives (with a valid
    // channelType) via both identities: UNKNOWN_EXCEPTION carrying only a
    // support error ID. No actionable detail is exposed to any caller.
    // The gack-ID sentence ("Something went wrong. Gack ID: ...") is the
    // same shape with the ID inline instead of behind a support sentence.
    // The persistence-clause variant ("Try again. If the problem persists,
    // contact Salesforce Customer Support and provide this error ID: ...")
    // is the same fault in different native prose; both wordings mint a
    // fresh error ID per attempt, so neither converts on retry.
    if (
      firstMatch(
        texts,
        /Try again, or contact Salesforce(?: Customer)? Support and provide this error ID:/i,
      ) ||
      firstMatch(
        texts,
        /Try again\.\s*If the problem persists,\s*contact Salesforce(?: Customer)? Support and provide this error ID:/i,
      ) ||
      firstMatch(texts, /\bgack id\s*:\s*\S+/i)
    ) {
      return {
        code: "UPSTREAM_ERROR_ID_FAULT",
        requirement:
          "The platform reports only an opaque support error ID with no actionable detail. Preserve the " +
          "upstream outcome without retry amplification; raise it to Salesforce Customer Support if it persists.",
        retryable: false,
      };
    }
  }

  // (12) Execution identity cannot run the managed flow.
  // Observed on five package flows in the org where the execution user is
  // denied while the admin envelope succeeds (and faults deeper on an
  // unresolvable managed action element). The denial precedes any
  // interview, so no trace element exists; the platform message names the
  // missing grant explicitly.
  if (
    firstMatch(
      texts,
      /doesn.t have the required access to run the flow/i,
    )
  ) {
    return {
      code: "FLOW_RUN_PERMISSION_REQUIRED",
      requirement:
        "Grant the execution identity permission to run the managed flow (flow-run access for its " +
        "package flows) through the fixture permission set, then retry.",
      retryable: true,
    };
  }

  // (13) Managed flow interview start gack.
  // Observed on SvcCopilotTmpl__PostConvoAnalysis via live and synthetic
  // inputs alike: the platform throws before any flow element runs (zero
  // FLOW_* trace events), so no input shape can fix it.
  if (
    codes.includes("UNKNOWN_EXCEPTION") &&
    input.envelopeSucceeded !== true &&
    firstMatch(texts, /trying to start a flow interview/i)
  ) {
    return {
      code: "MANAGED_FLOW_INTERVIEW_START_GACK",
      requirement:
        "The managed flow faults while starting its interview before any element runs, for every " +
        "input shape. No input discovery or provisioning fixes this upstream fault; preserve it.",
      retryable: false,
    };
  }

  // (14) Managed flow execution fault (package/schema skew).
  // Observed on sfdc_fieldservice__GenPreWorkBrief (references
  // Asset.ProductDescription, absent from the live admin schema on both
  // orgs), ModifyPWB (calls invocable GetCustomerSignalsInsights, 404 on
  // both the actions descriptor and the ApexClass table) and MineUtterances
  // (calls extractHistoricalData, 404 on both surfaces): identical opaque
  // execution faults for minimal and fully-hydrated inputs alike.
  //
  // The opaque sentence carries no anatomy, so the split below is keyed on
  // caller-supplied independent evidence under the same guarded convention
  // as branches (3)/(4) and (6): each sub-branch requires the opaque
  // sentence plus validated evidence, and anything unvalidated falls
  // through to the generic code. Only the schema-skew shape terminalizes;
  // the missing-invocable shape stays retryable because a package
  // alignment can supply the dependency. Suppliers: flow-execution-evidence
  // (collectFlowExecutionEvidence, fed by live flow metadata) via the
  // owned-substrate invoke path, which attaches the verdict as
  // managedFlowFault without changing assessed codes.
  if (
    codes.includes("UNKNOWN_EXCEPTION") &&
    firstMatch(texts, /error occurred when executing a flow interview/i)
  ) {
    // (14a) The executing interview calls an invocable the tenant does not
    // expose. The retryable shape is evaluated first so a fixable
    // dependency is never hidden behind the terminal skew verdict.
    if (validCallout(input.missingInvocable)) {
      return {
        code: "FLOW_EXECUTION_INVOCABLE_MISSING",
        requirement:
          "The managed flow faults during execution on an invocable dependency the tenant does " +
          "not expose. Align the installed managed-package version with the invocable it " +
          "references (install or upgrade the package that supplies it), then retry. No " +
          "request-side input substitutes for the missing dependency.",
        retryable: true,
        invocableName: input.missingInvocable,
      };
    }
    // (14b) The executing interview references schema the live org does not
    // expose to any user. No grant, input, or package alignment restores
    // platform schema the org itself lacks; preserve terminally.
    const skew = input.missingSchemaField;
    if (
      skew &&
      validName(skew.objectName) &&
      validName(skew.fieldName)
    ) {
      return {
        code: "FLOW_EXECUTION_SCHEMA_SKEW",
        requirement:
          `The managed flow faults during execution on ${skew.objectName}.${skew.fieldName}, which the live ` +
          "org schema does not expose to any user. No permission grant or input shape fixes this; " +
          "the managed package expects a newer platform schema.",
        retryable: false,
        objectName: skew.objectName,
        fieldName: skew.fieldName,
      };
    }
    return {
      code: "MANAGED_FLOW_EXECUTION_FAULT",
      requirement:
        "The managed flow faults during execution for every input shape: align the installed " +
        "managed-package version with the elements it references (a missing invocable dependency " +
        "or schema the live org does not expose), then retry. No request-side input substitutes " +
        "for the missing backend element.",
      retryable: true,
    };
  }

  // (15) Agent flows need verified-customer and conversation context.
  // Observed live on the scheduling/field-service AI-agent family: the
  // flow executes with probe inputs and its own errorMessage reports the
  // customer is unverified, the customer ID unresolvable, or the
  // retrieved contextual intent empty. Synthetic references never
  // resolve agent customer context; a live verified identity does.
  if (
    firstMatch(
      texts,
      /(?:aren['\u2019]t a verified customer|customer isn['\u2019]t verified|identify your customer id|contextual intent was empty|couldn['\u2019]t find that customer id)/i,
    )
  ) {
    return {
      code: "FLOW_AGENT_CONTEXT_REQUIRED",
      requirement:
        "Invoke with a live verified-customer identity from the org (verification-producer " +
        "customer context) and a live conversation carrying contextual intent instead of probe " +
        "values, then retry. Synthetic references never resolve agent customer context.",
      retryable: true,
    };
  }

  // (16) The managed flow's own check refuses to continue until package
  // permissions are enabled. Observed live as a flow errorMessage output
  // on a collaboration (swarm-channel) flow: the package gates
  // continuation on its feature permissions, not on flow-run access, so
  // the flow-run branch above never matches. The action-level variant
  // ("This action can't continue because ...") is the same gate surfaced
  // by a precondition check instead of the flow interview.
  if (
    firstMatch(
      texts,
      /(?:cannot be continued|can['\u2019]t continue) because certain permissions need to be enabled/i,
    )
  ) {
    return {
      code: "FLOW_PACKAGE_PERMISSION_REQUIRED",
      requirement:
        "Enable the package permissions the managed flow requires before continuing " +
        "(the feature/collaboration permissions its own check names), then retry.",
      retryable: true,
    };
  }

  // (17) The managed flow's external callout cannot reach its endpoint.
  // Observed live on ServiceNow-backed employee-intelligence flows: the
  // invocable callout fails with an external-connection fault for every
  // input shape. The unreachable external system is upstream of inputs.
  {
    const callout = firstMatch(
      texts,
      /callout failed for invocable action/i,
    );
    if (callout) {
      const invocable = texts
        .map((text) =>
          /callout failed for invocable action ([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]+)*)/i.exec(
            text,
          )?.[1],
        )
        .find((value): value is string => typeof value === "string");
      return {
        code: "FLOW_EXTERNAL_CALLOUT_UNAVAILABLE",
        requirement:
          "Repair the external endpoint access the managed flow's callout requires " +
          "(named credential, endpoint availability, or callout permission), then retry. " +
          "No request-side input substitutes for the unreachable external system.",
        retryable: true,
        ...(validCallout(invocable) ? { invocableName: invocable } : {}),
      };
    }
  }

  // (19) Managed-trigger faults during insert/update. Observed live as
  // CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY on flow, quick-action, email-alert,
  // and standard invokes alike: the FSL service trigger dereferences null
  // inside managed System Code, and the Marketing Cloud trigger queries a
  // business-unit record the org never configured. Trigger anatomy is
  // matched first so the generic null-deref branch below never claims a
  // trigger fault. The null-deref shape is terminal (a code defect inside
  // managed trigger code no input repairs); the no-rows shape is setup
  // (package data the admin provisions, then retry).
  {
    const triggerText = texts.find((text) =>
      /execution of (?:BeforeInsert|BeforeUpdate|AfterInsert|AfterUpdate) caused by: System\.(?:NullPointerException|QueryException)/i.test(
        text,
      ),
    );
    if (triggerText) {
      const trigger = /([A-Za-z][A-Za-z0-9_]{0,62}\.[A-Za-z][A-Za-z0-9_]{0,62}): execution of/i.exec(
        triggerText,
      )?.[1];
      const name = validTrigger(trigger) ? ` ${trigger}` : "";
      if (/NullPointerException/i.test(triggerText)) {
        return {
          code: "MANAGED_TRIGGER_NULL_FAULT",
          requirement:
            `The managed trigger${name} faults dereferencing null inside managed code on a ` +
            "well-formed insert. No input shape repairs a null-deref inside managed trigger code; " +
            "preserve it.",
          retryable: false,
        };
      }
      if (/List has no rows for assignment to SObject/i.test(triggerText)) {
        return {
          code: "PACKAGE_TRIGGER_DATA_REQUIRED",
          requirement:
            `Configure the package data the managed trigger${name} queries (the business-unit or ` +
            "setup record its query expects), then retry. Probe inputs never supply package setup rows.",
          retryable: true,
        };
      }
    }
  }

  // (20) Invocable callout to an unregistered endpoint. Observed live as
  // UNKNOWN_EXCEPTION carrying System.CalloutException: the vendor calls an
  // external URL the org never registered under Remote Site Settings. The
  // endpoint URL is never echoed (tenant-adjacent); the requirement names
  // only the fixed Setup path. Retryable once an admin registers it.
  if (
    firstMatch(
      texts,
      /Unauthorized endpoint, please check Setup->Security->Remote site settings/i,
    )
  ) {
    return {
      code: "CALLOUT_ENDPOINT_SETUP_REQUIRED",
      requirement:
        "Register the external endpoint under Setup Security Remote Site Settings (or its Named " +
        "Credential) before retrying. No request-side input substitutes for endpoint registration.",
      retryable: true,
    };
  }

  // (21) Vendor-built DML row rejected. Observed live as UNKNOWN_EXCEPTION
  // carrying System.DmlException: the vendor constructs its own insert row
  // with missing required fields or a wrong-typed value
  // (REQUIRED_FIELD_MISSING, INVALID_TYPE_ON_FIELD_IN_RECORD). The caller
  // never supplies the row, so no input shape repairs it; preserve
  // terminally with the validated field anatomy.
  {
    const dml = texts.find((text) =>
      /System\.DmlException: Insert failed/i.test(text) &&
      /(?:REQUIRED_FIELD_MISSING|INVALID_TYPE_ON_FIELD_IN_RECORD)/.test(text),
    );
    if (dml) {
      const fields = dmlFieldNames(dml);
      return {
        code: "VENDOR_DML_ROW_FAULT",
        requirement:
          "The vendor builds an invalid insert row server-side" +
          (fields.length > 0 ? ` (${fields.join(", ")})` : "") +
          ". The caller never supplies that row, so no input shape repairs it; preserve it.",
        retryable: false,
      };
    }
  }

  // (22) JVM null anatomy naming the null reference. Observed live in two
  // shapes: Integration Procedures fault on a null ApexObject (the
  // structured Apex input never materialized: its type is not exposed, so
  // no request-side shape can supply it — terminal), while log-data
  // generators fault on a null targetEntity. The targetEntity shape was
  // first parked retryable, but live reproduction refutes it: owned live
  // Account and Case records bound as the SObject targets fault
  // byte-identically (common.udd.EntityInfo.getApiElementInfoByApiName
  // with null targetEntity), matching prior-art proof that real record
  // ids never resolve it. Only a live bot/agent session context supplies
  // the entity, which probes cannot mint — terminal. Unobserved null-var
  // names stay unclassified.
  {
    const jvm = texts
      .map((text) =>
        /Cannot invoke "[^"]{1,200}" because "([^"]{1,64})" is null/.exec(text)?.[1],
      )
      .find((value): value is string => typeof value === "string");
    if (jvm === "apexObject") {
      return {
        code: "INTEGRATION_PROCEDURE_INPUT_UNAVAILABLE",
        requirement:
          "The Integration Procedure's structured Apex input type is not exposed by the live org, " +
          "so its input object never materializes. No request-side shape substitutes for the missing type.",
        retryable: false,
      };
    }
    if (jvm === "targetEntity") {
      return {
        code: "UDD_TARGET_ENTITY_UNRESOLVABLE",
        requirement:
          "The UDD entity resolution returns null even for live resolvable records; only a live " +
          "bot/agent session context supplies the target entity. No input discovery, grant, or " +
          "provisioning fixes this upstream fault; preserve it.",
        retryable: false,
      };
    }
  }

  // (23) Vendor list indexing. Observed live as UNKNOWN_EXCEPTION carrying
  // System.ListException (empty cart context, token/address splitting past
  // the supplied parts). With declared inputs the vendor parses caller
  // values, so live structured values convert it; with zero declared
  // inputs nothing request-side exists to repair (the vendor queries an
  // empty set), so it terminalizes.
  if (
    firstMatch(texts, /System\.ListException: List index out of bounds: \d+/)
  ) {
    if (input.hasInputs === false) {
      return {
        code: "VENDOR_EMPTY_RESULT_FAULT",
        requirement:
          "The vendor indexes into an empty query result while the action declares no inputs. " +
          "Nothing request-side can change that outcome; preserve it.",
        retryable: false,
      };
    }
    // (23a) Cart-context indexing. Observed live on the commerce sync
    // family: an omitted or unresolvable cart id faults index 0, while an
    // owned live cart advances the vendor past the indexing fault to its
    // pricing/delivery/tax substrate (a callout needing pricebook entries
    // and cart children). A generic record id never substitutes: only an
    // owned cart carrying priced substrate converts. The branch requires
    // caller-supplied declared input names in cart-id vocabulary (the
    // same guarded convention as branch (32)); anything else stays on the
    // generic structured-values requirement below.
    const cartInputs = Array.isArray(input.inputNames)
      ? input.inputNames.filter(
          (name): name is string =>
            typeof name === "string" &&
            name.toLowerCase().includes("cart") &&
            /(?:ids?|ids?list)$/i.test(name),
        )
      : [];
    if (cartInputs.length > 0) {
      return {
        code: "OWNED_CART_SUBSTRATE_REQUIRED",
        requirement:
          "Invoke with an owned commerce cart carrying priced substrate (delivery groups, items, and " +
          "pricebook entries minted in the tenant) instead of probe values, then retry. Omitted or " +
          "unresolvable cart references never survive vendor-side cart queries.",
        retryable: true,
      };
    }
    return {
      code: "STRUCTURED_INPUT_VALUE_REQUIRED",
      requirement:
        "Invoke with live structured input values the vendor's parsing expects (a resolvable record " +
        "reference, a live multi-part token, or a delimited address) instead of probe values, then " +
        "retry. Blind values never survive vendor-side indexing.",
      retryable: true,
    };
  }

  // (24) Vendor null dereference on caller inputs. Observed live as
  // UNKNOWN_EXCEPTION carrying System.NullPointerException /
  // System.HandledException with optional sObject and scalar inputs
  // omitted: the vendor dereferences the missing value. Retryable with
  // live bound values; every observed row declares inputs, so no
  // no-input split is coded.
  if (firstMatch(texts, /Attempt to de-reference a null object/)) {
    return {
      code: "LIVE_INPUT_VALUE_REQUIRED",
      requirement:
        "Bind every input the vendor dereferences to a live value (an owned fixture row for record " +
        "inputs, a live discovered value for scalars) instead of omitting it, then retry. Omitted " +
        "values never survive vendor-side dereference.",
      retryable: true,
    };
  }

  // (25) Dynamic-SOQL identifier fault. Observed live as UNKNOWN_EXCEPTION
  // carrying System.QueryException `unexpected token`: the vendor
  // interpolates a caller identifier into dynamic SOQL and the probe value
  // carries hyphenated filler. Retryable with live schema-derived
  // identifiers, which never carry filler punctuation.
  if (firstMatch(texts, /System\.QueryException: unexpected token/)) {
    return {
      code: "DYNAMIC_QUERY_IDENTIFIER_REQUIRED",
      requirement:
        "Bind query identifiers (field and object names) from the live schema instead of probe " +
        "values, then retry. Hyphenated fillers never parse as SOQL identifiers.",
      retryable: true,
    };
  }

  // (26) JSON-document input given a bare token. Observed live as
  // UNKNOWN_EXCEPTION carrying a JSON `Unrecognized token` fault: the
  // action declares a JSON-string input and the probe sent unstructured
  // text. Retryable with a valid JSON document.
  if (
    firstMatch(
      texts,
      /Unrecognized token '[^']{1,64}': was expecting \(JSON String, Number, Array, Object or token/i,
    )
  ) {
    return {
      code: "JSON_DOCUMENT_INPUT_REQUIRED",
      requirement:
        "Send a valid JSON document for the JSON-string input instead of unstructured text, then " +
        "retry. Bare tokens never parse as JSON documents.",
      retryable: true,
    };
  }

  // (27) ML-prediction backend inference failure. Observed live as
  // UNKNOWN_EXCEPTION on prediction invocables with valid text inputs:
  // the model backend raises before returning predictions. Upstream of
  // inputs; preserve without retry amplification.
  if (firstMatch(texts, /Inference failed for model:/)) {
    return {
      code: "MODEL_INFERENCE_UNAVAILABLE",
      requirement:
        "The prediction backend fails inference for valid inputs. No input or permission change " +
        "fixes this upstream fault; preserve it.",
      retryable: false,
    };
  }

  // (28) Session permission activation without assignment. Observed live:
  // the platform requires the permission set pre-assigned to the user
  // before activation. Retryable once assigned (the owned session context
  // already provisions that order).
  if (
    firstMatch(
      texts,
      /The permission set must be pre-assigned to the user before being activated/,
    )
  ) {
    return {
      code: "SESSION_ASSIGNMENT_REQUIRED",
      requirement:
        "Assign the permission set to the execution user before activating it, then retry. " +
        "Activation never precedes assignment.",
      retryable: true,
    };
  }

  // (29) Context-name platform validation. Observed live as
  // UNKNOWN_EXCEPTION carrying SF-CTX-00001: the supplied context name
  // carries filler punctuation. Retryable with a live alphanumeric
  // definition identifier.
  if (
    firstMatch(
      texts,
      /SF-CTX-00001: Enter a name that contains alphanumeric characters/i,
    )
  ) {
    return {
      code: "ALPHANUMERIC_CONTEXT_NAME_REQUIRED",
      requirement:
        "Supply a live alphanumeric context definition identifier instead of probe values, then " +
        "retry. Fillers with punctuation never pass context-name validation.",
      retryable: true,
    };
  }

  // (30) Undeclared wrapper variable. Observed live: the caller wrapped
  // its input in an `attributes` variable the flow never declared.
  // Retryable with declared-inputs-only shapes.
  if (
    firstMatch(
      texts,
      /doesn't have a variable with the name "attributes", or the variable isn't available for input/i,
    )
  ) {
    return {
      code: "DECLARED_INPUT_SHAPE_REQUIRED",
      requirement:
        "Send declared inputs only, without the undeclared wrapper variable, then retry. " +
        "Undeclared variables never bind to flow inputs.",
      retryable: true,
    };
  }

  // (31) Pardot data access gate. Observed live: the execution identity
  // lacks Pardot data access. Retryable once an admin grants it.
  if (
    firstMatch(
      texts,
      /You need access to Pardot data to view lists\. Contact your admin for help/i,
    )
  ) {
    return {
      code: "PARDOT_DATA_ACCESS_REQUIRED",
      requirement:
        "Grant the execution identity Pardot data access through an admin, then retry. Probe " +
        "values never substitute for data access.",
      retryable: true,
    };
  }

  // (32) Opaque property fault on schema-identifier inputs. Observed live
  // as an opaque `Something went wrong` UNKNOWN_EXCEPTION on an action
  // declaring objectName/fieldName inputs: blind values never resolve
  // live schema. The opaque sentence alone proves nothing, so the branch
  // requires caller-supplied declared input names from fixed platform
  // vocabulary — the same guarded convention as branches (3)/(4)/(6)/(14).
  {
    const names = Array.isArray(input.inputNames)
      ? input.inputNames.filter(
          (name): name is string =>
            typeof name === "string" &&
            SCHEMA_IDENTIFIER_INPUTS.has(name.toLowerCase()),
        )
      : [];
    if (
      names.length > 0 &&
      firstMatch(
        texts,
        /Something went wrong\. Try again later or ask your Salesforce admin for help/i,
      )
    ) {
      return {
        code: "SCHEMA_IDENTIFIER_VALUE_REQUIRED",
        requirement:
          "Bind the schema-identifier inputs from the live schema (object and field API names the " +
          "org exposes) instead of probe values, then retry. Blind values never resolve live schema.",
        retryable: true,
      };
    }
  }

  // (18) The managed flow received no usable value for a named identifier
  // input. Observed live as flow errorMessage outputs ("ItemSysId is
  // null", "RequestNumber is Null") on external-identifier flows probed
  // without a live identifier. JVM null-dereference anatomy ("Cannot
  // invoke ... because ... is null") and caller-side null-argument
  // rejections stay on their existing verdicts via the exclusions below,
  // as does the earlier null-segment branch, which returns first.
  {
    const excluded =
      firstMatch(texts, /cannot invoke/i) ||
      firstMatch(texts, /\bargument\b.{0,40}\bis null\b/i);
    if (!excluded) {
      const name = texts
        .map((text) =>
          /([A-Za-z][A-Za-z0-9_]{1,127}) is null/i.exec(text)?.[1],
        )
        .find(
          (value): value is string =>
            typeof value === "string" &&
            validName(value) &&
            !NULL_INPUT_STOPLIST.has(value.toLowerCase()),
        );
      if (name) {
        return {
          code: "FLOW_INPUT_IDENTIFIER_REQUIRED",
          requirement:
            `Invoke with a live ${name} identifier instead of probe values; ` +
            `the flow received no usable ${name}.`,
          retryable: true,
          inputName: name,
        };
      }
    }
  }

  // (33) The flow's own output reports an upstream access denial.
  // Observed live as a flow errorMessage output on a scheduling flow
  // ("Looks like you don't have access to get appointment time slots."):
  // the interview finished, but the gated capability refused the
  // execution identity. The gated noun is free prose, never an
  // identifier, so the requirement stays generic; no upstream text is
  // ever interpolated.
  if (
    firstMatch(texts, /looks like you don['\u2019]t have access to /i)
  ) {
    return {
      code: "FLOW_UPSTREAM_ACCESS_REQUIRED",
      requirement:
        "Grant the execution identity access to the gated capability (feature, action, " +
        "record, or object the flow's own check names) through the fixture permission set, " +
        "then retry.",
      retryable: true,
    };
  }

  // (34) The flow's own output reports a missing live setup record.
  // Observed live as a flow error output ("Error: Work Type not found"):
  // the interview finished, but the named setup row does not exist, so
  // the synthetic input value can never resolve. Only short whole-text
  // shapes match (anchored, length-bounded); the noun interpolates only
  // when it carries real anatomy (a multi-word label or a long token),
  // so bare "Record not found" prose stays unclassified.
  {
    const noun = texts
      .map((text) =>
        /^(?:error:\s*)?([A-Za-z][A-Za-z0-9 .]{1,60}?) not found\.?$/i.exec(
          text.trim(),
        )?.[1]?.trim(),
      )
      .find(
        (value): value is string =>
          typeof value === "string" &&
          /^[A-Za-z][A-Za-z0-9 .]{1,60}$/.test(value) &&
          (value.includes(" ") || value.length >= 8),
      );
    if (noun) {
      return {
        code: "FLOW_SETUP_RECORD_REQUIRED",
        requirement:
          `Invoke with a live ${noun} discovered from the org (or provision one during ` +
          "setup), then retry. Synthetic names never resolve live setup records.",
        retryable: true,
        setupNoun: noun,
      };
    }
  }

  // (35) Field-level security refuses a create/update field write.
  // Observed live on a Quick Action update ("Unable to create/update
  // fields: WorkOrderId. Please check the security settings of this field
  // and verify that it is read/write for your profile or permission
  // set."): the standard code plus the field-security sentence together
  // name a grantable gap. Only the first validated field interpolates.
  if (
    codes.includes("INVALID_FIELD_FOR_INSERT_UPDATE") &&
    firstMatch(texts, /read\/write for your profile or permission set/i)
  ) {
    const field = texts
      .map((text) =>
        /unable to create\/update fields:\s*([A-Za-z][A-Za-z0-9_]{0,127})/i.exec(
          text,
        )?.[1],
      )
      .find((value): value is string => validName(value));
    return {
      code: "FIELD_ACCESS_REQUIRED",
      requirement: field
        ? `Grant the execution identity read/write access to ${field} (field-level security ` +
          "on the live object) through the fixture permission set, then retry."
        : "Grant the execution identity read/write access to the named fields (field-level " +
          "security on the live object) through the fixture permission set, then retry.",
      retryable: true,
      ...(field ? { fieldName: field } : {}),
    };
  }

  // knowledgeSpaceViewReport deliberately stays unclassified: its live
  // "Failed to load deep research report metadata" fault shape is pinned
  // by the searcher contract to the generic missing_context verdict, so a
  // taxonomy override here would rewrite that contract. The generic
  // pipeline keeps its verdict untouched (verified: full index suite green).

  return null;
}
