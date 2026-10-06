/**
 * Verification-code consumer chain for metadata-hidden custom Flow actions.
 *
 * Root cause (blind-verified): consumers such as VerifyCode take the emailed
 * challenge code plus the producer's customerId/customerType/authenticationKey.
 * The producer masks its `verificationCode` output ("xxxxxx") and delivers the
 * real code out of band, so no static fixture can ever satisfy the consumer.
 * The chain must run the namespace producer against a disposable RECEIVABLE
 * inbox, read the delivered code back, and pass it to the consumer.
 *
 * The inbox is a short-lived disposable address (default: Guerrilla Mail API).
 * Codes live in memory only, are never logged or persisted, and the disposable
 * Contact plus any communication residue is swept and verified absent. Email
 * content is used exclusively to extract the numeric challenge code.
 *
 * Injection style mirrors `flow-fallback-contact-chain.ts`: the entrypoint
 * (owned by the parent) supplies `request` and `build`; this module owns the
 * lifecycle. Producer discovery, shapes, and values derive from live
 * descriptors; no org IDs, aliases, or tenant values here.
 */

import {
  PRODUCER_REQUIRED_OUTPUTS,
  verificationProducerInput,
} from "./flow-producer-context";
import {
  discoverContactChainProducer,
  flowOutputFailureSnippet,
  type ChainRequest,
  type ContactBuild,
  type ContactChainResult,
} from "./flow-fallback-contact-chain";
import {
  sweepFlowCommunicationResidue,
  type ResidueSweep,
} from "./flow-residue-sweep";

export const VERIFICATION_INBOX_API_BASE = "https://api.guerrillamail.com/ajax.php";
export const MAILSLURP_API_BASE = "https://api.mailslurp.com";

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const CONTACT_ID = /^003[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const ROUTE = /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/;
const ROUTE_VERB = /verif|confirm|valid/i;
const CODE_INPUT = /(?:verification|verify|auth|otp|one.?time|pass.?code|customer.?code|confirm|challenge).*(?:code|pin|token|key)?|(?:code|otp|pin)$/i;
const ID_INPUT = /(?:customer.?id|user.?id|contact.?id|person.?id|identity.?id|verified.?contact.?id)$/i;
const TYPE_INPUT = /(?:customer.?type|user.?type|contact.?type|id.?type|identity.?type)$/i;
const KEY_INPUT = /(?:authentication.?key|auth.?key|session.?key|challenge.?key|request.?id|correlation.?id)$/i;
const MESSAGE_OUTPUT = /(?:message|prompt|notice|result|summary)$/i;
const VERIFIED_OUTPUT = /^(?:is.?verified|verified|verification.?status|success)$/i;
const DELIVERY_CODE = /\b(\d{4,8})\b/;
const POLL_ATTEMPTS = 24;
const POLL_INTERVAL_MS = 5000;

type Field = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const fieldsOf = (value: unknown): Field[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

export type VerificationConsumerShape = {
  codeInput: string;
  idInput: string;
  typeInput?: string;
  keyInput?: string;
};

/**
 * Re-derive the verification-code consumer shape from the live consumer
 * descriptor. Requires 2-6 optional single STRING inputs including a
 * code-shaped input and an identity-shaped input, plus a verification or
 * message output. Anything else returns null (never guessed).
 */
export function verificationConsumerShape(descriptor: unknown, route: string): VerificationConsumerShape | null {
  if (!isRecord(descriptor)) return null;
  if (typeof route !== "string" || !ROUTE_VERB.test(route.split("/").at(-1) ?? "")) return null;
  const inputs = fieldsOf(descriptor.inputs);
  const outputs = fieldsOf(descriptor.outputs);
  if (!Array.isArray(descriptor.inputs) || !Array.isArray(descriptor.outputs)) return null;
  if (inputs.length < 2 || inputs.length > 6) return null;
  for (const field of inputs) {
    if (typeof field.name !== "string" || !FIELD_NAME.test(field.name)) return null;
    if (field.type !== "STRING" || field.required === true) return null;
    if (typeof field.maxOccurs === "number" && field.maxOccurs > 1) return null;
  }
  const byName = (re: RegExp): Field | undefined => inputs.find((f) => re.test(String(f.name)));
  const code = inputs.find((f) => CODE_INPUT.test(String(f.name)) && !KEY_INPUT.test(String(f.name)));
  const id = byName(ID_INPUT);
  if (!code || !id) return null;
  const verified = outputs.some((f) =>
    typeof f.name === "string" && VERIFIED_OUTPUT.test(f.name) && !f.name.toLowerCase().startsWith("flow__"));
  const message = outputs.some((f) =>
    typeof f.name === "string" && !f.name.toLowerCase().startsWith("flow__") &&
    MESSAGE_OUTPUT.test(f.name) && String(f.type ?? "STRING").toUpperCase() === "STRING");
  if (!verified && !message) return null;
  const shape: VerificationConsumerShape = { codeInput: code.name as string, idInput: id.name as string };
  const typeInput = byName(TYPE_INPUT);
  const keyInput = byName(KEY_INPUT);
  if (typeInput) shape.typeInput = typeInput.name as string;
  if (keyInput) shape.keyInput = keyInput.name as string;
  return shape;
}

export type DisposableInbox = {
  /** Mint a disposable receivable address; token authenticates follow-up reads. */
  address: () => Promise<{ email: string; token: string } | null>;
  /** Single-shot inbox check; returns the challenge code when delivered. */
  check: (token: string) => Promise<string | null>;
  /** Mails observed by the last check (diagnostic count only, never content). */
  lastMailCount?: () => number;
  /** Redacted first-mail fingerprint (sender domain + digit-masked subject). */
  lastMailFingerprint?: () => string | null;
  /** Best-effort inbox deletion after the chain completes. Absent when unsupported. */
  release?: (token: string) => Promise<void>;
  /** True when a healthy session always shows a seed mail from read #1 (Guerrilla welcome mail). */
  expectsSeedMail?: boolean;
};

/** Masks org-id-like tokens in sender domains before fingerprinting. */
const safeDomain = (from: string): string => {
  const domain = from.includes("@") ? from.slice(from.indexOf("@") + 1, from.indexOf("@") + 65) : "?";
  return domain.replace(/[A-Za-z0-9]{12,}/g, "[id]");
};

const firstCode = (text: string): string | null => {
  const match = DELIVERY_CODE.exec(text);
  if (match) return match[1];
  const spaced = /\b(\d(?: ?\d){3,7})\b/.exec(text);
  return spaced ? spaced[1].replace(/ /g, "") : null;
};

/** Default disposable inbox over the Guerrilla Mail API. Pure transport.
 * Persists session cookies across calls: inbox sessions bind to the cookie,
 * and worker egress IPs rotate between requests, so the token alone cannot
 * reliably restore the session. */
export function guerrillaInbox(baseUrl: string = VERIFICATION_INBOX_API_BASE): DisposableInbox {
  const jar = new Map<string, string>();
  let mailCount = 0;
  let fingerprint: string | null = null;
  const get = async (params: string): Promise<unknown> => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const response = await fetch(`${baseUrl}?${params}`, {
      signal: AbortSignal.timeout(15_000),
      ...(cookie ? { headers: { Cookie: cookie } } : {}),
    });
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const entry of raw) {
      const pair = entry.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    if (!response.ok) throw new Error(`inbox read failed (HTTP ${response.status})`);
    return response.json().catch(() => null);
  };
  return {
    address: async () => {
      const body = await get("f=get_email_address").catch(() => null);
      if (!isRecord(body) || typeof body.email_addr !== "string" || typeof body.sid_token !== "string") return null;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email_addr) || body.sid_token.length < 8) return null;
      return { email: body.email_addr, token: body.sid_token };
    },
    check: async (token: string) => {
      const body = await get(`f=check_email&sid_token=${encodeURIComponent(token)}&seq=0`);
      if (!isRecord(body) || !Array.isArray(body.list)) return null;
      mailCount = body.list.length;
      const first = body.list.filter(isRecord)[0];
      if (first) {
        fingerprint = `${safeDomain(String(first.mail_from ?? ""))} | ${String(first.mail_subject ?? "").replace(/\d/g, "#").slice(0, 80)}`;
      }
      for (const entry of body.list.filter(isRecord)) {
        const header = `${String(entry.mail_subject ?? "")}\n${String(entry.mail_excerpt ?? "")}`;
        const headerCode = firstCode(header);
        if (headerCode) return headerCode;
        // Always read the body: excerpts truncate before the code and the
        // read flag shape varies, so the header alone cannot be trusted.
        if (typeof entry.mail_id === "string" || typeof entry.mail_id === "number") {
          const full = await get(`f=fetch_email&sid_token=${encodeURIComponent(token)}&email_id=${entry.mail_id}`).catch(() => null);
          if (!isRecord(full)) continue;
          const code = firstCode(`${String(full.mail_subject ?? "")}\n${String(full.mail_body ?? "")}`);
          if (code) return code;
        }
      }
      return null;
    },
    lastMailCount: () => mailCount,
    lastMailFingerprint: () => fingerprint,
    expectsSeedMail: true,
  };
}

/**
 * Disposable inbox over the MailSlurp API (receive-only plans supported).
 * Token is the inbox id. MailSlurp inboxes persist until deleted, so the
 * chain releases them via `release` after every run.
 */
export function mailslurpInbox(apiKey: string, baseUrl: string = MAILSLURP_API_BASE): DisposableInbox {
  let mailCount = 0;
  let fingerprint: string | null = null;
  const call = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(15_000),
      headers: { "x-api-key": apiKey, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`inbox call failed (HTTP ${response.status})`);
    if (response.status === 204) return null;
    return response.json().catch(() => null);
  };
  return {
    address: async () => {
      const body = await call("/inboxes", { method: "POST", body: "{}" }).catch(() => null);
      if (!isRecord(body) || typeof body.id !== "string" || typeof body.emailAddress !== "string") return null;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.emailAddress) || body.id.length < 8) return null;
      return { email: body.emailAddress, token: body.id };
    },
    check: async (token: string) => {
      const body = await call(`/emails?inboxId=${encodeURIComponent(token)}&sort=DESC&limit=10`);
      const items = isRecord(body) && Array.isArray(body.content) ? body.content.filter(isRecord) : null;
      if (!items) return null;
      mailCount = items.length;
      const first = items[0];
      if (first) {
        fingerprint = `${safeDomain(String(first.from ?? ""))} | ${String(first.subject ?? "").replace(/\d/g, "#").slice(0, 80)}`;
      }
      for (const entry of items) {
        const header = `${String(entry.subject ?? "")}\n${String(entry.bodyExcerpt ?? "")}\n${String(entry.textExcerpt ?? "")}`;
        const headerCode = firstCode(header);
        if (headerCode) return headerCode;
        if (typeof entry.id === "string" && entry.id) {
          const full = await call(`/emails/${encodeURIComponent(entry.id)}`).catch(() => null);
          if (!isRecord(full)) continue;
          const code = firstCode(`${String(full.subject ?? "")}\n${String(full.body ?? "")}`);
          if (code) return code;
        }
      }
      return null;
    },
    lastMailCount: () => mailCount,
    lastMailFingerprint: () => fingerprint,
    release: async (token: string) => {
      await call(`/inboxes/${encodeURIComponent(token)}`, { method: "DELETE" }).catch(() => null);
    },
  };
}

/**
 * Run the verification-code consumer chain: disposable inbox + owned Contact,
 * live producer challenge, inbox code readback, consumer invocation with the
 * real code and producer context, residue sweep, and verified cleanup. Every
 * mutation is read back; nothing probe-owned may survive. Codes are never
 * logged or persisted.
 */
export async function invokeFlowVerificationCodeChain(input: {
  root: string;
  route: string;
  request: ChainRequest;
  build: ContactBuild;
  inbox?: DisposableInbox;
  poll?: { attempts: number; intervalMs: number };
}): Promise<ContactChainResult> {
  const { root, route, request, build } = input;
  const inbox = input.inbox ?? guerrillaInbox();
  const attempts = Math.max(1, Math.min(40, input.poll?.attempts ?? POLL_ATTEMPTS));
  const intervalMs = Math.max(0, Math.min(30_000, input.poll?.intervalMs ?? POLL_INTERVAL_MS));
  const match = typeof route === "string" ? route.match(ROUTE) : null;
  const rootOk = typeof root === "string" && new RegExp(`^/services/data/${match?.[1]}$`).test(root);
  if (!match || !rootOk) {
    return { status: 400, body: { errorCode: "FLOW_VERIFY_CHAIN_ROUTE_INVALID", message: "A discovered Flow route and matching API root are required." } };
  }
  const consumerName = match[2];
  const described = await request(route);
  if (!described.ok) return described;
  const shape = verificationConsumerShape(described.body, route);
  if (!shape) {
    return { status: 422, body: { errorCode: "FLOW_VERIFY_CHAIN_SHAPE_INVALID", message: "The live Flow is not a verification-code consumer with code and identity inputs." } };
  }
  const catalog = await request(`${root}/actions/custom/flow`);
  if (!catalog.ok) return catalog;
  const producerName = discoverContactChainProducer(catalog.body, consumerName);
  if (!producerName) {
    return { status: 422, body: { errorCode: "FLOW_VERIFY_CHAIN_PRODUCER_UNAVAILABLE", message: "The live Flow catalog does not expose one matching verification-challenge producer." } };
  }
  const producerRoute = `${root}/actions/custom/flow/${producerName}`;
  const producerDescribed = await request(producerRoute);
  if (!producerDescribed.ok) return producerDescribed;
  const producerBody = isRecord(producerDescribed.body) ? producerDescribed.body : null;
  const producerField = verificationProducerInput(producerBody?.inputs, producerBody?.outputs);
  if (!producerField) {
    return { status: 422, body: { errorCode: "FLOW_VERIFY_CHAIN_PRODUCER_SCHEMA_INVALID", message: "The challenge producer schema does not supply the consumer's required context." } };
  }
  const contactSchema = await request(`${root}/sobjects/Contact/describe`);
  const emailField = isRecord(contactSchema.body) && Array.isArray(contactSchema.body.fields)
    ? contactSchema.body.fields.filter(isRecord).find((field) => field.name === "Email")
    : null;
  if (!contactSchema.ok) return contactSchema;
  if (!emailField || emailField.createable !== true) {
    return { status: 403, body: { errorCode: "FLOW_VERIFY_CHAIN_PERMISSION_REQUIRED", message: "Automatic verification-chain context needs create/delete Contact access and Email write access." } };
  }
  const slot = await inbox.address().catch(() => null);
  if (!slot) {
    return { status: 422, body: { errorCode: "FLOW_VERIFY_CHAIN_INBOX_UNAVAILABLE", message: "The disposable verification inbox could not be provisioned; no challenge was sent." } };
  }
  const built = await build({ Email: slot.email });
  if ("failure" in built) return built.failure;
  const created = await request(`${root}/sobjects/Contact`, "POST", built.values);
  const id = isRecord(created.body) ? created.body.id : null;
  if (!created.ok || typeof id !== "string" || !CONTACT_ID.test(id)) return created;
  let cleanupError: string | undefined;
  let residueSweep: ResidueSweep | null = null;
  let pollStats: { checks: number; checkErrors: number; mailsSeen: number; mailFingerprint?: string } | null = null;
  let result: { status: number; body: unknown };
  try {
    const verified = await request(`${root}/sobjects/Contact/${id}`);
    if (!verified.ok || !isRecord(verified.body) || verified.body.Id !== id || verified.body.Email !== slot.email) {
      result = { status: 422, body: { errorCode: "FLOW_VERIFY_CHAIN_FIXTURE_UNVERIFIED", message: "The disposable chain Contact failed independent readback." } };
    } else {
      const challenge = await request(producerRoute, "POST", { inputs: [{ [producerField]: slot.email }] });
      const challengeResult = Array.isArray(challenge.body) ? challenge.body.find(isRecord) : null;
      const values = challengeResult && isRecord(challengeResult.outputValues) ? challengeResult.outputValues : null;
      if (!challenge.ok || challengeResult?.isSuccess !== true || !values ||
        (PRODUCER_REQUIRED_OUTPUTS as readonly string[]).some((name) => typeof values[name] !== "string" || !values[name])) {
        result = { status: challenge.ok ? 422 : challenge.status, body: { errorCode: "FLOW_VERIFY_CHAIN_CHALLENGE_UNAVAILABLE", message: "Salesforce did not supply a usable challenge context for the owned chain identity." } };
      } else {
        const customerId = values.customerId as string;
        if (!RECORD_ID.test(customerId)) {
          result = { status: 422, body: { errorCode: "FLOW_VERIFY_CHAIN_CHALLENGE_UNAVAILABLE", message: "The producer did not return a usable customer record identity." } };
        } else if (customerId !== id) {
          result = { status: 422, body: { errorCode: "FLOW_VERIFY_CHAIN_CHALLENGE_MISMATCH", message: "The producer resolved a different identity than the owned chain Contact; the challenge was not sent to the disposable inbox." } };
        } else {
          let code: string | null = null;
          let checkErrors = 0;
          let checks = 0;
          let mailsSeen = 0;
          let mailFingerprint: string | null = null;
          for (let attempt = 0; attempt < attempts && !code; attempt++) {
            if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
            checks++;
            try {
              code = await inbox.check(slot.token);
              mailsSeen = Math.max(mailsSeen, inbox.lastMailCount?.() ?? 0);
              mailFingerprint = inbox.lastMailFingerprint?.() ?? mailFingerprint;
            } catch {
              checkErrors++;
              code = null;
            }
            if (inbox.expectsSeedMail === true && attempt >= 3 && mailsSeen === 0) break;
          }
          pollStats = { checks, checkErrors, mailsSeen, ...(mailFingerprint ? { mailFingerprint } : {}) };
          if (!code) {
            const sessionLost = inbox.expectsSeedMail === true && mailsSeen === 0 && checks >= 4 && checkErrors === 0;
            result = checkErrors === checks || sessionLost
              ? { status: 422, body: { errorCode: "FLOW_VERIFY_CHAIN_INBOX_UNREACHABLE", message: sessionLost ? "The disposable verification inbox session was lost; reads succeed with zero mails including the seed mail." : "The disposable verification inbox could not be read back; every inbox read failed." } }
              : { status: 422, body: { errorCode: "FLOW_VERIFY_CHAIN_CODE_UNDELIVERED", message: `The verification challenge was sent but no delivered code arrived in the disposable inbox (${checks} reads, ${mailsSeen} mails observed).` } };
          } else {
            const args: Record<string, unknown> = { [shape.codeInput]: code, [shape.idInput]: customerId };
            if (shape.typeInput && typeof values.customerType === "string") args[shape.typeInput] = values.customerType;
            if (shape.keyInput && typeof values.authenticationKey === "string") args[shape.keyInput] = values.authenticationKey;
            const invocation = await request(route, "POST", { inputs: [args] });
            result = assessVerifyInvocation(invocation.status, invocation.body);
          }
        }
      }
    }
  } finally {
    residueSweep = await sweepFlowCommunicationResidue(request, root, { contactIds: [id], emails: [slot.email] });
    if (residueSweep.queried && !residueSweep.verified) {
      cleanupError = "Temporary chain communication residue cleanup could not be verified.";
    }
    const deleted = await request(`${root}/sobjects/Contact/${id}`, "DELETE");
    const gone = await request(`${root}/sobjects/Contact/${id}`);
    if ((!deleted.ok && deleted.status !== 404) || gone.status !== 404) {
      cleanupError = "Temporary chain Contact cleanup could not be verified.";
    }
    if (inbox.release) await inbox.release(slot.token).catch(() => null);
  }
  return {
    ...result,
    contextSchema: {
      source: "salesforce_live_flow_verification_code_chain",
      producerRoute,
      codeInput: shape.codeInput,
      idInput: shape.idInput,
      residueSweep,
      ...(pollStats ? { pollStats } : {}),
      requirement: "The consumer inputs carry the producer's real emailed code and customer context for a disposable owned Contact. Codes live in memory only and are never persisted.",
    },
    ...(cleanupError ? { cleanupError } : {}),
  };
}

function assessVerifyInvocation(status: number, body: unknown): { status: number; body: unknown } {
  if (status !== 200 || !Array.isArray(body) || body.length !== 1 || !isRecord(body[0])) {
    return { status: 422, body: { errorCode: "FLOW_VERIFY_CHAIN_CONSUMER_FAILED", message: "Salesforce did not return one Flow execution result." } };
  }
  const result = body[0];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const outputValues = isRecord(result.outputValues) ? result.outputValues : {};
  if (result.isSuccess !== true || errors.length > 0 || outputValues.Flow__InterviewStatus !== "Finished") {
    const detail = errors.map((entry) => isRecord(entry) && typeof entry.message === "string" ? entry.message : null).find(Boolean)
      ?? "The consumer Flow reported failure.";
    return { status: 422, body: { errorCode: "FLOW_VERIFY_CHAIN_CONSUMER_FAILED", message: String(detail).slice(0, 300) } };
  }
  for (const [name, value] of Object.entries(outputValues)) {
    if (name === "Flow__InterviewGuid") continue;
    if (flowOutputFailureSnippet(value)) {
      return { status: 422, body: { errorCode: "FLOW_VERIFY_CHAIN_CONSUMER_FAILED", message: "The consumer Flow reported its own operation failed." } };
    }
  }
  const verifiedEntry = Object.entries(outputValues).find(([name]) => VERIFIED_OUTPUT.test(name));
  if (verifiedEntry && verifiedEntry[1] !== true && String(verifiedEntry[1]).toLowerCase() !== "true") {
    return { status: 422, body: { errorCode: "FLOW_VERIFY_CHAIN_CONSUMER_UNVERIFIED", message: "The consumer Flow did not report a verified identity." } };
  }
  return { status, body };
}
