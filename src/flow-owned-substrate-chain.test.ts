import { describe, expect, it } from "bun:test";
import {
  assessOwnedSubstrateOutcome,
  countsAsFixtureReference,
  createdObjectCandidates,
  descriptorPicklistChoice,
  diagnoseSubstrateOutputText,
  extractEmbeddedIds,
  fixtureNumberValue,
  flowDeclaresUpdate,
  inputDocumentsRecord,
  interviewFinished,
  invokeOwnedSubstrate,
  isExactCreationCandidate,
  isExternalIdentityShaped,
  isProseShaped,
  isReadOnlyEvident,
  isReferenceShaped,
  isSelfUserShaped,
  isTemplateShaped,
  livePicklistChoice,
  neutralOwnedValue,
  objectHintCandidates,
  orderCleanupTargets,
  rankHintCandidates,
  referenceStem,
  stripHungarianPrefix,
} from "./flow-owned-substrate-chain";

const ROOT = "/services/data/v67.0";
const ROUTE = (name: string): string => `${ROOT}/actions/custom/flow/${name}`;
const SELF = "005000000000000AAA";
const CASE_ID = "500000000000000AAA";
const CONTACT_ID = "003000000000000AAA";

const ok = (body: unknown = {}) => ({ status: 200, ok: true, body });
const records = (rows: unknown[]) => ok({ records: rows });

describe("isExactCreationCandidate", () => {
  it("requires creation-verb proximity and rejects id-input echoes", () => {
    // Verb-adjacent creation names the created rows.
    expect(isExactCreationCandidate("ActionPlan",
      "This flow creates an action plan for the care request", ["careRequestId"])).toBe(true);
    // Pure prose nouns far from any verb are fuzzy, not exact.
    expect(isExactCreationCandidate("Referral",
      "Referral management orchestration with several configuration steps and no creation here", [])).toBe(false);
    // Id-input echoes name pre-existing rows even beside a verb.
    expect(isExactCreationCandidate("ClinicalServiceRequest",
      "Creates a task for the clinical service request review", ["clinicalServiceRequestId"])).toBe(false);
    // Equality-only: a more-specific child stays exact beside a parent input.
    expect(isExactCreationCandidate("CaseProceedingParticipant",
      "Creates a case proceeding participant record for tracking", ["caseProceedingId"])).toBe(true);
  });
});

describe("reference stems and hints", () => {
  it("strips Hungarian prefixes before stem matching", () => {
    expect(stripHungarianPrefix("varCaseId")).toBe("CaseId");
    expect(stripHungarianPrefix("rvarCase")).toBe("Case");
    expect(stripHungarianPrefix("objContactIN")).toBe("ContactIN");
    expect(stripHungarianPrefix("recordId")).toBe("recordId");
    expect(referenceStem("varCaseId")).toBe("Case");
    expect(referenceStem("serviceAppointmentId")).toBe("serviceAppointment");
    expect(referenceStem("RecordId")).toBeNull();
    expect(referenceStem("recordId")).toBeNull();
    expect(isReferenceShaped("RecordId")).toBe(true);
    expect(isReferenceShaped("firstName")).toBe(false);
  });

  it("orders hint candidates from stem to route to description joins", () => {
    const hints = objectHintCandidates("varCaseId", null, ROUTE("t__Close"), null);
    expect(hints[0]).toBe("Case");
    const generic = objectHintCandidates(
      "RecordId",
      "Stores the ID of a major incident.",
      ROUTE("FSSK__FSK_Update_Work_Order_Child_Records"),
      "When a parent work order changes, child records update.");
    expect(generic).toContain("WorkOrder");
    expect(generic).toContain("MajorIncident");
    const csr = objectHintCandidates(
      "csrRecordId",
      "Stores the record ID of the clinical service request passed into the flow.",
      ROUTE("healthcloud__CreateCaseUpdateCSR"),
      "Creates a case from a clinical service request.");
    expect(csr).toContain("ClinicalServiceRequest");
  });

  it("ranks exact live names above containment matches", () => {
    expect(rankHintCandidates(["Case", "CaseComment"], ["CaseComment", "Case"])).toBe("Case");
    expect(rankHintCandidates(["Enrollee"], ["CareProgramEnrollee", "Account"])).toBe("CareProgramEnrollee");
    expect(rankHintCandidates(["Nope"], ["Account"])).toBeNull();
    expect(rankHintCandidates([], ["Account"])).toBeNull();
  });
});

describe("inputDocumentsRecord", () => {
  it("treats record phrasing and multi-word stems as records", () => {
    expect(inputDocumentsRecord("recordId", "The ID of the record that you want to swarm on.")).toBe(true);
    expect(inputDocumentsRecord("briefId", "Stores the ID of the campaign brief.")).toBe(true);
    expect(inputDocumentsRecord("serviceChannelId", null)).toBe(true);
    expect(inputDocumentsRecord("candidateId", "Stores the research study candidate ID.")).toBe(true);
    expect(inputDocumentsRecord("varCaseId", null)).toBe(true);
  });

  it("allows synthetic fillers for token/code descriptions", () => {
    expect(inputDocumentsRecord("CorrelationId", "Stores the CorrelationId when the fulfillment action is Credit Points."))
      .toBe(false);
    expect(inputDocumentsRecord("VoucherCode", "Stores the voucher code that is issued.")).toBe(false);
  });
});

describe("neutralOwnedValue", () => {
  it("fills JSON-documented inputs with empty documents", () => {
    expect(neutralOwnedValue("STRING", "Stores a JSON representation of the campaign messages.")).toBe("[]");
    expect(neutralOwnedValue("STRING", "A JSON object that maps field labels to values.")).toBe("{}");
    expect(neutralOwnedValue("BOOLEAN", null)).toBe(false);
    expect(neutralOwnedValue("DOUBLE", null)).toBe(0);
    expect(typeof neutralOwnedValue("STRING", null)).toBe("string");
  });
});

describe("prose, template, and picklist helpers", () => {
  it("shapes prose, template, and picklist choices from live evidence", () => {
    expect(isProseShaped("noteText")).toBe(true);
    expect(isProseShaped("description")).toBe(true);
    expect(isProseShaped("caseId")).toBe(false);
    expect(isTemplateShaped("emailTemplateId")).toBe(true);
    expect(isTemplateShaped("caseId")).toBe(false);
    expect(livePicklistChoice([
      { name: "Priority", picklistValues: [{ value: "High", active: true }, { value: "Low", active: false }] },
    ], "priority")).toBe("High");
    expect(livePicklistChoice([{ name: "Subject" }], "priority")).toBeNull();
    expect(livePicklistChoice([
      { name: "Priority", picklistValues: [{ value: "Old", active: false }] },
    ], "priority")).toBeNull();
    expect(descriptorPicklistChoice({ values: ["A"] })).toBe("A");
    expect(descriptorPicklistChoice({ picklistValues: [{ value: "B", active: true }] })).toBe("B");
    expect(descriptorPicklistChoice({})).toBeUndefined();
  });
});

describe("fixtureNumberValue", () => {
  it("prefers numbered fields, then Name, then the id", () => {
    expect(fixtureNumberValue({ AppointmentNumber: "SA-1", Name: "x" }, "id")).toBe("SA-1");
    expect(fixtureNumberValue({ Name: "x" }, "id")).toBe("x");
    expect(fixtureNumberValue({}, "id")).toBe("id");
  });
});

describe("isReadOnlyEvident", () => {
  const prompt = {
    inputs: [{ name: "approvalWorkItemName", type: "STRING" }],
    outputs: [{ name: "Prompt", type: "STRING" }],
    description: "Gets details and sends those details to the associated prompt template as prompt instructions.",
  };
  it("accepts prompt summarizers and rejects mutating shapes", () => {
    expect(isReadOnlyEvident(prompt, ROUTE("t__Sum"))).toBe(true);
    expect(isReadOnlyEvident({ ...prompt, hasCallout: true }, ROUTE("t__Sum"))).toBe(false);
    expect(isReadOnlyEvident(
      { inputs: [], outputs: [], description: "Creates a case from a request." }, ROUTE("t__Create"))).toBe(false);
    expect(isReadOnlyEvident(
      { inputs: [], outputs: [{ name: "rec", type: "SOBJECT" }] }, ROUTE("t__Lookup"))).toBe(false);
    expect(isReadOnlyEvident(null, ROUTE("t__Sum"))).toBe(false);
  });
  it("rejects underscore-joined mutation verbs in the route without a description", () => {
    const silent = { inputs: [{ name: "contactId", type: "STRING" }], outputs: [] };
    // Incident shape: an UPDATE flow whose descriptor carries no
    // description must never read as provably read-only.
    expect(isReadOnlyEvident(silent, ROUTE("SDO_Service_SunnyBots_Update_Chat_Transcript_Contact_Id"))).toBe(false);
    expect(isReadOnlyEvident(silent, ROUTE("t__Get_Summary"))).toBe(true);
    expect(isReadOnlyEvident(
      { inputs: [{ name: "updateStatus", type: "STRING" }], outputs: [] }, ROUTE("t__Lookup"))).toBe(false);
  });
});

describe("assessOwnedSubstrateOutcome", () => {
  const finished = (outputValues: Record<string, unknown>) =>
    [{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished", ...outputValues } }];
  it("gates on native success, Finished interviews, and clean outputs", () => {
    expect(assessOwnedSubstrateOutcome(200, finished({ contactId: CONTACT_ID })).ok).toBe(true);
    expect(assessOwnedSubstrateOutcome(200, finished({ msg: "An error occurred while saving." })).ok).toBe(false);
    expect(assessOwnedSubstrateOutcome(200, [{ isSuccess: false, errors: [], outputValues: {} }]).ok).toBe(false);
    expect(assessOwnedSubstrateOutcome(500, {}).code).toBe("FLOW_OWNED_PROBE_EXECUTION_FAILED");
    expect(interviewFinished(finished({}))).toBe(true);
    expect(interviewFinished([{ isSuccess: true, outputValues: { Flow__InterviewStatus: "Fault" } }])).toBe(false);
  });
});

describe("invokeOwnedSubstrate", () => {
  const CASE_DESCRIBE = {
    name: "Case", createable: true, queryable: true, deletable: true,
    fields: [{ name: "Subject", type: "string", createable: true, filterable: true, length: 255 }],
  };
  const CONTACT_DESCRIBE = {
    name: "Contact", createable: true, queryable: true, deletable: true,
    fields: [
      { name: "LastName", type: "string", createable: true, filterable: true, length: 80 },
      { name: "Email", type: "email", createable: true },
    ],
  };
  const CLOSE_DESCRIPTOR = {
    description: "Closes the entitlement process for the case.",
    inputs: [{ name: "varCaseId", type: "STRING", required: false, maxOccurs: 1 }],
    outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }, { name: "Flow__InterviewGuid", type: "STRING" }],
  };

  type Script = (path: string, method?: string, body?: any) => { status: number; ok: boolean; body: any } | null;
  const transport = (scripts: Script[], calls: string[]) =>
    async (path: string, method = "GET", body?: any) => {
      calls.push(`${method} ${path.slice(0, 120)}`);
      for (const script of scripts) {
        const hit = script(path, method, body);
        if (hit) return hit;
      }
      throw new Error(`unstubbed ${method} ${path}`);
    };
  const build = async (_name: string, _marker: string, values: Record<string, unknown>) => ({ values });

  it("retries trigger-nulled mints with enriched owned references", async () => {
    const SA_ID = "08p000000000000AAA";
    const ACCOUNT_ID = "001000000000000AAA";
    const APPT_DESCRIPTOR = {
      description: "Updates the service appointment status.",
      inputs: [{ name: "serviceAppointmentId", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }, { name: "Flow__InterviewGuid", type: "STRING" }],
    };
    const SA_DESCRIBE = {
      name: "ServiceAppointment", createable: true, queryable: true, deletable: true,
      fields: [
        { name: "Description", type: "string", createable: true, filterable: true, length: 255 },
        { name: "ParentRecordId", type: "reference", createable: true, nillable: true, referenceTo: ["Account"] },
      ],
    };
    const ACCOUNT_DESCRIBE = {
      name: "Account", createable: true, queryable: true, deletable: true,
      fields: [{ name: "Name", type: "string", createable: true, filterable: true, nameField: true, length: 255 }],
    };
    const TRIGGER_NULL = {
      status: 400, ok: false,
      body: [{
        message: "execution of BeforeInsert caused by: System.NullPointerException: Attempt to de-reference a null object",
        errorCode: "CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY",
      }],
    };
    const posted: Record<string, unknown>[] = [];
    const accountPosted: Record<string, unknown>[] = [];
    const calls: string[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__UpdateAppt") && method === "GET" ? ok(APPT_DESCRIPTOR) : null,
      (path) => path.includes("QualifiedApiName") ? records([{ QualifiedApiName: "ServiceAppointment" }]) : null,
      (path) => path.endsWith("/sobjects/ServiceAppointment/describe") ? ok(SA_DESCRIBE) : null,
      (path) => path.endsWith("/sobjects/Account/describe") ? ok(ACCOUNT_DESCRIBE) : null,
      (path, method, body) => {
        if (path === `${ROOT}/sobjects/ServiceAppointment` && method === "POST") {
          posted.push(body as Record<string, unknown>);
          if (typeof (body as Record<string, unknown>).ParentRecordId === "string") {
            return { status: 201, ok: true, body: { id: SA_ID } };
          }
          return TRIGGER_NULL;
        }
        return null;
      },
      (path, method, body) => {
        if (path === `${ROOT}/sobjects/Account` && method === "POST") {
          accountPosted.push(body as Record<string, unknown>);
          return { status: 201, ok: true, body: { id: ACCOUNT_ID } };
        }
        return null;
      },
      (path, method) => {
        if (path === `${ROOT}/sobjects/Account/${ACCOUNT_ID}` && method === "GET") {
          return ok({ Id: ACCOUNT_ID, Name: accountPosted[0].Name });
        }
        return null;
      },
      (path, method) => {
        if (path === `${ROOT}/sobjects/ServiceAppointment/${SA_ID}` && method === "GET") {
          return ok({ Id: SA_ID, Description: posted[0].Description, ParentRecordId: ACCOUNT_ID });
        }
        return null;
      },
      (path, method, body) => {
        if (path === ROUTE("t__UpdateAppt") && method === "POST") {
          const args = (body as { inputs: Array<Record<string, unknown>> }).inputs[0];
          expect(args.serviceAppointmentId).toBe(SA_ID);
          return ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }]);
        }
        return null;
      },
      (path, method, body) => {
        if (path === `${ROOT}/composite/batch` && method === "POST") {
          const reqs = (body as { batchRequests: Array<{ method: string; url: string }> }).batchRequests;
          // Recovery read returns created rows; every later batch deletes and verifies absence.
          if (reqs.every((entry) => entry.method === "GET") && !calls.some((call) => call.includes("/composite/batch"))) {
            return ok({
              results: reqs.map((entry) => ({
                statusCode: 200,
                result: { Id: entry.url.includes("/sobjects/Account/") ? ACCOUNT_ID : SA_ID },
              })),
            });
          }
          return ok({ results: reqs.map((entry) => ({ statusCode: entry.method === "DELETE" ? 204 : 404 })) });
        }
        return null;
      },
    ], calls);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__UpdateAppt"), plan: { kind: "owned_id_probe_via_auth", idInputs: ["serviceAppointmentId"] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.cleanupError).toBeUndefined();
    expect(outcome.contextSchema).toMatchObject({ verified: true });
    expect(posted).toHaveLength(2);
    expect(posted[0].ParentRecordId).toBeUndefined();
    expect(posted[1].ParentRecordId).toBe(ACCOUNT_ID);
  });

  it("completes Event fixtures with a forward slot for record-variable validation", async () => {
    const EVENT_ID = "00U000000000000AAA";
    const SLOT_DESCRIPTOR = {
      description: "Reads the chosen slot from the passed event.",
      inputs: [{ name: "objEvent", type: "SOBJECT", required: false, maxOccurs: 1, sObjectType: "Event" }],
      outputs: [{ name: "ChooseOwn", type: "BOOLEAN" }, { name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const EVENT_DESCRIBE = {
      name: "Event", createable: true, queryable: true, deletable: true,
      fields: [
        { name: "Subject", type: "string", createable: true, filterable: true, length: 255 },
        { name: "ActivityDateTime", type: "datetime", createable: true },
        { name: "DurationInMinutes", type: "int", createable: true },
        { name: "Description", type: "string", createable: true, filterable: true, length: 255 },
      ],
    };
    const posted: Record<string, unknown>[] = [];
    const seenArgs: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__Slot_Choose") && method === "GET" ? ok(SLOT_DESCRIPTOR) : null,
      (path) => path.includes("QualifiedApiName") ? records([{ QualifiedApiName: "Event" }]) : null,
      (path) => path.endsWith("/sobjects/Event/describe") ? ok(EVENT_DESCRIBE) : null,
      (path, method, body) => {
        if (path === `${ROOT}/sobjects/Event` && method === "POST") {
          posted.push(body as Record<string, unknown>);
          return { status: 201, ok: true, body: { id: EVENT_ID } };
        }
        return null;
      },
      (path, method) => {
        if (path === `${ROOT}/sobjects/Event/${EVENT_ID}` && method === "GET") {
          return ok({ Id: EVENT_ID, ...posted[0] });
        }
        return null;
      },
      (path, method, body) => {
        if (path === ROUTE("t__Slot_Choose") && method === "POST") {
          seenArgs.push((body as { inputs: Array<Record<string, unknown>> }).inputs[0]);
          return ok([{ isSuccess: true, errors: [], outputValues: { ChooseOwn: false, Flow__InterviewStatus: "Finished" } }]);
        }
        return null;
      },
      (path, method, body) => {
        if (path === `${ROOT}/composite/batch` && method === "POST") {
          const reqs = (body as { batchRequests: Array<{ method: string; url: string }> }).batchRequests;
          if (reqs.every((entry) => entry.method === "GET") && !calls.some((call) => call.includes("/composite/batch"))) {
            return ok({ results: reqs.map(() => ({ statusCode: 200, result: { Id: EVENT_ID } })) });
          }
          return ok({ results: reqs.map((entry) => ({ statusCode: entry.method === "DELETE" ? 204 : 404 })) });
        }
        return null;
      },
    ], calls);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__Slot_Choose"),
      plan: { kind: "owned_id_probe_via_auth", recordInputs: [{ inputName: "objEvent", objectName: "Event" }] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.cleanupError).toBeUndefined();
    expect(posted).toHaveLength(1);
    expect(posted[0].Subject).toMatch(/^AS owned /);
    expect(posted[0].DurationInMinutes).toBe(60);
    expect(Date.parse(posted[0].ActivityDateTime as string)).toBeGreaterThan(Date.now());
    expect((seenArgs[0].objEvent as Record<string, unknown>).DurationInMinutes).toBe(60);
  });

  it("enriches trigger-nulled mints best-effort when one parent is unmintable", async () => {
    const SA_ID = "08p000000000000AAA";
    const ACCOUNT_ID = "001000000000000AAA";
    const APPT_DESCRIPTOR = {
      description: "Updates the service appointment status.",
      inputs: [{ name: "serviceAppointmentId", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }, { name: "Flow__InterviewGuid", type: "STRING" }],
    };
    const SA_DESCRIBE = {
      name: "ServiceAppointment", createable: true, queryable: true, deletable: true,
      fields: [
        { name: "Description", type: "string", createable: true, filterable: true, length: 255 },
        { name: "ParentRecordId", type: "reference", createable: true, nillable: true, referenceTo: ["Account"] },
        { name: "WorkTypeId", type: "reference", createable: true, nillable: true, referenceTo: ["WorkType"] },
      ],
    };
    const ACCOUNT_DESCRIBE = {
      name: "Account", createable: true, queryable: true, deletable: true,
      fields: [{ name: "Name", type: "string", createable: true, filterable: true, nameField: true, length: 255 }],
    };
    const WORKTYPE_DESCRIBE = {
      name: "WorkType", createable: true, queryable: true, deletable: true,
      fields: [{ name: "Name", type: "string", createable: true, filterable: true, nameField: true, length: 255 }],
    };
    const TRIGGER_NULL = {
      status: 400, ok: false,
      body: [{
        message: "FSL.TR001_Service_BeforeInsert: execution of BeforeInsert\n\ncaused by: System.NullPointerException: Attempt to de-reference a null object\n\n(System Code)",
        errorCode: "CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY",
      }],
    };
    const posted: Record<string, unknown>[] = [];
    const accountPosted: Record<string, unknown>[] = [];
    const calls: string[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__UpdateAppt") && method === "GET" ? ok(APPT_DESCRIPTOR) : null,
      (path) => path.includes("QualifiedApiName") ? records([{ QualifiedApiName: "ServiceAppointment" }]) : null,
      (path) => path.endsWith("/sobjects/ServiceAppointment/describe") ? ok(SA_DESCRIBE) : null,
      (path) => path.endsWith("/sobjects/Account/describe") ? ok(ACCOUNT_DESCRIBE) : null,
      (path) => path.endsWith("/sobjects/WorkType/describe") ? ok(WORKTYPE_DESCRIBE) : null,
      (path, method, body) => {
        if (path === `${ROOT}/sobjects/ServiceAppointment` && method === "POST") {
          posted.push(body as Record<string, unknown>);
          return typeof (body as Record<string, unknown>).ParentRecordId === "string"
            ? { status: 201, ok: true, body: { id: SA_ID } }
            : TRIGGER_NULL;
        }
        return null;
      },
      (path, method, body) => {
        if (path === `${ROOT}/sobjects/Account` && method === "POST") {
          accountPosted.push(body as Record<string, unknown>);
          return { status: 201, ok: true, body: { id: ACCOUNT_ID } };
        }
        return null;
      },
      (path, method) => path === `${ROOT}/sobjects/WorkType` && method === "POST"
        ? { status: 403, ok: false, body: [{ message: "insufficient access", errorCode: "INSUFFICIENT_ACCESS" }] } : null,
      (path, method) => path === `${ROOT}/sobjects/Account/${ACCOUNT_ID}` && method === "GET"
        ? ok({ Id: ACCOUNT_ID, Name: accountPosted[0].Name }) : null,
      (path, method) => {
        if (path === `${ROOT}/sobjects/ServiceAppointment/${SA_ID}` && method === "GET") {
          return ok({ Id: SA_ID, Description: posted[0].Description, ParentRecordId: ACCOUNT_ID });
        }
        return null;
      },
      (path, method) => path === ROUTE("t__UpdateAppt") && method === "POST"
        ? ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }]) : null,
      (path, method, body) => {
        if (path === `${ROOT}/composite/batch` && method === "POST") {
          const reqs = (body as { batchRequests: Array<{ method: string; url: string }> }).batchRequests;
          if (reqs.every((entry) => entry.method === "GET") && !calls.some((call) => call.includes("/composite/batch"))) {
            return ok({
              results: reqs.map((entry) => ({
                statusCode: 200,
                result: { Id: entry.url.includes("/sobjects/Account/") ? ACCOUNT_ID : SA_ID },
              })),
            });
          }
          return ok({ results: reqs.map((entry) => ({ statusCode: entry.method === "DELETE" ? 204 : 404 })) });
        }
        return null;
      },
    ], calls);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__UpdateAppt"), plan: { kind: "owned_id_probe_via_auth", idInputs: ["serviceAppointmentId"] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.cleanupError).toBeUndefined();
    expect(posted).toHaveLength(2);
    expect(posted[1].ParentRecordId).toBe(ACCOUNT_ID);
    expect(posted[1].WorkTypeId).toBeUndefined();
  });

  it("refuses invalid routes, plans, and identities without org calls", async () => {
    const calls: string[] = [];
    const request = transport([], calls);
    const base = { root: ROOT, integrationUserId: SELF, request, build };
    expect((await invokeOwnedSubstrate({ ...base, route: `${ROOT}/sobjects/Case/describe`, plan: { kind: "owned_id_probe_via_auth" } })).body)
      .toMatchObject({ errorCode: "FLOW_OWNED_ROUTE_INVALID" });
    expect((await invokeOwnedSubstrate({ ...base, route: ROUTE("t__Close"), plan: { kind: "nope" } as never })).body)
      .toMatchObject({ errorCode: "FLOW_OWNED_PLAN_INVALID" });
    expect((await invokeOwnedSubstrate({ ...base, route: ROUTE("t__Close"), plan: { kind: "owned_id_probe_via_auth" }, integrationUserId: "bogus" })).body)
      .toMatchObject({ errorCode: "FLOW_OWNED_IDENTITY_INVALID" });
    expect(calls).toEqual([]);
  });

  it("refuses approval and external shapes before any write", async () => {
    const calls: string[] = [];
    const approval = {
      description: "Automates manager approvals, sending an approval email to the approver.",
      inputs: [{ name: "recordId", type: "STRING", required: false }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const request = transport([(path) => path === ROUTE("t__AppvlOrch") ? ok(approval) : null], calls);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__AppvlOrch"), plan: { kind: "owned_id_probe_via_auth", idInputs: ["recordId"] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.body).toMatchObject({ errorCode: "FLOW_APPROVAL_SUBMISSION_UNSUPPORTED" });
    expect(calls).toEqual([`GET ${ROUTE("t__AppvlOrch")}`]);
  });

  it("terminalizes unresolvable record targets with tried-hint evidence", async () => {
    const calls: string[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__Close") && method === "GET" ? ok(CLOSE_DESCRIPTOR) : null,
      (path) => path.includes("/query?") ? records([]) : null,
    ], calls);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__Close"), plan: { kind: "owned_id_probe_via_auth", idInputs: ["varCaseId"] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.body).toMatchObject({ errorCode: "FLOW_RECORD_TARGET_ABSENT" });
    expect(String(outcome.body.message)).toContain("varCaseId");
    expect(calls.some((call) => call.startsWith("POST") && call.includes("/sobjects/"))).toBe(false);
  });

  it("refuses creation without cleanable outputs before any write", async () => {
    const create = {
      description: "Creates a Return Order and line items for the specified Order.",
      inputs: [{ name: "rvarOrder", type: "SOBJECT", required: false, maxOccurs: 1, sObjectType: "Order" }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const orderDescribe = {
      name: "Order", createable: true, queryable: true, deletable: true,
      fields: [{ name: "OrderNumber", type: "string", createable: false, filterable: true, length: 32 }],
    };
    const calls: string[] = [];
    const request = transport([
      (path) => path === ROUTE("t__Create_Return_Order") ? ok(create) : null,
      (path) => path.includes("QualifiedApiName") ? records([{ QualifiedApiName: "Order" }]) : null,
      (path) => path.endsWith("/sobjects/Order/describe") ? ok(orderDescribe) : null,
    ], calls);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__Create_Return_Order"),
      plan: { kind: "owned_id_probe_via_auth", recordInputs: [{ inputName: "rvarOrder", objectName: "Order" }] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.body).toMatchObject({ errorCode: "FLOW_CREATED_CHILD_UNTRACKED" });
    expect(calls.some((call) => call.startsWith("POST") && call.includes("/sobjects/"))).toBe(false);
  });

  it("runs the owned close probe end to end with verified cleanup", async () => {
    const posted: unknown[] = [];
    const batches: unknown[] = [];
    const calls: string[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__Close") && method === "GET" ? ok(CLOSE_DESCRIPTOR) : null,
      (path) => path.includes("QualifiedApiName") ? records([{ QualifiedApiName: "Case" }]) : null,
      (path) => path.endsWith("/sobjects/Case/describe") ? ok(CASE_DESCRIBE) : null,
      (path, method, body) => {
        if (path === `${ROOT}/sobjects/Case` && method === "POST") {
          posted.push(body);
          return { status: 201, ok: true, body: { id: CASE_ID } };
        }
        return null;
      },
      (path, method) => {
        if (path === `${ROOT}/sobjects/Case/${CASE_ID}` && method === "GET") {
          const marker = (posted[0] as Record<string, string>).Subject;
          return ok({ Id: CASE_ID, Subject: marker });
        }
        return null;
      },
      (path, method, body) => {
        if (path === ROUTE("t__Close") && method === "POST") {
          const args = (body as { inputs: Array<Record<string, unknown>> }).inputs[0];
          expect(args.varCaseId).toBe(CASE_ID);
          return ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }]);
        }
        return null;
      },
      (path, method, body) => {
        if (path === `${ROOT}/composite/batch` && method === "POST") {
          batches.push(body);
          const readback = (body as { batchRequests: Array<{ method: string }> }).batchRequests.every((entry) => entry.method === "GET");
          if (readback) {
            const marker = (posted[0] as Record<string, string>).Subject;
            return ok({ results: [{ statusCode: 200, result: { Id: CASE_ID, Subject: marker } }] });
          }
          return ok({ results: [{ statusCode: 204 }, { statusCode: 404 }] });
        }
        return null;
      },
    ], calls);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__Close"), plan: { kind: "owned_id_probe_via_auth", idInputs: ["varCaseId"] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.cleanupError).toBeUndefined();
    expect(outcome.contextSchema).toMatchObject({ verified: true, mappings: [{ inputName: "varCaseId", objectName: "Case" }] });
    expect(posted).toHaveLength(1);
    expect(batches).toHaveLength(2);
  });

  it("creates with synthetic person content and deletes through the id output", async () => {
    const createContact = {
      description: "Creates a contact record for the guest user with the provided details.",
      inputs: [
        { name: "firstName", type: "STRING", required: false },
        { name: "lastName", type: "STRING", required: false },
        { name: "verifiedEmail", type: "STRING", required: false },
      ],
      outputs: [
        { name: "contactId", type: "STRING" },
        { name: "Flow__InterviewStatus", type: "PICKLIST" },
      ],
    };
    const invoked: unknown[] = [];
    const deleted: string[] = [];
    const now = Date.parse("2026-10-06T00:10:00.000Z");
    const request = transport([
      (path, method) => path === ROUTE("t__CreateContact") && method === "GET" ? ok(createContact) : null,
      (path, method, body) => {
        if (path === ROUTE("t__CreateContact") && method === "POST") {
          invoked.push(body);
          return ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished", contactId: CONTACT_ID } }]);
        }
        return null;
      },
      (path) => path.includes("KeyPrefix") ? records([{ QualifiedApiName: "Contact" }]) : null,
      (path) => path.includes("/query") && path.includes("QualifiedApiName") ? records([]) : null,
      (path) => path.endsWith("/sobjects/Contact/describe") ? ok(CONTACT_DESCRIBE) : null,
      (path, method) => {
        if (path === `${ROOT}/sobjects/Contact/${CONTACT_ID}` && method === "GET") {
          return deleted.length ? { status: 404, ok: false, body: null } : ok({ Id: CONTACT_ID, CreatedDate: "2026-10-06T00:09:00.000Z" });
        }
        if (path === `${ROOT}/sobjects/Contact/${CONTACT_ID}` && method === "DELETE") {
          deleted.push(path);
          return { status: 204, ok: true, body: null };
        }
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__CreateContact"), plan: { kind: "scalar_create_via_auth", cleanupOutputs: ["contactId"] },
      integrationUserId: SELF, request, build, now: () => now,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.contextSchema).toMatchObject({ verified: true, createdChildren: [{ objectName: "Contact", id: CONTACT_ID }] });
    expect(deleted).toEqual([`${ROOT}/sobjects/Contact/${CONTACT_ID}`]);
    const args = (invoked[0] as { inputs: Array<Record<string, unknown>> }).inputs[0];
    expect(Object.keys(args).sort()).toEqual(["firstName", "lastName", "verifiedEmail"]);
  });

  it("withholds created-row deletes outside the probe window", async () => {
    const createContact = {
      description: "Creates a contact record for the guest user with the provided details.",
      inputs: [{ name: "lastName", type: "STRING", required: false }],
      outputs: [{ name: "contactId", type: "STRING" }, { name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const deleted: string[] = [];
    const now = Date.parse("2026-10-06T00:10:00.000Z");
    const request = transport([
      (path, method) => path === ROUTE("t__CreateContact") && method === "GET" ? ok(createContact) : null,
      (path, method) => path === ROUTE("t__CreateContact") && method === "POST"
        ? ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished", contactId: CONTACT_ID } }])
        : null,
      (path) => path.includes("KeyPrefix") ? records([{ QualifiedApiName: "Contact" }]) : null,
      (path) => path.endsWith("/sobjects/Contact/describe") ? ok(CONTACT_DESCRIBE) : null,
      (path, method) => {
        if (path === `${ROOT}/sobjects/Contact/${CONTACT_ID}` && method === "GET") {
          return ok({ Id: CONTACT_ID, CreatedDate: "2026-09-01T00:00:00.000Z" });
        }
        if (method === "DELETE") {
          deleted.push(path);
          return { status: 204, ok: true, body: null };
        }
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__CreateContact"), plan: { kind: "scalar_create_via_auth", cleanupOutputs: ["contactId"] },
      integrationUserId: SELF, request, build, now: () => now,
    });
    expect(deleted).toEqual([]);
    expect(outcome.cleanupError).toContain("probe-window");
    expect(outcome.contextSchema).toMatchObject({ verified: false });
  });

  it("stamps opaque execution faults with a missing-invocable verdict", async () => {
    const calc = {
      description: "Looks up the account summary for the supplied identifier.",
      inputs: [{ name: "accountCode", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const calls: string[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__Calc") && method === "GET" ? ok(calc) : null,
      (path, method) => path === ROUTE("t__Calc") && method === "POST"
        ? { status: 400, ok: false, body: [{ message: "An error occurred when executing a flow interview.", errorCode: "UNKNOWN_EXCEPTION" }] }
        : null,
      (path) => path.includes("/tooling/query") && path.includes("FlowDefinition")
        ? records([{ DeveloperName: "t__Calc", NamespacePrefix: null, ActiveVersionId: "301000000000001AAA" }])
        : null,
      (path) => path.includes("/tooling/query") && path.includes("SELECT%20Metadata")
        ? records([{ Metadata: { actionCalls: [{ actionName: "MissingHelper", actionType: "apex" }] } }])
        : null,
      (path) => path === `${ROOT}/actions/custom/apex/MissingHelper` ? { status: 404, ok: false, body: [] } : null,
      (path) => path.includes("ApexClass") ? records([]) : null,
      (path) => path === `${ROOT}/actions/standard` ? ok({ actions: [] }) : null,
    ], calls);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__Calc"), plan: { kind: "scalar_create_via_auth" },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(422);
    expect(outcome.body).toMatchObject({ errorCode: "FLOW_OWNED_PROBE_EXECUTION_FAILED" });
    expect(outcome.body.managedFlowFault).toMatchObject({
      code: "FLOW_EXECUTION_INVOCABLE_MISSING", retryable: true, invocableName: "MissingHelper",
    });
    expect(outcome.body.managedFlowFault.requirement).not.toContain("executing a flow interview");
    expect(outcome.contextSchema).toMatchObject({
      verified: false, managedFlowFault: { code: "FLOW_EXECUTION_INVOCABLE_MISSING" },
    });
    expect(calls.filter((call) => call.includes("/tooling/"))).toHaveLength(3);
    expect(calls.length).toBeLessThanOrEqual(7);
  });

  it("stamps opaque execution faults with a terminal skew verdict", async () => {
    const calc = {
      description: "Looks up the account summary for the supplied identifier.",
      inputs: [{ name: "accountCode", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const request = transport([
      (path, method) => path === ROUTE("t__Calc") && method === "GET" ? ok(calc) : null,
      (path, method) => path === ROUTE("t__Calc") && method === "POST"
        ? { status: 400, ok: false, body: [{ message: "An error occurred when executing a flow interview.", errorCode: "UNKNOWN_EXCEPTION" }] }
        : null,
      (path) => path.includes("/tooling/query") && path.includes("FlowDefinition")
        ? records([{ DeveloperName: "t__Calc", NamespacePrefix: null, ActiveVersionId: "301000000000001AAA" }])
        : null,
      (path) => path.includes("/tooling/query") && path.includes("SELECT%20Metadata")
        ? records([{ Metadata: { recordLookups: [{ object: "Asset", filters: [{ field: "ProductDescription", operator: "EqualTo" }] }] } }])
        : null,
      (path) => path.endsWith("/sobjects/Asset/describe")
        ? ok({ name: "Asset", fields: [{ name: "Id" }, { name: "Name" }] })
        : null,
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__Calc"), plan: { kind: "scalar_create_via_auth" },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.body).toMatchObject({ errorCode: "FLOW_OWNED_PROBE_EXECUTION_FAILED" });
    expect(outcome.body.managedFlowFault).toMatchObject({
      code: "FLOW_EXECUTION_SCHEMA_SKEW", retryable: false, objectName: "Asset", fieldName: "ProductDescription",
    });
    expect(outcome.contextSchema).toMatchObject({
      verified: false, managedFlowFault: { code: "FLOW_EXECUTION_SCHEMA_SKEW" },
    });
  });

  it("keeps the generic stamp when evidence is absent or unverifiable", async () => {
    const calc = {
      description: "Looks up the account summary for the supplied identifier.",
      inputs: [{ name: "accountCode", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const opaque = {
      status: 400, ok: false,
      body: [{ message: "An error occurred when executing a flow interview.", errorCode: "UNKNOWN_EXCEPTION" }],
    };
    const definition = records([{ DeveloperName: "t__Calc", NamespacePrefix: null, ActiveVersionId: "301000000000001AAA" }]);
    // No metadata references: generic stamp, no evidence reads.
    const quiet: string[] = [];
    const bare = transport([
      (path, method) => path === ROUTE("t__Calc") && method === "GET" ? ok(calc) : null,
      (path, method) => path === ROUTE("t__Calc") && method === "POST" ? opaque : null,
      (path) => path.includes("/tooling/query") && path.includes("FlowDefinition") ? definition : null,
      (path) => path.includes("/tooling/query") && path.includes("SELECT%20Metadata") ? records([{ Metadata: {} }]) : null,
    ], quiet);
    const generic = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__Calc"), plan: { kind: "scalar_create_via_auth" },
      integrationUserId: SELF, request: bare, build,
    });
    expect(generic.body).toMatchObject({
      errorCode: "FLOW_OWNED_PROBE_EXECUTION_FAILED",
      managedFlowFault: { code: "MANAGED_FLOW_EXECUTION_FAULT", retryable: true },
    });
    expect(quiet.some((call) => call.includes("ApexClass") || call.includes("/actions/custom/apex"))).toBe(false);
    // Unverifiable evidence surfaces (unstubbed reads throw inside the
    // guarded collector): the assessed failure still stands, generic.
    const throwing = transport([
      (path, method) => path === ROUTE("t__Calc") && method === "GET" ? ok(calc) : null,
      (path, method) => path === ROUTE("t__Calc") && method === "POST" ? opaque : null,
      (path) => path.includes("/tooling/query") && path.includes("FlowDefinition") ? definition : null,
      (path) => path.includes("/tooling/query") && path.includes("SELECT%20Metadata")
        ? records([{ Metadata: { actionCalls: [{ actionName: "MissingHelper", actionType: "apex" }] } }])
        : null,
    ], []);
    const kept = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__Calc"), plan: { kind: "scalar_create_via_auth" },
      integrationUserId: SELF, request: throwing, build,
    });
    expect(kept.body).toMatchObject({
      errorCode: "FLOW_OWNED_PROBE_EXECUTION_FAILED",
      managedFlowFault: { code: "MANAGED_FLOW_EXECUTION_FAULT" },
    });
  });

  it("adds no stamp and no reads for non-opaque failures", async () => {
    const calc = {
      description: "Looks up the account summary for the supplied identifier.",
      inputs: [{ name: "accountCode", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const calls: string[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__Calc") && method === "GET" ? ok(calc) : null,
      (path, method) => path === ROUTE("t__Calc") && method === "POST"
        ? { status: 400, ok: false, body: [{ message: "Something else broke.", errorCode: "UNKNOWN_EXCEPTION" }] }
        : null,
    ], calls);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__Calc"), plan: { kind: "scalar_create_via_auth" },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.body).toMatchObject({ errorCode: "FLOW_OWNED_PROBE_EXECUTION_FAILED" });
    expect(outcome.body.managedFlowFault).toBeUndefined();
    expect(outcome.contextSchema.managedFlowFault).toBeUndefined();
    expect(calls.some((call) => call.includes("/tooling/"))).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("stamps assessed output failures with the R5 setup/input branches only", () => {
    expect(diagnoseSubstrateOutputText({ outputValues: {
      Flow__InterviewStatus: "Finished", Error: "Error: Work Type not found",
    } })).toMatchObject({ code: "FLOW_SETUP_RECORD_REQUIRED", setupNoun: "Work Type", retryable: true });
    expect(diagnoseSubstrateOutputText({ outputValues: {
      Flow__InterviewStatus: "Finished",
      resultMessage: "Failed: Looks like you don't have access to get appointment time slots.",
    } })).toMatchObject({ code: "FLOW_UPSTREAM_ACCESS_REQUIRED", retryable: true });
    // Non-R5 branches never stamp here, even when the taxonomy matches them.
    expect(diagnoseSubstrateOutputText({ outputValues: { Flow__InterviewStatus: "Finished", note: "ItemSysId is null" } })).toBeNull();
    expect(diagnoseSubstrateOutputText({ outputValues: { Flow__InterviewStatus: "Finished" } })).toBeNull();
    expect(diagnoseSubstrateOutputText({ outputValues: {} })).toBeNull();
  });

  it("stamps missing-setup outputs end to end without extra reads", async () => {
    const calc = {
      description: "Looks up the schedule for the supplied work type name.",
      inputs: [{ name: "strWTName", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }, { name: "Error", type: "STRING" }],
    };
    const calls: string[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__LookupSA") && method === "GET" ? ok(calc) : null,
      (path, method) => path === ROUTE("t__LookupSA") && method === "POST"
        ? ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished", Error: "Error: Work Type not found" } }])
        : null,
    ], calls);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__LookupSA"), plan: { kind: "scalar_create_via_auth" },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(422);
    expect(outcome.body).toMatchObject({
      errorCode: "FLOW_OWNED_PROBE_OUTPUT_FAILED",
      managedFlowFault: { code: "FLOW_SETUP_RECORD_REQUIRED", setupNoun: "Work Type" },
    });
    expect(outcome.contextSchema).toMatchObject({
      verified: false, managedFlowFault: { code: "FLOW_SETUP_RECORD_REQUIRED" },
    });
    expect(calls.some((call) => call.includes("/tooling/"))).toBe(false);
  });

  it("addresses notification recipients to the live integration user", async () => {
    const notify = {
      description: "Sends a custom notification when the appointment is dispatched.",
      inputs: [
        { name: "recipientIds", type: "STRING", required: false, maxOccurs: 2000 },
        { name: "notificationId", type: "STRING", required: false, maxOccurs: 1 },
        { name: "serviceAppointmentId", type: "STRING", required: false, maxOccurs: 1 },
      ],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const saDescribe = {
      name: "ServiceAppointment", createable: true, queryable: true, deletable: true,
      fields: [{ name: "Subject", type: "string", createable: true, filterable: true, length: 255 }],
    };
    const SA_ID = "0WO000000000000EAA";
    const TYPE_ID = "0ML000000000000EAA";
    const invoked: unknown[] = [];
    const posted: unknown[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__Notify") && method === "GET" ? ok(notify) : null,
      (path) => path.includes("CustomNotificationType") && path.includes("EntityDefinition")
        ? records([{ QualifiedApiName: "CustomNotificationType" }]) : null,
      (path) => path.includes("CustomNotificationType") && path.includes("LIMIT")
        ? records([{ Id: TYPE_ID }]) : null,
      (path) => path.includes("QualifiedApiName") ? records([{ QualifiedApiName: "ServiceAppointment" }]) : null,
      (path) => path.endsWith("/sobjects/ServiceAppointment/describe") ? ok(saDescribe) : null,
      (path, method, body) => {
        if (path === `${ROOT}/sobjects/ServiceAppointment` && method === "POST") {
          posted.push(body);
          return { status: 201, ok: true, body: { id: SA_ID } };
        }
        return null;
      },
      (path, method) => {
        if (path === `${ROOT}/sobjects/ServiceAppointment/${SA_ID}` && method === "GET") {
          const marker = (posted[0] as Record<string, string>).Subject;
          return ok({ Id: SA_ID, Subject: marker });
        }
        return null;
      },
      (path, method, body) => {
        if (path === ROUTE("t__Notify") && method === "POST") {
          invoked.push(body);
          return ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }]);
        }
        return null;
      },
      (path, method, body) => {
        if (path === `${ROOT}/composite/batch` && method === "POST") {
          const readback = (body as { batchRequests: Array<{ method: string }> }).batchRequests.every((entry) => entry.method === "GET");
          if (readback) {
            const marker = (posted[0] as Record<string, string>).Subject;
            return ok({ results: [{ statusCode: 200, result: { Id: SA_ID, Subject: marker } }] });
          }
          return ok({ results: [{ statusCode: 204 }, { statusCode: 404 }] });
        }
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__Notify"),
      plan: { kind: "notification_self_via_auth", recipientInputs: ["recipientIds"], idInputs: ["serviceAppointmentId"] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(200);
    const args = (invoked[0] as { inputs: Array<Record<string, unknown>> }).inputs[0];
    expect(args.recipientIds).toEqual([SELF]);
    expect(args.notificationId).toBe(TYPE_ID);
    expect(args.serviceAppointmentId).toBe(SA_ID);
  });

  it("retains strong setup references and never pre-poisons the type sample", async () => {
    // FSAA__AA_Custom_NotificationFlow shape: the searcher lists every
    // reference input in idInputs, including notificationId. Ranking must
    // exempt the type input (the live CustomNotificationType sample binds
    // downstream) and must retain the strong ServiceResource hit (borrowed
    // live row) instead of substituting a weaker fixtureable object.
    const notify = {
      description: "Sends the appointment notification.",
      inputs: [
        { name: "recipientIds", type: "STRING", required: false, maxOccurs: 2000 },
        { name: "notificationId", type: "STRING", required: false, maxOccurs: 1 },
        { name: "serviceResourceId", type: "STRING", required: false, maxOccurs: 1 },
      ],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const resourceDescribe = {
      name: "ServiceResource", createable: true, queryable: true, deletable: false,
      fields: [{ name: "Name", type: "string", createable: true, filterable: true, length: 80 }],
    };
    const RES_ID = "0Hn000000000000EAA";
    const TYPE_ID = "0ML000000000000EAA";
    const invoked: unknown[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__NotifyRes") && method === "GET" ? ok(notify) : null,
      (path) => path.includes("CustomNotificationType") && path.includes("EntityDefinition")
        ? records([{ QualifiedApiName: "CustomNotificationType" }]) : null,
      (path) => path.includes("CustomNotificationType") && path.includes("LIMIT")
        ? records([{ Id: TYPE_ID }]) : null,
      (path) => path.includes("/query") && path.includes("ServiceResource") && !path.includes("QualifiedApiName")
        ? records([{ Id: RES_ID }]) : null,
      (path) => path.includes("QualifiedApiName") ? records([{ QualifiedApiName: "ServiceResource" }]) : null,
      (path) => path.endsWith("/sobjects/ServiceResource/describe") ? ok(resourceDescribe) : null,
      (path, method, body) => {
        if (path === ROUTE("t__NotifyRes") && method === "POST") {
          invoked.push(body);
          return ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }]);
        }
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__NotifyRes"),
      plan: { kind: "notification_self_via_auth", recipientInputs: ["recipientIds"],
        idInputs: ["notificationId", "serviceResourceId"] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(200);
    const args = (invoked[0] as { inputs: Array<Record<string, unknown>> }).inputs[0];
    expect(args.serviceResourceId).toBe(RES_ID);
    expect(args.notificationId).toBe(TYPE_ID);
    expect(args.recipientIds).toEqual([SELF]);
  });

  it("refuses strong non-setup misses honestly instead of substituting", async () => {
    const lookup = {
      description: "Looks up the territory record.",
      inputs: [{ name: "serviceTerritoryId", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const territoryDescribe = {
      name: "ServiceTerritory", createable: true, queryable: true, deletable: false,
      fields: [{ name: "Name", type: "string", createable: true, filterable: true, length: 80 }],
    };
    const invoked: unknown[] = [];
    const posted: unknown[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__LookupTerr") && method === "GET" ? ok(lookup) : null,
      (path) => path.includes("QualifiedApiName") ? records([{ QualifiedApiName: "ServiceTerritory" }]) : null,
      (path) => path.endsWith("/sobjects/ServiceTerritory/describe") ? ok(territoryDescribe) : null,
      (path, method, body) => {
        if (path.includes("/sobjects/") && method === "POST" && !path.includes("/actions/")) {
          posted.push(body);
          return { status: 201, ok: true, body: { id: CASE_ID } };
        }
        return null;
      },
      (path, method, body) => {
        if (path === ROUTE("t__LookupTerr") && method === "POST") {
          invoked.push(body);
          return ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }]);
        }
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__LookupTerr"),
      plan: { kind: "owned_id_probe_via_auth", idInputs: ["serviceTerritoryId"] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(422);
    expect((outcome.body as { errorCode: string }).errorCode).toBe("FLOW_RECORD_CONTEXT_UNAVAILABLE");
    expect(invoked).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it("binds an operator conversation instead of refusing unmintable references", async () => {
    const convoId = "0dw000000000001AAA";
    const lookup = {
      description: "Posts analysis for the conversation record.",
      inputs: [{ name: "conversationID", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const convoDescribe = {
      name: "Conversation", createable: false, queryable: true, deletable: false,
      fields: [{ name: "Id", type: "id" }],
    };
    const invoked: unknown[] = [];
    const request = transport([
      (path, method) => path === ROUTE("x__PostConvo") && method === "GET" ? ok(lookup) : null,
      (path) => path.includes("QualifiedApiName") ? records([{ QualifiedApiName: "Conversation" }]) : null,
      (path) => path.endsWith("/sobjects/Conversation/describe") ? ok(convoDescribe) : null,
      (path) => path === `${ROOT}/sobjects/Conversation/${convoId}` ? ok({ Id: convoId }) : null,
      (path, method, body) => {
        if (path === ROUTE("x__PostConvo") && method === "POST") {
          invoked.push(body);
          return ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }]);
        }
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("x__PostConvo"),
      plan: { kind: "owned_id_probe_via_auth", idInputs: ["conversationID"], operatorConversationId: convoId },
      integrationUserId: SELF, request, build,
    });
    expect(invoked).toHaveLength(1);
    const args = (invoked[0] as { inputs: Array<Record<string, unknown>> }).inputs[0];
    expect(args.conversationID).toBe(convoId);
    expect(outcome.contextSchema).toMatchObject({ operatorConversationInputs: ["conversationID"] });
  });

  it("refuses unmintable references without an operator conversation", async () => {
    const lookup = {
      description: "Posts analysis for the conversation record.",
      inputs: [{ name: "conversationID", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const convoDescribe = {
      name: "Conversation", createable: false, queryable: true, deletable: false,
      fields: [{ name: "Id", type: "id" }],
    };
    const invoked: unknown[] = [];
    const request = transport([
      (path, method) => path === ROUTE("x__PostConvo") && method === "GET" ? ok(lookup) : null,
      (path) => path.includes("QualifiedApiName") ? records([{ QualifiedApiName: "Conversation" }]) : null,
      (path) => path.endsWith("/sobjects/Conversation/describe") ? ok(convoDescribe) : null,
      (path, method, body) => {
        if (path === ROUTE("x__PostConvo") && method === "POST") {
          invoked.push(body);
          return ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }]);
        }
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("x__PostConvo"),
      plan: { kind: "owned_id_probe_via_auth", idInputs: ["conversationID"] },
      integrationUserId: SELF, request, build,
    });
    expect((outcome.body as { errorCode: string }).errorCode).toBe("FLOW_RECORD_CONTEXT_UNAVAILABLE");
    expect(invoked).toHaveLength(0);
  });

  it("wraps retained setup ids for collection inputs", async () => {
    const notify = {
      description: "Sends the appointment notification.",
      inputs: [
        { name: "recipientIds", type: "STRING", required: false, maxOccurs: 2000 },
        { name: "serviceResourceIds", type: "STRING", required: false, maxOccurs: 2000 },
      ],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const resourceDescribe = {
      name: "ServiceResource", createable: true, queryable: true, deletable: false,
      fields: [{ name: "Name", type: "string", createable: true, filterable: true, length: 80 }],
    };
    const RES_ID = "0Hn000000000000EAA";
    const invoked: unknown[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__NotifyResList") && method === "GET" ? ok(notify) : null,
      (path) => path.includes("/query") && path.includes("ServiceResource") && !path.includes("QualifiedApiName")
        ? records([{ Id: RES_ID }]) : null,
      (path) => path.includes("QualifiedApiName") ? records([{ QualifiedApiName: "ServiceResource" }]) : null,
      (path) => path.endsWith("/sobjects/ServiceResource/describe") ? ok(resourceDescribe) : null,
      (path, method, body) => {
        if (path === ROUTE("t__NotifyResList") && method === "POST") {
          invoked.push(body);
          return ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }]);
        }
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__NotifyResList"),
      plan: { kind: "notification_self_via_auth", recipientInputs: ["recipientIds"],
        idInputs: ["serviceResourceIds"] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(200);
    const args = (invoked[0] as { inputs: Array<Record<string, unknown>> }).inputs[0];
    expect(args.serviceResourceIds).toEqual([RES_ID]);
  });

  it("falls back to an owned Case fixture for bare record ids when allowed", async () => {
    const update = {
      description: "Updates the record status.",
      inputs: [{ name: "RecordId", type: "STRING", required: false, maxOccurs: 1,
        description: "The ID of the record to update." }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const posted: unknown[] = [];
    const batches: unknown[] = [];
    const invoked: unknown[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__UpdateRecord") && method === "GET" ? ok(update) : null,
      (path) => path.includes("QualifiedApiName") ? records([{ QualifiedApiName: "Case" }]) : null,
      (path) => path.endsWith("/sobjects/Case/describe") ? ok(CASE_DESCRIBE) : null,
      (path, method, body) => {
        if (path === `${ROOT}/sobjects/Case` && method === "POST") {
          posted.push(body);
          return { status: 201, ok: true, body: { id: CASE_ID } };
        }
        return null;
      },
      (path, method) => path === `${ROOT}/sobjects/Case/${CASE_ID}` && method === "GET"
        ? ok({ Id: CASE_ID, Subject: (posted[0] as Record<string, string>).Subject }) : null,
      (path, method, body) => {
        if (path === ROUTE("t__UpdateRecord") && method === "POST") {
          invoked.push(body);
          return ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }]);
        }
        return null;
      },
      (path, method, body) => {
        if (path === `${ROOT}/composite/batch` && method === "POST") {
          batches.push(body);
          const readback = (body as { batchRequests: Array<{ method: string }> }).batchRequests.every((entry) => entry.method === "GET");
          if (readback) {
            const marker = (posted[0] as Record<string, string>).Subject;
            return ok({ results: [{ statusCode: 200, result: { Id: CASE_ID, Subject: marker } }] });
          }
          return ok({ results: [{ statusCode: 204 }, { statusCode: 404 }] });
        }
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__UpdateRecord"),
      plan: { kind: "owned_id_probe_via_auth", idInputs: ["RecordId"], allowBareRecordFallback: true },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.cleanupError).toBeUndefined();
    expect(outcome.contextSchema).toMatchObject({ verified: true, mappings: [{ inputName: "RecordId", objectName: "Case" }] });
    expect((invoked[0] as { inputs: Array<Record<string, unknown>> }).inputs[0].RecordId).toBe(CASE_ID);
    expect(posted).toHaveLength(1);
    expect(batches).toHaveLength(2);
  });

  it("omits optional generic misses without fixtures instead of guessing", async () => {
    const update = {
      description: "Updates the record status.",
      inputs: [{ name: "RecordId", type: "STRING", required: false, maxOccurs: 1,
        description: "The ID of the record to update." }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const invoked: unknown[] = [];
    const backed: string[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__UpdateRecord") && method === "GET" ? ok(update) : null,
      (path) => path.includes("/query?") ? records([]) : null,
      (path, method, body) => {
        if (path === ROUTE("t__UpdateRecord") && method === "POST") {
          invoked.push(body);
          return ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }]);
        }
        return null;
      },
      (path, method) => {
        if (path.includes("/sobjects/") && method === "POST") backed.push(path);
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__UpdateRecord"),
      plan: { kind: "owned_id_probe_via_auth", idInputs: ["RecordId"] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.contextSchema).toMatchObject({ verified: true, omittedInputs: ["RecordId"] });
    expect((invoked[0] as { inputs: Array<Record<string, unknown>> }).inputs[0]).toEqual({});
    expect(backed).toEqual([]);
  });

  it("binds collection references as single-element owned arrays", async () => {
    const close = {
      description: "Closes the entitlement processes for the cases.",
      inputs: [{ name: "caseIds", type: "STRING", required: false, maxOccurs: 2000,
        description: "The IDs of the cases to close." }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const posted: unknown[] = [];
    const invoked: unknown[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__CloseMany") && method === "GET" ? ok(close) : null,
      (path) => path.includes("QualifiedApiName") ? records([{ QualifiedApiName: "Case" }]) : null,
      (path) => path.endsWith("/sobjects/Case/describe") ? ok(CASE_DESCRIBE) : null,
      (path, method, body) => {
        if (path === `${ROOT}/sobjects/Case` && method === "POST") {
          posted.push(body);
          return { status: 201, ok: true, body: { id: CASE_ID } };
        }
        return null;
      },
      (path, method) => path === `${ROOT}/sobjects/Case/${CASE_ID}` && method === "GET"
        ? ok({ Id: CASE_ID, Subject: (posted[0] as Record<string, string>).Subject }) : null,
      (path, method, body) => {
        if (path === ROUTE("t__CloseMany") && method === "POST") {
          invoked.push(body);
          return ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }]);
        }
        return null;
      },
      (path, method, body) => {
        if (path === `${ROOT}/composite/batch` && method === "POST") {
          const readback = (body as { batchRequests: Array<{ method: string }> }).batchRequests.every((entry) => entry.method === "GET");
          if (readback) {
            const marker = (posted[0] as Record<string, string>).Subject;
            return ok({ results: [{ statusCode: 200, result: { Id: CASE_ID, Subject: marker } }] });
          }
          return ok({ results: [{ statusCode: 204 }, { statusCode: 404 }] });
        }
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__CloseMany"),
      plan: { kind: "owned_id_probe_via_auth", idInputs: ["caseIds"] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.contextSchema).toMatchObject({ verified: true });
    expect((invoked[0] as { inputs: Array<Record<string, unknown>> }).inputs[0].caseIds).toEqual([CASE_ID]);
  });

  it("read-probes self-bind users and synthesize keys without fixtures", async () => {
    const get = {
      description: "Gets the account summary for the record.",
      inputs: [
        { name: "userId", type: "STRING", required: false, maxOccurs: 1 },
        { name: "summaryKey", type: "STRING", required: false, maxOccurs: 1 },
      ],
      outputs: [{ name: "summary", type: "STRING" }],
    };
    const invoked: unknown[] = [];
    const calls: string[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__GetSummary") && method === "GET" ? ok(get) : null,
      (path, method, body) => {
        if (path === ROUTE("t__GetSummary") && method === "POST") {
          invoked.push(body);
          return ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished", summary: "ok" } }]);
        }
        return null;
      },
    ], calls);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__GetSummary"),
      plan: { kind: "read_probe_via_auth", idInputs: ["userId", "summaryKey"], generative: false },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.contextSchema).toMatchObject({ verified: true, planKind: "read_probe_via_auth" });
    const args = (invoked[0] as { inputs: Array<Record<string, unknown>> }).inputs[0];
    expect(args.userId).toBe(SELF);
    expect(String(args.summaryKey)).toMatch(/^probe-nonexistent-/);
    expect(calls.some((call) => call.includes("/sobjects/"))).toBe(false);
  });

  it("reads past bare text without the external-channel refusal", async () => {
    const read = {
      description: "Reads the record text for display.",
      inputs: [{ name: "caseKey", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "summary", type: "STRING" }],
    };
    const request = transport([
      (path, method) => path === ROUTE("t__ReadNote") && method === "GET" ? ok(read) : null,
      (path, method) => path === ROUTE("t__ReadNote") && method === "POST"
        ? ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished", summary: "ok" } }]) : null,
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__ReadNote"),
      plan: { kind: "read_probe_via_auth", idInputs: ["caseKey"], generative: false },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.contextSchema).toMatchObject({ verified: true });
  });

  it("gates generative reads on non-empty generated text", async () => {
    const gen = {
      description: "Generates the account brief for review.",
      inputs: [{ name: "accountKey", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "brief", type: "STRING" }],
    };
    let brief = "";
    const request = transport([
      (path, method) => path === ROUTE("t__GenBrief") && method === "GET" ? ok(gen) : null,
      (path, method) => path === ROUTE("t__GenBrief") && method === "POST"
        ? ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished", brief } }]) : null,
    ], []);
    const run = () => invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__GenBrief"),
      plan: { kind: "read_probe_via_auth", idInputs: ["accountKey"], generative: true },
      integrationUserId: SELF, request, build,
    });
    const empty = await run();
    expect(empty.body).toMatchObject({ errorCode: "FLOW_OWNED_PROBE_OUTPUT_FAILED" });
    brief = "Quarterly renewal insights for the owned account.";
    const filled = await run();
    expect(filled.status).toBe(200);
    expect(filled.contextSchema).toMatchObject({ verified: true });
  });

  it("delete-probes verify absence best-effort and clean survivors normally", async () => {
    const del = {
      description: "Deletes the draft case record.",
      inputs: [{ name: "caseId", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const posted: unknown[] = [];
    let gets = 0;
    let gone = false;
    const request = transport([
      (path, method) => path === ROUTE("t__DeleteDraft") && method === "GET" ? ok(del) : null,
      (path) => path.includes("QualifiedApiName") ? records([{ QualifiedApiName: "Case" }]) : null,
      (path) => path.endsWith("/sobjects/Case/describe") ? ok(CASE_DESCRIBE) : null,
      (path, method, body) => {
        if (path === `${ROOT}/sobjects/Case` && method === "POST") {
          posted.push(body);
          return { status: 201, ok: true, body: { id: CASE_ID } };
        }
        return null;
      },
      (path, method) => {
        if (path === `${ROOT}/sobjects/Case/${CASE_ID}` && method === "GET") {
          gets += 1;
          if (gone && gets > 1) return { status: 404, ok: false, body: null };
          return ok({ Id: CASE_ID, Subject: (posted[0] as Record<string, string>).Subject });
        }
        return null;
      },
      (path, method) => path === ROUTE("t__DeleteDraft") && method === "POST"
        ? ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }]) : null,
      (path, method, body) => {
        if (path === `${ROOT}/composite/batch` && method === "POST") {
          const readback = (body as { batchRequests: Array<{ method: string }> }).batchRequests.every((entry) => entry.method === "GET");
          if (readback) {
            if (gone) return ok({ results: [{ statusCode: 404 }] });
            const marker = (posted[0] as Record<string, string>).Subject;
            return ok({ results: [{ statusCode: 200, result: { Id: CASE_ID, Subject: marker } }] });
          }
          return ok({ results: [{ statusCode: 204 }, { statusCode: 404 }] });
        }
        return null;
      },
    ], []);
    const run = () => invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__DeleteDraft"),
      plan: { kind: "delete_probe_via_auth", idInputs: ["caseId"] },
      integrationUserId: SELF, request, build,
    });
    const survived = await run();
    expect(survived.status).toBe(200);
    expect(survived.contextSchema).toMatchObject({ verified: true });
    expect(survived.contextSchema).not.toHaveProperty("absenceNotes");
    posted.length = 0;
    gets = 0;
    gone = true;
    const deleted = await run();
    expect(deleted.status).toBe(200);
    expect(deleted.contextSchema).toMatchObject({ absenceNotes: [`Case:${CASE_ID}`] });
  });

  it("sweeps created rows by marker with template, picklist, and omission evidence", async () => {
    const NOW = Date.parse("2026-10-06T00:10:00.000Z");
    const CHILD_ID = "500000000000001AAA";
    const TEMPLATE_ID = "00X000000000000EAA";
    const sweep = {
      description: "Creates a case note for the case record.",
      inputs: [
        { name: "caseId", type: "STRING", required: false, maxOccurs: 1 },
        { name: "emailTemplateId", type: "STRING", required: false, maxOccurs: 1 },
        { name: "noteText", type: "TEXTAREA", required: false, maxOccurs: 1 },
        { name: "priority", type: "STRING", required: false, maxOccurs: 1 },
        { name: "discountCode", type: "STRING", required: false, maxOccurs: 1 },
      ],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const sweepCase = {
      name: "Case", createable: true, queryable: true, deletable: true,
      fields: [
        { name: "Subject", type: "string", createable: true, filterable: true, length: 255, nameField: true },
        { name: "CreatedDate", type: "datetime", createable: false },
        { name: "Priority", type: "picklist", createable: false,
          picklistValues: [{ value: "High", active: true }, { value: "Low", active: true }] },
      ],
    };
    const templateDescribe = { name: "EmailTemplate", queryable: true, fields: [{ name: "Id", type: "id" }] };
    const posted: unknown[] = [];
    const invoked: unknown[] = [];
    let marker = "";
    let sweptDeleted = false;
    const request = transport([
      (path, method) => path === ROUTE("t__CreateCaseNote") && method === "GET" ? ok(sweep) : null,
      (path) => {
        if (!path.includes("/query?")) return null;
        const query = decodeURIComponent(path);
        if (query.includes("FROM EmailTemplate LIMIT")) return records([{ Id: TEMPLATE_ID }]);
        if (query.includes("FROM Case WHERE CreatedDate")) return records([{ Id: CHILD_ID }]);
        if (query.includes("LIKE")) return records([]);
        if (query.includes("EmailTemplate")) return records([{ QualifiedApiName: "Case" }, { QualifiedApiName: "EmailTemplate" }]);
        if (query.includes("QualifiedApiName")) return records([{ QualifiedApiName: "Case" }]);
        return null;
      },
      (path) => path.endsWith("/sobjects/Case/describe") ? ok(sweepCase) : null,
      (path) => path.endsWith("/sobjects/EmailTemplate/describe") ? ok(templateDescribe) : null,
      (path, method, body) => {
        if (path === `${ROOT}/sobjects/Case` && method === "POST") {
          posted.push(body);
          marker = (body as Record<string, string>).Subject;
          return { status: 201, ok: true, body: { id: CASE_ID } };
        }
        return null;
      },
      (path, method) => {
        if (path === `${ROOT}/sobjects/Case/${CASE_ID}` && method === "GET") {
          return ok({ Id: CASE_ID, Subject: (posted[0] as Record<string, string>).Subject });
        }
        if (path === `${ROOT}/sobjects/Case/${CHILD_ID}` && method === "GET") {
          return sweptDeleted
            ? { status: 404, ok: false, body: null }
            : ok({ Id: CHILD_ID, CreatedDate: new Date(NOW).toISOString(), Subject: marker });
        }
        if (path === `${ROOT}/sobjects/Case/${CHILD_ID}` && method === "DELETE") {
          sweptDeleted = true;
          return { status: 204, ok: true, body: null };
        }
        return null;
      },
      (path, method, body) => {
        if (path === ROUTE("t__CreateCaseNote") && method === "POST") {
          invoked.push(body);
          return ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }]);
        }
        return null;
      },
      (path, method, body) => {
        if (path === `${ROOT}/composite/batch` && method === "POST") {
          const readback = (body as { batchRequests: Array<{ method: string }> }).batchRequests.every((entry) => entry.method === "GET");
          if (readback) {
            const mark = (posted[0] as Record<string, string>).Subject;
            return ok({ results: [{ statusCode: 200, result: { Id: CASE_ID, Subject: mark } }] });
          }
          return ok({ results: [{ statusCode: 204 }, { statusCode: 404 }] });
        }
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__CreateCaseNote"),
      plan: { kind: "creation_sweep_via_auth", idInputs: ["caseId", "emailTemplateId"] },
      integrationUserId: SELF, request, build, now: () => NOW,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.cleanupError).toBeUndefined();
    expect(outcome.contextSchema).toMatchObject({
      verified: true,
      mappings: [{ inputName: "caseId", objectName: "Case" }],
      createdChildren: [{ objectName: "Case", id: CHILD_ID }],
      sweepTargets: ["Case"],
      omittedInputs: ["discountCode"],
    });
    const args = (invoked[0] as { inputs: Array<Record<string, unknown>> }).inputs[0];
    expect(Object.keys(args).sort()).toEqual(["caseId", "emailTemplateId", "noteText", "priority"]);
    expect(args.caseId).toBe(CASE_ID);
    expect(args.emailTemplateId).toBe(TEMPLATE_ID);
    expect(args.noteText).toBe(outcome.contextSchema?.marker);
    expect(args.priority).toBe("High");
  });

  it("refuses sweeps with neither marker propagation nor parent linkage", async () => {
    const sweep = {
      description: "Creates a case note for the case record.",
      inputs: [{ name: "caseId", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const bareCase = {
      name: "Case", createable: true, queryable: true, deletable: true,
      fields: [
        // Auto-number name field: present and string-typed but never marker-writable.
        { name: "Subject", type: "string", createable: false, filterable: true, length: 255, nameField: true },
        { name: "CreatedDate", type: "datetime", createable: false },
      ],
    };
    const backed: string[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__CreateCaseNote") && method === "GET" ? ok(sweep) : null,
      (path) => {
        if (!path.includes("/query?")) return null;
        const query = decodeURIComponent(path);
        if (query.includes("LIKE")) return records([]);
        if (query.includes("QualifiedApiName")) return records([{ QualifiedApiName: "Case" }]);
        return null;
      },
      (path) => path.endsWith("/sobjects/Case/describe") ? ok(bareCase) : null,
      (path, method) => {
        if (path.includes("/sobjects/") && method === "POST") backed.push(path);
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__CreateCaseNote"),
      plan: { kind: "creation_sweep_via_auth", idInputs: ["caseId"] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.body).toMatchObject({ errorCode: "FLOW_CREATED_CHILD_UNTRACKED" });
    expect(String(outcome.body.message)).toContain("neither marker propagation nor parent linkage");
    expect(backed).toEqual([]);
  });

  it("tracks creation through mirror record outputs and explains fixture echoes", async () => {
    const NOW = Date.parse("2026-10-06T00:10:00.000Z");
    const NEW_ID = "500000000000009AAA";
    const mirror = {
      description: "Creates a case record from the supplied details.",
      inputs: [{ name: "caseRecord", type: "SOBJECT", required: false, maxOccurs: 1, sObjectType: "Case" }],
      outputs: [
        { name: "caseRecord", type: "SOBJECT" },
        { name: "Flow__InterviewStatus", type: "PICKLIST" },
      ],
    };
    const posted: unknown[] = [];
    const deleted: string[] = [];
    let echoFixture = false;
    const request = transport([
      (path, method) => path === ROUTE("t__CreateCaseMirror") && method === "GET" ? ok(mirror) : null,
      (path) => path.includes("QualifiedApiName") && !path.includes("KeyPrefix") ? records([{ QualifiedApiName: "Case" }]) : null,
      (path) => path.endsWith("/sobjects/Case/describe") ? ok(CASE_DESCRIBE) : null,
      (path, method, body) => {
        if (path === `${ROOT}/sobjects/Case` && method === "POST") {
          posted.push(body);
          return { status: 201, ok: true, body: { id: CASE_ID } };
        }
        return null;
      },
      (path, method) => {
        if (path === `${ROOT}/sobjects/Case/${CASE_ID}` && method === "GET") {
          return ok({ Id: CASE_ID, Subject: (posted[0] as Record<string, string>).Subject });
        }
        if (path === `${ROOT}/sobjects/Case/${NEW_ID}` && method === "GET") {
          return deleted.length
            ? { status: 404, ok: false, body: null }
            : ok({ Id: NEW_ID, CreatedDate: new Date(NOW - 60_000).toISOString() });
        }
        if (path === `${ROOT}/sobjects/Case/${NEW_ID}` && method === "DELETE") {
          deleted.push(path);
          return { status: 204, ok: true, body: null };
        }
        return null;
      },
      (path, method) => {
        if (path === ROUTE("t__CreateCaseMirror") && method === "POST") {
          const id = echoFixture ? CASE_ID : NEW_ID;
          return ok([{ isSuccess: true, errors: [], outputValues: {
            Flow__InterviewStatus: "Finished",
            caseRecord: { Id: id, attributes: { type: "Case" } },
          } }]);
        }
        return null;
      },
      (path, method, body) => {
        if (path === `${ROOT}/composite/batch` && method === "POST") {
          const readback = (body as { batchRequests: Array<{ method: string }> }).batchRequests.every((entry) => entry.method === "GET");
          if (readback) {
            const marker = (posted[0] as Record<string, string>).Subject;
            return ok({ results: [{ statusCode: 200, result: { Id: CASE_ID, Subject: marker } }] });
          }
          return ok({ results: [{ statusCode: 204 }, { statusCode: 404 }] });
        }
        return null;
      },
    ], []);
    const run = () => invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__CreateCaseMirror"),
      plan: { kind: "owned_id_probe_via_auth", recordInputs: [{ inputName: "caseRecord", objectName: "Case" }] },
      integrationUserId: SELF, request, build, now: () => NOW,
    });
    const created = await run();
    expect(created.status).toBe(200);
    expect(created.contextSchema).toMatchObject({
      verified: true, createdChildren: [{ objectName: "Case", id: NEW_ID }],
    });
    expect(deleted).toEqual([`${ROOT}/sobjects/Case/${NEW_ID}`]);
    posted.length = 0;
    deleted.length = 0;
    echoFixture = true;
    const echoed = await run();
    expect(echoed.status).toBe(200);
    expect(echoed.contextSchema).toMatchObject({ verified: true, createdChildren: [] });
    expect(deleted).toEqual([]);
  });

  it("sweeps anchorless creations by marker despite fulfillment vocabulary", async () => {
    const NOW = Date.parse("2026-10-06T00:10:00.000Z");
    const SHIP_ID = "0H0000000000001EAA";
    const sweep = {
      description: "Creates a shipment record for the recurrence schedule.",
      inputs: [
        { name: "caseSubject", type: "STRING", required: false, maxOccurs: 1 },
        { name: "deliveryNote", type: "TEXTAREA", required: false, maxOccurs: 1 },
        { name: "quantity", type: "DOUBLE", required: false, maxOccurs: 1 },
      ],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const shipDescribe = {
      name: "Shipment", createable: true, queryable: true, deletable: true,
      fields: [
        { name: "ShipmentName", type: "string", createable: true, filterable: true, length: 80, nameField: true },
        { name: "CreatedDate", type: "datetime", createable: false },
      ],
    };
    const invoked: unknown[] = [];
    const deleted: string[] = [];
    let sweptDeleted = false;
    const request = transport([
      (path, method) => path === ROUTE("t__CreateShipment") && method === "GET" ? ok(sweep) : null,
      (path) => {
        if (!path.includes("/query?")) return null;
        const query = decodeURIComponent(path);
        if (query.includes("FROM Shipment WHERE CreatedDate")) return records([{ Id: SHIP_ID }]);
        if (query.includes("LIKE")) return records([]);
        if (query.includes("QualifiedApiName")) return records([{ QualifiedApiName: "Shipment" }]);
        return null;
      },
      (path) => path.endsWith("/sobjects/Shipment/describe") ? ok(shipDescribe) : null,
      (path, method, body) => {
        if (path === ROUTE("t__CreateShipment") && method === "POST") {
          invoked.push(body);
          return ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }]);
        }
        return null;
      },
      (path, method) => {
        if (path === `${ROOT}/sobjects/Shipment/${SHIP_ID}` && method === "GET") {
          if (sweptDeleted) return { status: 404, ok: false, body: null };
          const args = (invoked[0] as { inputs: Array<Record<string, unknown>> }).inputs[0];
          return ok({ Id: SHIP_ID, ShipmentName: args.caseSubject, CreatedDate: new Date(NOW - 30_000).toISOString() });
        }
        if (path === `${ROOT}/sobjects/Shipment/${SHIP_ID}` && method === "DELETE") {
          sweptDeleted = true;
          deleted.push(path);
          return { status: 204, ok: true, body: null };
        }
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__CreateShipment"),
      plan: { kind: "creation_sweep_via_auth", idInputs: [], recordInputs: [] },
      integrationUserId: SELF, request, build, now: () => NOW,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.cleanupError).toBeUndefined();
    expect(outcome.contextSchema).toMatchObject({
      verified: true,
      createdChildren: [{ objectName: "Shipment", id: SHIP_ID }],
      sweepTargets: ["Shipment"],
      omittedInputs: ["quantity"],
    });
    const args = (invoked[0] as { inputs: Array<Record<string, unknown>> }).inputs[0];
    expect(args.caseSubject).toBe(outcome.contextSchema?.marker);
    expect(args.deliveryNote).toBe(outcome.contextSchema?.marker);
    expect(deleted).toEqual([`${ROOT}/sobjects/Shipment/${SHIP_ID}`]);
  });

  it("refuses anchorless sweeps with no marker path before any write", async () => {
    const sweep = {
      description: "Creates a shipment record for the recurrence schedule.",
      inputs: [{ name: "quantity", type: "DOUBLE", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const shipDescribe = {
      name: "Shipment", createable: true, queryable: true, deletable: true,
      fields: [
        { name: "ShipmentName", type: "string", createable: true, filterable: true, length: 80, nameField: true },
        { name: "CreatedDate", type: "datetime", createable: false },
      ],
    };
    const backed: string[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__CreateShipment") && method === "GET" ? ok(sweep) : null,
      (path) => {
        if (!path.includes("/query?")) return null;
        const query = decodeURIComponent(path);
        if (query.includes("LIKE")) return records([]);
        if (query.includes("QualifiedApiName")) return records([{ QualifiedApiName: "Shipment" }]);
        return null;
      },
      (path) => path.endsWith("/sobjects/Shipment/describe") ? ok(shipDescribe) : null,
      (path, method) => {
        if (path.includes("/sobjects/") && method === "POST") backed.push(path);
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__CreateShipment"),
      plan: { kind: "creation_sweep_via_auth", idInputs: [], recordInputs: [] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.body).toMatchObject({ errorCode: "FLOW_CREATED_CHILD_UNTRACKED" });
    expect(backed).toEqual([]);
  });

  it("reads anchorless with synthetic external identities and no fixtures", async () => {
    const read = {
      description: "Retrieves catalog variable metadata for a given catalog item.",
      inputs: [{ name: "itemSysId", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [
        { name: "catalogAttributesJson", type: "STRING" },
        { name: "Flow__InterviewStatus", type: "PICKLIST" },
      ],
    };
    const invoked: unknown[] = [];
    const backed: string[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__GetCtlgVarData") && method === "GET" ? ok(read) : null,
      (path, method, body) => {
        if (path === ROUTE("t__GetCtlgVarData") && method === "POST") {
          invoked.push(body);
          return ok([{ isSuccess: true, errors: [], outputValues: {
            Flow__InterviewStatus: "Finished", catalogAttributesJson: "{}",
          } }]);
        }
        if (path.includes("/sobjects/") && method === "POST") backed.push(path);
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__GetCtlgVarData"),
      plan: { kind: "read_probe_via_auth", idInputs: ["itemSysId"], recordInputs: [], generative: false },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.contextSchema).toMatchObject({ verified: true });
    expect(backed).toEqual([]);
    const args = (invoked[0] as { inputs: Array<Record<string, unknown>> }).inputs[0];
    expect(String(args.itemSysId)).toMatch(/^probe-nonexistent-/);
  });

  it("binds external identities synthetic and self users to the integration user", async () => {
    const probe = {
      description: "Closes the entitlement process for the case.",
      inputs: [
        { name: "custodyItemExternalID", type: "STRING", required: false, maxOccurs: 1,
          description: "Stores the ID of the external identifier." },
        { name: "userId", type: "STRING", required: false, maxOccurs: 1 },
        { name: "custodianID", type: "STRING", required: false, maxOccurs: 1,
          description: "Stores the ID of the custodian." },
        { name: "custodyItemSubjectID", type: "STRING", required: false, maxOccurs: 1 },
        { name: "varCaseId", type: "STRING", required: false, maxOccurs: 1 },
      ],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const posted: unknown[] = [];
    const invoked: unknown[] = [];
    const calls: string[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__Close") && method === "GET" ? ok(probe) : null,
      (path) => path.includes("QualifiedApiName") ? records([{ QualifiedApiName: "Case" }]) : null,
      (path) => path.endsWith("/sobjects/Case/describe") ? ok(CASE_DESCRIBE) : null,
      (path, method, body) => {
        if (path === `${ROOT}/sobjects/Case` && method === "POST") {
          posted.push(body);
          return { status: 201, ok: true, body: { id: CASE_ID } };
        }
        return null;
      },
      (path, method) => {
        if (path === `${ROOT}/sobjects/Case/${CASE_ID}` && method === "GET") {
          return ok({ Id: CASE_ID, Subject: (posted[0] as Record<string, string>).Subject });
        }
        return null;
      },
      (path, method, body) => {
        if (path === ROUTE("t__Close") && method === "POST") {
          invoked.push(body);
          return ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }]);
        }
        return null;
      },
      (path, method, body) => {
        if (path === `${ROOT}/composite/batch` && method === "POST") {
          const readback = (body as { batchRequests: Array<{ method: string }> }).batchRequests.every((entry) => entry.method === "GET");
          if (readback) {
            const marker = (posted[0] as Record<string, string>).Subject;
            return ok({ results: [{ statusCode: 200, result: { Id: CASE_ID, Subject: marker } }] });
          }
          return ok({ results: [{ statusCode: 204 }, { statusCode: 404 }] });
        }
        return null;
      },
    ], calls);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__Close"),
      plan: { kind: "owned_id_probe_via_auth",
        idInputs: ["custodyItemExternalID", "userId", "custodianID", "custodyItemSubjectID", "varCaseId"] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.contextSchema).toMatchObject({ verified: true });
    const args = (invoked[0] as { inputs: Array<Record<string, unknown>> }).inputs[0];
    expect(String(args.custodyItemExternalID)).toMatch(/^probe-nonexistent-/);
    expect(args.userId).toBe(SELF);
    expect(args.custodianID).toBe(SELF);
    expect(args.custodyItemSubjectID).toBe(SELF);
    expect(args.varCaseId).toBe(CASE_ID);
    expect(calls.some((call) => call.includes("/sobjects/User"))).toBe(false);
  });

  it("tracks JSON-embedded created identities and skips stale echoes silently", async () => {
    const NOW = Date.parse("2026-10-06T00:10:00.000Z");
    const FRESH_ID = "0H0000000000002EAA";
    const STALE_ID = "0H0000000000003EAA";
    const create = {
      description: "Creates an incident record using the provided description.",
      inputs: [{ name: "shortDescription", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [
        { name: "createdId", type: "STRING" },
        { name: "IncidentCreationJson", type: "STRING" },
        { name: "Flow__InterviewStatus", type: "PICKLIST" },
      ],
    };
    const incidentDescribe = {
      name: "Incident", createable: true, queryable: true, deletable: true,
      fields: [{ name: "CreatedDate", type: "datetime", createable: false }],
    };
    const deleted: string[] = [];
    let stale = false;
    const request = transport([
      (path, method) => path === ROUTE("t__CreateIncident") && method === "GET" ? ok(create) : null,
      (path) => {
        if (!path.includes("/query?")) return null;
        const query = decodeURIComponent(path);
        if (query.includes("KeyPrefix")) return records([{ QualifiedApiName: "Incident" }]);
        return records([]);
      },
      (path) => path.endsWith("/sobjects/Incident/describe") ? ok(incidentDescribe) : null,
      (path, method) => {
        if (path === ROUTE("t__CreateIncident") && method === "POST") {
          const id = stale ? STALE_ID : FRESH_ID;
          return ok([{ isSuccess: true, errors: [], outputValues: {
            Flow__InterviewStatus: "Finished",
            createdId: null,
            IncidentCreationJson: JSON.stringify({ incidentId: id, status: "created" }),
          } }]);
        }
        if (path === `${ROOT}/sobjects/Incident/${FRESH_ID}` && method === "GET") {
          return deleted.length
            ? { status: 404, ok: false, body: null }
            : ok({ Id: FRESH_ID, CreatedDate: new Date(NOW - 30_000).toISOString() });
        }
        if (path === `${ROOT}/sobjects/Incident/${FRESH_ID}` && method === "DELETE") {
          deleted.push(path);
          return { status: 204, ok: true, body: null };
        }
        if (path === `${ROOT}/sobjects/Incident/${STALE_ID}` && method === "GET") {
          return ok({ Id: STALE_ID, CreatedDate: "2026-09-01T00:00:00.000Z" });
        }
        return null;
      },
    ], []);
    const run = () => invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__CreateIncident"),
      plan: { kind: "scalar_create_via_auth", cleanupOutputs: ["createdId"] },
      integrationUserId: SELF, request, build, now: () => NOW,
    });
    const tracked = await run();
    expect(tracked.status).toBe(200);
    expect(tracked.cleanupError).toBeUndefined();
    expect(tracked.contextSchema).toMatchObject({
      verified: true, createdChildren: [{ objectName: "Incident", id: FRESH_ID }],
    });
    expect(deleted).toEqual([`${ROOT}/sobjects/Incident/${FRESH_ID}`]);
    stale = true;
    deleted.length = 0;
    const skipped = await run();
    expect(skipped.status).toBe(200);
    expect(skipped.contextSchema).toMatchObject({ verified: false, createdChildren: [] });
    expect(String(skipped.cleanupError)).toContain("may exist untracked");
    expect(deleted).toEqual([]);
  });

  it("tracks collection id outputs through every element", async () => {
    const NOW = Date.parse("2026-10-06T00:10:00.000Z");
    const FIRST_ID = "003000000000001AAA";
    const SECOND_ID = "003000000000002AAA";
    const create = {
      description: "Creates contact records for the guest household.",
      inputs: [{ name: "lastName", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [
        { name: "contactIds", type: "STRING", maxOccurs: 2000 },
        { name: "Flow__InterviewStatus", type: "PICKLIST" },
      ],
    };
    const deleted: string[] = [];
    const gone = new Set<string>();
    const request = transport([
      (path, method) => path === ROUTE("t__CreateContacts") && method === "GET" ? ok(create) : null,
      (path) => {
        if (!path.includes("/query?")) return null;
        const query = decodeURIComponent(path);
        if (query.includes("KeyPrefix")) return records([{ QualifiedApiName: "Contact" }]);
        return records([]);
      },
      (path) => path.endsWith("/sobjects/Contact/describe") ? ok(CONTACT_DESCRIBE) : null,
      (path, method) => {
        if (path === ROUTE("t__CreateContacts") && method === "POST") {
          return ok([{ isSuccess: true, errors: [], outputValues: {
            Flow__InterviewStatus: "Finished", contactIds: [FIRST_ID, SECOND_ID],
          } }]);
        }
        for (const id of [FIRST_ID, SECOND_ID]) {
          if (path === `${ROOT}/sobjects/Contact/${id}` && method === "GET") {
            return gone.has(id)
              ? { status: 404, ok: false, body: null }
              : ok({ Id: id, CreatedDate: new Date(NOW - 30_000).toISOString() });
          }
          if (path === `${ROOT}/sobjects/Contact/${id}` && method === "DELETE") {
            gone.add(id);
            deleted.push(path);
            return { status: 204, ok: true, body: null };
          }
        }
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__CreateContacts"),
      plan: { kind: "scalar_create_via_auth", cleanupOutputs: ["contactIds"] },
      integrationUserId: SELF, request, build, now: () => NOW,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.contextSchema).toMatchObject({
      verified: true,
      createdChildren: [{ objectName: "Contact", id: FIRST_ID }, { objectName: "Contact", id: SECOND_ID }],
    });
    expect(deleted).toEqual([
      `${ROOT}/sobjects/Contact/${FIRST_ID}`,
      `${ROOT}/sobjects/Contact/${SECOND_ID}`,
    ]);
  });

  it("reads past collaboration nouns but still refuses directed sends", async () => {
    const read = {
      description: "Calls a flow that completes initial validations to determine which collaboration tool type to use.",
      inputs: [{ name: "recordId", type: "STRING", required: false, maxOccurs: 1,
        description: "The ID of the record that you want to swarm on. The Slack channel name derives from it." }],
      outputs: [
        { name: "isSuccess", type: "BOOLEAN" },
        { name: "Flow__InterviewStatus", type: "PICKLIST" },
      ],
    };
    const posted: unknown[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__CheckPreconditions") && method === "GET" ? ok(read) : null,
      (path) => path.includes("QualifiedApiName") ? records([{ QualifiedApiName: "Case" }]) : null,
      (path) => path.endsWith("/sobjects/Case/describe") ? ok(CASE_DESCRIBE) : null,
      (path, method, body) => {
        if (path === `${ROOT}/sobjects/Case` && method === "POST") {
          posted.push(body);
          return { status: 201, ok: true, body: { id: CASE_ID } };
        }
        return null;
      },
      (path, method) => {
        if (path === `${ROOT}/sobjects/Case/${CASE_ID}` && method === "GET") {
          return ok({ Id: CASE_ID, Subject: (posted[0] as Record<string, string>).Subject });
        }
        return null;
      },
      (path, method) => path === ROUTE("t__CheckPreconditions") && method === "POST"
        ? ok([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished", isSuccess: true } }])
        : null,
      (path, method, body) => {
        if (path === `${ROOT}/composite/batch` && method === "POST") {
          const readback = (body as { batchRequests: Array<{ method: string }> }).batchRequests.every((entry) => entry.method === "GET");
          if (readback) {
            const marker = (posted[0] as Record<string, string>).Subject;
            return ok({ results: [{ statusCode: 200, result: { Id: CASE_ID, Subject: marker } }] });
          }
          return ok({ results: [{ statusCode: 204 }, { statusCode: 404 }] });
        }
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__CheckPreconditions"),
      plan: { kind: "read_probe_via_auth", idInputs: ["recordId"], recordInputs: [],
        generative: false, allowBareRecordFallback: true },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.contextSchema).toMatchObject({ verified: true });

    const send = {
      description: "Delivers the summary to the recipient via the Slack channel.",
      inputs: [{ name: "recordId", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const sendCalls: string[] = [];
    const sendRequest = transport([
      (path) => path === ROUTE("t__DeliverSummary") ? ok(send) : null,
    ], sendCalls);
    const refused = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__DeliverSummary"),
      plan: { kind: "read_probe_via_auth", idInputs: ["recordId"], recordInputs: [],
        generative: false, allowBareRecordFallback: true },
      integrationUserId: SELF, request: sendRequest, build,
    });
    expect(refused.body).toMatchObject({ errorCode: "FLOW_FALLBACK_EXTERNAL_SUBSTRATE_UNSUPPORTED" });
    expect(sendCalls).toEqual([`GET ${ROUTE("t__DeliverSummary")}`]);

    const itsm = {
      description: "Retrieves the catalog item from ServiceNow for the supplied identifier.",
      inputs: [{ name: "itemSysId", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const itsmCalls: string[] = [];
    const itsmRequest = transport([
      (path) => path === ROUTE("t__GetCatalogItem") ? ok(itsm) : null,
    ], itsmCalls);
    const itsmRefused = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__GetCatalogItem"),
      plan: { kind: "read_probe_via_auth", idInputs: ["itemSysId"], recordInputs: [], generative: false },
      integrationUserId: SELF, request: itsmRequest, build,
    });
    expect(itsmRefused.body).toMatchObject({ errorCode: "FLOW_FALLBACK_EXTERNAL_SUBSTRATE_UNSUPPORTED" });
    expect(itsmCalls).toEqual([`GET ${ROUTE("t__GetCatalogItem")}`]);
  });

  it("still refuses external meetings and vendor systems on sweep plans", async () => {
    const meeting = {
      description: "Creates a meeting in Outlook with the specified subject and attendees.",
      inputs: [{ name: "subject", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const meetingCalls: string[] = [];
    const meetingRequest = transport([
      (path) => path === ROUTE("t__ScheduleMeeting") ? ok(meeting) : null,
    ], meetingCalls);
    const meetingOutcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__ScheduleMeeting"),
      plan: { kind: "creation_sweep_via_auth", idInputs: [], recordInputs: [] },
      integrationUserId: SELF, request: meetingRequest, build,
    });
    expect(meetingOutcome.body).toMatchObject({ errorCode: "FLOW_FALLBACK_EXTERNAL_SUBSTRATE_UNSUPPORTED" });
    expect(meetingCalls).toEqual([`GET ${ROUTE("t__ScheduleMeeting")}`]);

    const vendor = {
      description: "Calls the clearinghouse eligibility check and creates a case.",
      inputs: [{ name: "caseSubject", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const vendorCalls: string[] = [];
    const vendorRequest = transport([
      (path) => path === ROUTE("t__EligibilityCheck") ? ok(vendor) : null,
    ], vendorCalls);
    const vendorOutcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__EligibilityCheck"),
      plan: { kind: "creation_sweep_via_auth", idInputs: [], recordInputs: [] },
      integrationUserId: SELF, request: vendorRequest, build,
    });
    expect(vendorOutcome.body).toMatchObject({ errorCode: "FLOW_FALLBACK_EXTERNAL_SUBSTRATE_UNSUPPORTED" });
    expect(vendorCalls).toEqual([`GET ${ROUTE("t__EligibilityCheck")}`]);
  });

  it("names exact-evidence created objects the identity cannot delete", async () => {
    const sweep = {
      description: "Creates an incident record using the provided description.",
      inputs: [{ name: "shortDescription", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const incidentDescribe = {
      name: "Incident", createable: true, queryable: true, deletable: false,
      fields: [{ name: "CreatedDate", type: "datetime", createable: false }],
    };
    const backed: string[] = [];
    const request = transport([
      (path, method) => path === ROUTE("t__CreateIncident") && method === "GET" ? ok(sweep) : null,
      (path) => {
        if (!path.includes("/query?")) return null;
        const query = decodeURIComponent(path);
        if (query.includes("LIKE")) return records([]);
        if (query.includes("QualifiedApiName")) return records([{ QualifiedApiName: "Incident" }]);
        return null;
      },
      (path) => path.endsWith("/sobjects/Incident/describe") ? ok(incidentDescribe) : null,
      (path, method) => {
        if (path.includes("/sobjects/") && method === "POST") backed.push(path);
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__CreateIncident"),
      plan: { kind: "creation_sweep_via_auth", idInputs: [], recordInputs: [] },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.body).toMatchObject({ errorCode: "FLOW_CREATED_CHILD_UNTRACKED" });
    expect(String(outcome.body.message)).toContain("'Incident'");
    expect(String(outcome.body.message)).toContain("cannot be deleted");
    expect(backed).toEqual([]);
  });

  it("sweeps created children by parent linkage before deleting parents", async () => {
    const NOW = Date.parse("2026-10-06T00:10:00.000Z");
    const PARENT_ID = "810000000000001AAA";
    const LINE_ID = "811000000000001AAA";
    const create = {
      description: "Creates return orders with return order line items for the request.",
      inputs: [{ name: "varCaseId", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [
        { name: "createdReturnOrderId", type: "STRING" },
        { name: "Flow__InterviewStatus", type: "PICKLIST" },
      ],
    };
    const orderDescribe = {
      name: "ReturnOrder", createable: true, queryable: true, deletable: true,
      fields: [{ name: "CreatedDate", type: "datetime", createable: false }],
    };
    const lineDescribe = {
      name: "ReturnOrderLineItem", createable: true, queryable: true, deletable: true,
      fields: [
        { name: "ReturnOrderId", type: "reference", createable: true, referenceTo: ["ReturnOrder"] },
        { name: "CreatedDate", type: "datetime", createable: false },
      ],
    };
    const posted: unknown[] = [];
    const deleted: string[] = [];
    const gone = new Set<string>();
    const request = transport([
      (path, method) => path === ROUTE("t__PostAssetReturns") && method === "GET" ? ok(create) : null,
      (path) => {
        if (!path.includes("/query?")) return null;
        const query = decodeURIComponent(path);
        if (query.includes("FROM ReturnOrderLineItem WHERE CreatedDate")) return records([{ Id: LINE_ID }]);
        if (query.includes("KeyPrefix")) return records([{ QualifiedApiName: "ReturnOrder" }]);
        if (query.includes("ReturnOrderLineItem")) {
          // The exact IN list also names the input stem, which the live
          // catalog resolves alongside the description joins.
          return records([{ QualifiedApiName: "ReturnOrder" }, { QualifiedApiName: "ReturnOrderLineItem" },
            ...(query.includes("'Case'") ? [{ QualifiedApiName: "Case" }] : [])]);
        }
        if (query.includes("QualifiedApiName")) return records([{ QualifiedApiName: "Case" }]);
        return null;
      },
      (path) => path.endsWith("/sobjects/Case/describe") ? ok(CASE_DESCRIBE) : null,
      (path) => path.endsWith("/sobjects/ReturnOrder/describe") ? ok(orderDescribe) : null,
      (path) => path.endsWith("/sobjects/ReturnOrderLineItem/describe") ? ok(lineDescribe) : null,
      (path, method, body) => {
        if (path === `${ROOT}/sobjects/Case` && method === "POST") {
          posted.push(body);
          return { status: 201, ok: true, body: { id: CASE_ID } };
        }
        return null;
      },
      (path, method) => {
        if (path === `${ROOT}/sobjects/Case/${CASE_ID}` && method === "GET") {
          return ok({ Id: CASE_ID, Subject: (posted[0] as Record<string, string>).Subject });
        }
        if (path === `${ROOT}/sobjects/ReturnOrder/${PARENT_ID}` && method === "GET") {
          return gone.has(PARENT_ID)
            ? { status: 404, ok: false, body: null }
            : ok({ Id: PARENT_ID, CreatedDate: new Date(NOW - 30_000).toISOString() });
        }
        if (path === `${ROOT}/sobjects/ReturnOrder/${PARENT_ID}` && method === "DELETE") {
          gone.add(PARENT_ID);
          deleted.push(path);
          return { status: 204, ok: true, body: null };
        }
        if (path === `${ROOT}/sobjects/ReturnOrderLineItem/${LINE_ID}` && method === "GET") {
          return gone.has(LINE_ID)
            ? { status: 404, ok: false, body: null }
            : ok({ Id: LINE_ID, ReturnOrderId: PARENT_ID, CreatedDate: new Date(NOW - 30_000).toISOString() });
        }
        if (path === `${ROOT}/sobjects/ReturnOrderLineItem/${LINE_ID}` && method === "DELETE") {
          gone.add(LINE_ID);
          deleted.push(path);
          return { status: 204, ok: true, body: null };
        }
        return null;
      },
      (path, method) => path === ROUTE("t__PostAssetReturns") && method === "POST"
        ? ok([{ isSuccess: true, errors: [], outputValues: {
          Flow__InterviewStatus: "Finished", createdReturnOrderId: PARENT_ID,
        } }])
        : null,
      (path, method, body) => {
        if (path === `${ROOT}/composite/batch` && method === "POST") {
          const readback = (body as { batchRequests: Array<{ method: string }> }).batchRequests.every((entry) => entry.method === "GET");
          if (readback) {
            const marker = (posted[0] as Record<string, string>).Subject;
            return ok({ results: [{ statusCode: 200, result: { Id: CASE_ID, Subject: marker } }] });
          }
          return ok({ results: [{ statusCode: 204 }, { statusCode: 404 }] });
        }
        return null;
      },
    ], []);
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__PostAssetReturns"),
      plan: { kind: "owned_id_probe_via_auth", idInputs: ["varCaseId"] },
      integrationUserId: SELF, request, build, now: () => NOW,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.cleanupError).toBeUndefined();
    expect(outcome.contextSchema).toMatchObject({
      verified: true,
      createdChildren: [
        { objectName: "ReturnOrderLineItem", id: LINE_ID },
        { objectName: "ReturnOrder", id: PARENT_ID },
      ],
    });
    expect(deleted).toEqual([
      `${ROOT}/sobjects/ReturnOrderLineItem/${LINE_ID}`,
      `${ROOT}/sobjects/ReturnOrder/${PARENT_ID}`,
    ]);
  });
});

describe("identity and update helpers", () => {
  it("spots external identities, self users, fixture references, and update claims", () => {
    expect(isExternalIdentityShaped("custodyItemExternalID", "Stores the ID of the external identifier.")).toBe(true);
    expect(isExternalIdentityShaped("itemSysId", "Stores the SysId of the catalog item.")).toBe(true);
    expect(isExternalIdentityShaped("correlationId", null)).toBe(true);
    expect(isExternalIdentityShaped("requesterSystemId", "Stores the RequestedForSysId of the catalog item.")).toBe(true);
    expect(isExternalIdentityShaped("varExistingShipmentId", "ID of an existing Shipment record.")).toBe(false);
    expect(isExternalIdentityShaped("serviceRequestId", null)).toBe(false);
    expect(isExternalIdentityShaped("caseId", "The ID of the case.")).toBe(false);
    expect(inputDocumentsRecord("custodyItemExternalID", "Stores the ID of the external identifier.")).toBe(false);
    expect(isSelfUserShaped("owner", null)).toBe(true);
    expect(isSelfUserShaped("userId", null)).toBe(true);
    expect(isSelfUserShaped("recordOwner", "The Owner Id of the record.")).toBe(true);
    expect(isSelfUserShaped("custodianID", "Stores the ID of the custodian.")).toBe(true);
    expect(isSelfUserShaped("custodyItemSubjectID", "Stores the ID of the subject.")).toBe(true);
    expect(isSelfUserShaped("caseSubject", "Stores the subject of the case.")).toBe(false);
    expect(isSelfUserShaped("swarmMemberDescription", "Help needed in the Swarm.")).toBe(false);
    expect(isSelfUserShaped("labelForSwarmMemberName", null)).toBe(false);
    expect(isSelfUserShaped("isSuperuser", "Whether the user is privileged.")).toBe(false);
    expect(countsAsFixtureReference("emailTemplateId")).toBe(false);
    expect(countsAsFixtureReference("actionPlanTemplateSourceObjectId")).toBe(false);
    expect(countsAsFixtureReference("caseId")).toBe(true);
    expect(flowDeclaresUpdate("t__Update_Status", "Updates the record.")).toBe(true);
    expect(flowDeclaresUpdate("t__Set_Gantt_Label", null)).toBe(true);
    expect(flowDeclaresUpdate("t__Complete_Records", "Checks tools, and sets the Status for swarm records to Closed.")).toBe(true);
    expect(flowDeclaresUpdate("t__Finish", "Marks the request complete.")).toBe(true);
    expect(flowDeclaresUpdate("t__Get_Assets", "Gets the assets for the account.")).toBe(false);
    expect(flowDeclaresUpdate("t__Offset_Lines", "Offsets the asset schedule lines.")).toBe(false);
  });
});

describe("extractEmbeddedIds", () => {
  it("surfaces scalar, collection, record, and JSON-embedded identities", () => {
    const A = "500000000000001AAA";
    const B = "500000000000002AAA";
    expect(extractEmbeddedIds(A)).toEqual([A]);
    expect(extractEmbeddedIds([A, B])).toEqual([A, B]);
    expect(extractEmbeddedIds({ Id: A, attributes: { type: "Case" } })).toEqual([A]);
    expect(extractEmbeddedIds(JSON.stringify({ incidentId: A, nested: { items: [B] } }))).toEqual([A, B]);
    expect(extractEmbeddedIds("The flow finished")).toEqual([]);
    expect(extractEmbeddedIds(null)).toEqual([]);
    expect(extractEmbeddedIds({ note: "not-an-id", count: 3 })).toEqual([]);
  });
});

describe("orderCleanupTargets", () => {
  it("deletes referencing objects before the objects they reference", () => {
    const parent = { objectName: "ReturnOrder", references: ["Account"] };
    const child = { objectName: "ReturnOrderLineItem", references: ["ReturnOrder", "Product2"] };
    const lone = { objectName: "Shipment", references: [] };
    expect(orderCleanupTargets([parent, child, lone]).map((target) => target.objectName))
      .toEqual(["ReturnOrderLineItem", "ReturnOrder", "Shipment"]);
    expect(orderCleanupTargets([parent, lone]).map((target) => target.objectName)).toEqual(["ReturnOrder", "Shipment"]);
    const self = { objectName: "ServiceRequest", references: ["ServiceRequest"] };
    expect(orderCleanupTargets([self, lone]).map((target) => target.objectName)).toEqual(["ServiceRequest", "Shipment"]);
  });
});

describe("createdObjectCandidates", () => {
  it("prefers long joins with singular twins, then route tails", () => {
    const hints = createdObjectCandidates(
      "Creates Return Order, Return Order Line Items (bulk), and optionally Shipment records.",
      ROUTE("t__PostAssetReturns"));
    expect(hints).toContain("ReturnOrderLineItem");
    expect(hints).toContain("ReturnOrder");
    expect(hints).toContain("Shipment");
    expect(hints.indexOf("ReturnOrderLineItem")).toBeLessThan(hints.indexOf("ReturnOrder"));
    const plan = createdObjectCandidates(
      "Creates an action plan for a service management operation based on an action plan template.",
      ROUTE("u__CreatActnPlanForSrvcMgntRec"));
    expect(plan).toContain("ActionPlan");
    expect(plan).toContain("ActionPlanTemplate");
  });
});

describe("repair consumer wiring", () => {
  const AGENT_FLOW = "RepairNs__AgentFlow";
  const AGENT_ROUTE = ROUTE(AGENT_FLOW);
  const AGENT_PRODUCER = `${ROOT}/actions/custom/flow/RepairNs__SendVerificationCode`;
  const agentDescriptor = (description: string) => ({
    description,
    inputs: [
      { name: "customerId", type: "STRING", required: false, maxOccurs: 1 },
      { name: "conversationId", type: "STRING", required: false, maxOccurs: 1 },
    ],
    outputs: [{ name: "outcome", type: "STRING" }],
  });
  const producerDescriptor = () => ({
    inputs: [{ name: "email", type: "STRING" }],
    outputs: [
      { name: "verificationCode" },
      { name: "authenticationKey" },
      { name: "customerId" },
      { name: "customerType" },
    ],
  });
  const contactDescribe = () => ({
    name: "Contact", createable: true, queryable: true, deletable: true,
    fields: [
      { name: "LastName", type: "string", createable: true },
      { name: "Email", type: "email", createable: true },
    ],
  });
  const agentFault = {
    status: 200, ok: true,
    body: [{
      isSuccess: true,
      outputValues: {
        Flow__InterviewStatus: "Finished",
        errorMessage: "The customer isn't verified. Identify your customer id and retry.",
      },
    }],
  };
  const build = async (_name: string, marker: string, values: Record<string, unknown>) =>
    ({ values: { ...values, LastName: marker } });

  it("repairs agent-context faults inline and converts", async () => {
    let marker = "";
    let readbacks = 0;
    const deletes: string[] = [];
    const request = async (path: string, method = "GET", body?: any) => {
      if (method === "DELETE") {
        deletes.push(path);
        return { status: 204, ok: true, body: null };
      }
      if (path === AGENT_ROUTE && method === "GET")
        return ok(agentDescriptor("Looks up the verified customer for the supplied reference."));
      if (path.includes("/query?")) {
        if (path.includes("FlowDefinitionView")) return records([{ ApiName: "RepairNs__SendVerificationCode" }]);
        return records([]);
      }
      if (path === AGENT_PRODUCER && method === "GET") return ok(producerDescriptor());
      if (path === `${ROOT}/sobjects/Contact/describe`) return ok(contactDescribe());
      if (path === `${ROOT}/sobjects/Contact` && method === "POST") return ok({ id: CONTACT_ID }, 201);
      if (path === `${ROOT}/sobjects/Contact/${CONTACT_ID}` && method === "GET") {
        readbacks++;
        return readbacks === 1
          ? ok({ Id: CONTACT_ID, LastName: marker, Email: "x@example.invalid" })
          : { status: 404, ok: false, body: [] };
      }
      if (path === AGENT_PRODUCER && method === "POST") {
        return ok([{
          isSuccess: true, errors: null,
          outputValues: [
            { name: "customerId", value: "CUST-1" },
            { name: "customerType", value: "Person" },
          ],
        }]);
      }
      if (path === AGENT_ROUTE && method === "POST") {
        const customerId = (body as { inputs: Array<Record<string, unknown>> })?.inputs?.[0]?.customerId;
        if (customerId === "CUST-1")
          return ok([{ isSuccess: true, errors: null, outputValues: { outcome: "verified" } }]);
        return agentFault;
      }
      throw new Error(`unstubbed ${method} ${path}`);
    };
    const trackingBuild = async (name: string, m: string, values: Record<string, unknown>) => {
      marker = m;
      return build(name, m, values);
    };
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: AGENT_ROUTE, plan: { kind: "scalar_create_via_auth" },
      integrationUserId: SELF, request, build: trackingBuild,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual([{ isSuccess: true, errors: null, outputValues: { outcome: "verified" } }]);
    expect(outcome.contextSchema).toMatchObject({
      verified: true,
      repairPlan: { strategy: "agent-customer-context", code: "FLOW_AGENT_CONTEXT_REQUIRED" },
      agentRepairAttempt: { converted: true, code: "FLOW_AGENT_CONTEXT_REQUIRED" },
    });
    expect(deletes).toEqual([`${ROOT}/sobjects/Contact/${CONTACT_ID}`]);
  });

  it("never inline-repairs creation-claimed agent faults", async () => {
    const calls: string[] = [];
    const request = async (path: string, method = "GET", body?: any) => {
      calls.push(`${method} ${path}`);
      if (path === AGENT_ROUTE && method === "GET")
        return ok(agentDescriptor("Saves the verified customer reference for the agent."));
      if (path === AGENT_ROUTE && method === "POST") return agentFault;
      if (path.includes("/tooling/query")) return records([]);
      throw new Error(`unstubbed ${method} ${path}`);
    };
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: AGENT_ROUTE, plan: { kind: "scalar_create_via_auth" },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.body).toMatchObject({ errorCode: "FLOW_OWNED_PROBE_EXECUTION_FAILED" });
    expect(outcome.body).toMatchObject({
      repairPlan: { strategy: "agent-customer-context", code: "FLOW_AGENT_CONTEXT_REQUIRED" },
    });
    expect(outcome.body.agentRepairAttempt).toBeUndefined();
    expect(outcome.contextSchema.agentRepairAttempt).toBeUndefined();
    expect(calls.some((call) => call.includes("FlowDefinitionView") || call.includes("/sobjects/Contact"))).toBe(false);
  });

  it("attaches await-setup repair plans to narrowed invocable faults", async () => {
    const calc = {
      description: "Looks up the account summary for the supplied identifier.",
      inputs: [{ name: "accountCode", type: "STRING", required: false, maxOccurs: 1 }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }],
    };
    const request = async (path: string, method = "GET") => {
      if (path === ROUTE("t__Calc") && method === "GET") return ok(calc);
      if (path === ROUTE("t__Calc") && method === "POST") {
        return {
          status: 400, ok: false,
          body: [{ message: "An error occurred when executing a flow interview.", errorCode: "UNKNOWN_EXCEPTION" }],
        };
      }
      if (path.includes("/tooling/query") && path.includes("FlowDefinition"))
        return records([{ DeveloperName: "t__Calc", NamespacePrefix: null, ActiveVersionId: "301000000000001AAA" }]);
      if (path.includes("/tooling/query") && path.includes("SELECT%20Metadata"))
        return records([{ Metadata: { actionCalls: [{ actionName: "MissingHelper", actionType: "apex" }] } }]);
      if (path === `${ROOT}/actions/custom/apex/MissingHelper`) return { status: 404, ok: false, body: [] };
      if (path.includes("ApexClass")) return records([]);
      if (path === `${ROOT}/actions/standard`) return ok({ actions: [] });
      throw new Error(`unstubbed ${method} ${path}`);
    };
    const outcome = await invokeOwnedSubstrate({
      root: ROOT, route: ROUTE("t__Calc"), plan: { kind: "scalar_create_via_auth" },
      integrationUserId: SELF, request, build,
    });
    expect(outcome.body).toMatchObject({
      managedFlowFault: { code: "FLOW_EXECUTION_INVOCABLE_MISSING" },
      repairPlan: { strategy: "await-setup", code: "FLOW_EXECUTION_INVOCABLE_MISSING" },
    });
    expect(outcome.contextSchema).toMatchObject({
      repairPlan: { strategy: "await-setup", code: "FLOW_EXECUTION_INVOCABLE_MISSING" },
    });
  });
});
