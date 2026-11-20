/** Flow live-sObject context: spec-driven native invoke for managed Flows whose
 * inputs demand a live platform sObject the live descriptor never types.
 *
 * Root cause: flows like `conv_copilot_ms__GetTscpMsgSes` declare an untyped
 * input (`objectToSummarize`) that must carry a live sObject
 * (`{attributes:{type},Id}`). The generic sampler mints a synthetic
 * attribute-less object (or an Id string) and the interview faults. Each spec
 * below names the live input + sObject type; the executor reads ONE live row,
 * verifies the descriptor declares the input, posts the native interview,
 * and verifies the Finished outcome. Read-only: no fixtures are created, so
 * no cleanup phase applies.
 *
 * Generic and org-agnostic: flow/action/object names are Salesforce platform
 * vocabulary, never org IDs, aliases, or URLs. No success is synthesized;
 * absent substrate (zero live rows) or an undeclared input returns an
 * explicit failure WITHOUT posting.
 */

export const FLOW_LIVE_SOBJECT_BUILDER_VERSION = 89;

export type FlowLiveSObjectSpec = {
  /** Live descriptor input name receiving the sObject (exact case). */
  input: string;
  /** Platform sObject type to read the live row from. */
  sobject: string;
  /** Optional child table proving the row carries the payload the flow reads
   *  (e.g. a session WITH conversation entries). The substrate query becomes
   *  `SELECT Id FROM <sobject> WHERE Id IN (SELECT <parentField> FROM <object>)`.
   *  When the join is empty but bare rows exist, the executor falls through
   *  to a bare live row instead of refusing: live-proven, a natively
   *  Finished interview does not require the child payload on every org.
   *  The 422 is kept only when zero rows exist at all. */
  children?: Array<{ object: string; parentField: string }>;
};

export const FLOW_LIVE_SOBJECT_SPECS: Record<string, FlowLiveSObjectSpec> = {
  conv_copilot_ms__GetTscpMsgSes: { input: "objectToSummarize", sobject: "MessagingSession",
    children: [{ object: "ConversationEntry", parentField: "ConversationId" }] },
};

export type LiveSObjectTransport = (path: string, method?: string, body?: unknown) =>
  Promise<{ status: number; ok: boolean; body: unknown }>;

export type LiveSObjectResult = {
  status: number;
  body: unknown;
  contextSchema: Record<string, unknown>;
};

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const failure = (status: number, errorCode: string, message: string, extra?: Record<string, unknown>): LiveSObjectResult => ({
  status,
  body: { errorCode, message, ...extra },
  contextSchema: {
    source: "salesforce_live_flow_sobject",
    lifecycle: "flow-live-sobject",
    automaticSteps: [
      "Verify the live descriptor declares the specified input",
      "Read one live platform row of the specified sObject type",
      "Invoke the native flow interview with the live sObject",
      "Verify the Finished interview outcome",
    ],
    verified: false,
  },
});

function interviewFinished(body: unknown): boolean {
  if (!Array.isArray(body) || body.length === 0) return false;
  return body.every((item) => {
    if (!record(item) || item.isSuccess !== true) return false;
    if (!(item.errors === null || item.errors === undefined ||
      (Array.isArray(item.errors) && item.errors.length === 0))) return false;
    const outputs = record(item.outputValues) ? item.outputValues : null;
    const status = outputs && typeof outputs.Flow__InterviewStatus === "string"
      ? outputs.Flow__InterviewStatus : null;
    return status === null || status === "Finished";
  });
}

export async function invokeFlowLiveSObject(input: {
  root: string;
  route: string;
  actionName: string;
  request: LiveSObjectTransport;
}): Promise<LiveSObjectResult> {
  const spec = FLOW_LIVE_SOBJECT_SPECS[input.actionName];
  if (!spec || !IDENTIFIER.test(spec.input) || !IDENTIFIER.test(spec.sobject)) {
    return failure(422, "FLOW_SOBJECT_SPEC_UNKNOWN",
      "No live-sObject specification exists for this flow; the native call was not attempted.");
  }
  if (!input.root.startsWith("/services/data/") || !input.route.startsWith(`${input.root}/actions/`)) {
    return failure(400, "FLOW_SOBJECT_ROUTE_INVALID", "A live flow route under the API root is required.");
  }
  const descriptor = await input.request(input.route, "GET");
  const inputs = descriptor.ok && record(descriptor.body) && Array.isArray(descriptor.body.inputs)
    ? descriptor.body.inputs.filter(record) : [];
  if (!inputs.some((field) => field.name === spec.input)) {
    return failure(422, "FLOW_SOBJECT_INPUT_UNDECLARED",
      `The live descriptor does not declare the ${spec.input} input; the native call was not attempted.`);
  }
  const children = Array.isArray(spec.children) ? spec.children.filter((c) =>
    c && IDENTIFIER.test(c.object) && IDENTIFIER.test(c.parentField)) : [];
  if (spec.children !== undefined && children.length !== spec.children.length) {
    return failure(422, "FLOW_SOBJECT_SPEC_UNKNOWN",
      "The live-sObject specification names an invalid child table; the native call was not attempted.");
  }
  const readRowId = async (soql: string): Promise<string | null> => {
    const found = await input.request(
      `${input.root}/query?q=${encodeURIComponent(soql)}`, "GET");
    const rows = found.ok && record(found.body) && Array.isArray(found.body.records)
      ? found.body.records.filter(record) : [];
    return rows.length > 0 && typeof rows[0].Id === "string" && SF_ID.test(rows[0].Id)
      ? rows[0].Id : null;
  };
  let substrate: "child-linked" | "bare-row" = "bare-row";
  let rowId: string | null = null;
  if (children.length) {
    rowId = await readRowId(`SELECT Id FROM ${spec.sobject} WHERE ${children.map((c) => `Id IN (SELECT ${c.parentField} FROM ${c.object})`).join(" AND ")} LIMIT 1`);
    if (rowId) substrate = "child-linked";
  }
  if (!rowId) rowId = await readRowId(`SELECT Id FROM ${spec.sobject} LIMIT 1`);
  if (!rowId) {
    return failure(422, "FLOW_SOBJECT_SUBSTRATE_ABSENT",
      `No live ${spec.sobject} rows were discovered; the native call was not attempted with an invented identity.`);
  }
  const invoked = await input.request(input.route, "POST",
    { inputs: [{ [spec.input]: { attributes: { type: spec.sobject }, Id: rowId } }] });
  if (!interviewFinished(invoked.body)) {
    return failure(422, "FLOW_SOBJECT_ACTION_REJECTED",
      "Salesforce ended the flow interview without a verifiable Finished effect.",
      { upstreamOutcome: invoked.body });
  }
  return {
    status: invoked.status,
    body: invoked.body,
    contextSchema: {
      source: "salesforce_live_flow_sobject",
      lifecycle: "flow-live-sobject",
      actionName: input.actionName,
      substrate,
      automaticSteps: [
        "Verify the live descriptor declares the specified input",
        "Read one live platform row of the specified sObject type",
        "Invoke the native flow interview with the live sObject",
        "Verify the Finished interview outcome",
      ],
      verified: true,
    },
  };
}
