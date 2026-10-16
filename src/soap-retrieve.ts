import { XMLParser, XMLValidator } from "fast-xml-parser";
import { readBodyBounded, SecurityError } from "./request-security";
import type { SalesforceConnection } from "./agent-script";

/**
 * Single shared Metadata API SOAP transport for every agent retrieve path
 * (snapshot jobs, batch script retrieve, callable tools). One timeout, retry,
 * resume, and fault-mapping behavior; callers differ only in members and
 * response shaping.
 */

export interface SoapMember { type: string; fullName: string }
export interface SoapRetrieveOptions {
  /** Per-request fetch timeout. Default 60_000. */
  timeoutMs?: number;
  /** Max SOAP response body bytes. Default 16_800_000 (12MB archive * 1.4). */
  maxBodyBytes?: number;
  /** Poll loop budget for retrieveMembers. Default 30 attempts. */
  maxPollAttempts?: number;
  /** Base poll interval; backs off 1.5x per attempt (cap 10s) with jitter. Default 1500. */
  pollIntervalMs?: number;
  /** Caller abort (worker shutdown, request cancel). Checked between polls. */
  signal?: AbortSignal;
  /** Stage hook: ("begin" | "poll", attempt, asyncId?). */
  onEvent?: (stage: "begin" | "poll", attempt: number, asyncId: string | null) => void;
}

export interface RetrieveHandle { asyncId: string; version: string }
export type RetrieveOutcome =
  | { status: "complete"; zipBytes: Uint8Array; fileProperties: any[]; messages: any[]; attempts: number }
  | { status: "pending"; asyncId: string; attempts: number };

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, parseTagValue: false, processEntities: true });
const esc = (value: string) => value.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
const arr = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];

function parseXml(text: string): any {
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw new SecurityError(502, "invalid_metadata_xml");
  return parser.parse(text);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new SecurityError(503, "retrieve_aborted")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new SecurityError(503, "retrieve_aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Jittered backoff: base * 1.5^attempt, capped at 10s, ±25%. */
export function pollDelay(baseMs: number, attempt: number): number {
  const capped = Math.min(baseMs * Math.pow(1.5, attempt), 10_000);
  return Math.floor(capped * (0.75 + Math.random() * 0.5));
}

/** One SOAP call with bounded wait, bounded body, and typed fault mapping. */
export async function soapRequest(
  conn: SalesforceConnection, version: string, operation: string, body: string, opts?: SoapRetrieveOptions,
): Promise<any> {
  if (!/^\d{1,3}\.\d{1,2}$/.test(version)) throw new SecurityError(502, "invalid_metadata_api_version");
  let response: Response;
  try {
    response = await fetch(`${conn.instanceUrl}/services/Soap/m/${version}`, {
      method: "POST", headers: { "Content-Type": "text/xml; charset=UTF-8", SOAPAction: operation },
      body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata"><s:Header><m:SessionHeader><m:sessionId>${esc(conn.accessToken)}</m:sessionId></m:SessionHeader></s:Header><s:Body><m:${operation}>${body}</m:${operation}></s:Body></s:Envelope>`,
      signal: opts?.signal ?? AbortSignal.timeout(opts?.timeoutMs ?? 60_000),
    });
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    if ((error as Error)?.name === "TimeoutError") throw new SecurityError(503, "salesforce_metadata_timeout");
    if ((error as Error)?.name === "AbortError") throw new SecurityError(503, "retrieve_aborted");
    throw new SecurityError(503, "salesforce_metadata_unreachable");
  }
  const text = new TextDecoder().decode(await readBodyBounded(response, opts?.maxBodyBytes ?? 16_800_000));
  if (response.status === 429) throw new SecurityError(429, "salesforce_metadata_rate_limited");
  if ([503, 504].includes(response.status)) throw new SecurityError(503, "salesforce_metadata_temporarily_unavailable");
  const envelope = parseXml(text)?.Envelope?.Body;
  if (!response.ok || envelope?.Fault) {
    const fault = String(envelope?.Fault?.faultcode ?? "").replace(/[^A-Za-z0-9_:.-]/g, "").slice(0, 100);
    if (/REQUEST_LIMIT_EXCEEDED/.test(fault)) throw new SecurityError(429, "salesforce_metadata_rate_limited");
    if (/INVALID_SESSION_ID/.test(fault)) throw new SecurityError(401, "salesforce_metadata_session_expired");
    if (/INSUFFICIENT_ACCESS/.test(fault)) throw new SecurityError(403, "agent_metadata_permission_required");
    throw new SecurityError(response.status === 401 ? 401 : 502, `salesforce_metadata_request_failed:${operation}:${fault || response.status}`);
  }
  const result = envelope?.[`${operation}Response`]?.result;
  if (result === undefined && operation === "listMetadata" && envelope?.listMetadataResponse !== undefined) return [];
  if (result === undefined) throw new SecurityError(502, "invalid_metadata_response");
  return result;
}

export function buildRetrieveBody(version: string, members: SoapMember[]): string {
  const types = [...new Set(members.map(m => m.type))];
  return `<m:retrieveRequest><m:apiVersion>${version}</m:apiVersion><m:singlePackage>true</m:singlePackage><m:unpackaged>${types.map(type => `<m:types>${members.filter(m => m.type === type).map(m => `<m:members>${esc(m.fullName)}</m:members>`).join("")}<m:name>${type}</m:name></m:types>`).join("")}<m:version>${version}</m:version></m:unpackaged></m:retrieveRequest>`;
}

/** Starts a retrieve, returning the resumable async id. */
export async function beginRetrieve(
  conn: SalesforceConnection, version: string, members: SoapMember[], opts?: SoapRetrieveOptions,
): Promise<string> {
  const result = await soapRequest(conn, version, "retrieve", buildRetrieveBody(version, members), opts);
  if (typeof result.id !== "string") throw new SecurityError(502, "metadata_retrieve_not_started");
  opts?.onEvent?.("begin", 0, result.id);
  return result.id;
}

export interface PollResult {
  done: boolean; zipB64: string | null; fileProperties: any[]; messages: any[];
  success: boolean; errorMessage: string | null;
}

/** One status poll. Never throws for pending; throws typed errors for denied/failed checks. */
export async function pollRetrieve(
  conn: SalesforceConnection, version: string, asyncId: string, opts?: SoapRetrieveOptions,
): Promise<PollResult> {
  const result = await soapRequest(conn, version, "checkRetrieveStatus",
    `<m:asyncProcessId>${esc(asyncId)}</m:asyncProcessId><m:includeZip>true</m:includeZip>`, opts);
  if (result.done !== "true") return { done: false, zipB64: null, fileProperties: [], messages: [], success: false, errorMessage: null };
  return {
    done: true,
    zipB64: typeof result.zipFile === "string" ? result.zipFile : null,
    fileProperties: arr<any>(result.fileProperties),
    messages: arr<any>(result.messages),
    success: result.success === "true",
    errorMessage: typeof result.errorMessage === "string" ? result.errorMessage : null,
  };
}

/** Terminal retrieve failure: access-denied names the entity (403), else 502. */
export function throwRetrieveFailure(polled: PollResult): never {
  const deniedEntity = String(polled.errorMessage ?? "").match(/INSUFFICIENT_ACCESS:.*entity:\s*([A-Za-z][A-Za-z0-9_]*)/);
  if (deniedEntity) throw new SecurityError(403, `agent_metadata_access_required:${deniedEntity[1]}`);
  throw new SecurityError(502, "agent_metadata_retrieve_failed");
}

/**
 * Begin (or resume via `resumeAsyncId`) + poll loop with jittered backoff.
 * Returns `pending` with the async id when the poll budget expires so the
 * caller can persist it and resume later; failures throw typed errors.
 */
export async function retrieveMembers(
  conn: SalesforceConnection, version: string, members: SoapMember[],
  opts?: SoapRetrieveOptions & { resumeAsyncId?: string },
): Promise<RetrieveOutcome> {
  const maxAttempts = opts?.maxPollAttempts ?? 30;
  const baseInterval = opts?.pollIntervalMs ?? 1500;
  const asyncId = opts?.resumeAsyncId ?? await beginRetrieve(conn, version, members, opts);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts?.signal?.aborted) throw new SecurityError(503, "retrieve_aborted");
    await sleep(attempt === 0 ? Math.min(baseInterval, 1000) : pollDelay(baseInterval, attempt), opts?.signal);
    opts?.onEvent?.("poll", attempt + 1, asyncId);
    const polled = await pollRetrieve(conn, version, asyncId, opts);
    if (!polled.done) continue;
    if (!polled.success || polled.zipB64 === null) throwRetrieveFailure(polled);
    const zipBytes = Uint8Array.from(atob(polled.zipB64), c => c.charCodeAt(0));
    return { status: "complete", zipBytes, fileProperties: polled.fileProperties, messages: polled.messages, attempts: attempt + 1 };
  }
  return { status: "pending", asyncId, attempts: maxAttempts };
}
