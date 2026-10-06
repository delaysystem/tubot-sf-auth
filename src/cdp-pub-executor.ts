/** CDP publish family: verified native invoke lifecycle.
 *
 * Generic, org-agnostic executor behind the Searcher-side routing in
 * `1action-searcher/src/cdp-pub-lifecycle.ts`. The Salesforce root, route,
 * descriptor inputs, discovery, and verification are caller-supplied; the
 * transport is injected. No org ID, alias, URL, or customer value appears
 * here. Probe arguments use ONLY declared live descriptor input names.
 * Success is reported ONLY when the native call is accepted AND an
 * injected readback observes the publish lifecycle state on the target
 * row. Absent substrate (zero discovered rows) returns an explicit
 * setup-blocked result WITHOUT posting; the native call is never made
 * with an invented identity.
 *
 * No cleanup phase is needed: publish/send effects are idempotent
 * lifecycle transitions on live rows, and this lifecycle creates no owned
 * fixtures. An optional caller cleanup is supported with the same
 * must-verify-absence semantics as the sibling data-action lifecycle.
 */

export type DescriptorInput = { name: string; type?: string; required?: boolean };

export type TransportResult = { status: number; ok: boolean; body: unknown };
export type CdpPubTransport = (path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown) => Promise<TransportResult>;

export type CdpPubDiscovery =
  | { found: true; value: string; rowId: string; soql: string }
  | { found: false; evidence: string[] };

export type CdpPubOperationState =
  | 'verified'
  | 'pending'
  | 'substrate-absent'
  | 'not-found'
  | 'license'
  | 'rejected';

export type CdpPubLifecycleInput = {
  root: string;
  route: string;
  actionName: string;
  descriptorInputs: DescriptorInput[];
  /** Caller discovery over live SOQL/REST; must never invent an identity. */
  discover: () => Promise<CdpPubDiscovery>;
  request: CdpPubTransport;
  /** Required effect readback: must observe the publish lifecycle state. */
  verify: (discovery: Extract<CdpPubDiscovery, { found: true }>) => Promise<{ verified: boolean }>;
  /** Deletes only owned context; must verify absence itself. */
  cleanup?: () => Promise<{ cleaned: boolean; error?: string }>;
  maxVerifyPolls?: number;
};

export type CdpPubLifecycleResult = {
  status: number;
  body: unknown;
  success: boolean;
  operationState: CdpPubOperationState;
  cleanupError?: string;
  contextSchema: Record<string, unknown>;
};

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const failure = (status: number, errorCode: string, message: string, extra?: Record<string, unknown>): TransportResult => ({
  status, ok: false, body: { errorCode, message, ...extra },
});

/**
 * Probe arguments use ONLY declared live descriptor input names. Exactly
 * one declared input (or exactly one required input) receives the
 * discovered live identity; any other shape is an explicit failure.
 */
export function buildCdpPublishArgs(
  descriptorInputs: DescriptorInput[],
  discoveredValue: string,
): { args: Record<string, unknown> } | { failure: string } {
  for (const input of descriptorInputs) {
    if (typeof input.name !== 'string' || !IDENTIFIER.test(input.name)) {
      return { failure: 'The live descriptor exposes an invalid input name.' };
    }
  }
  if (discoveredValue.length === 0) {
    return { failure: 'No discovered live identity value for the publish input.' };
  }
  if (descriptorInputs.length === 1) return { args: { [descriptorInputs[0].name]: discoveredValue } };
  const required = descriptorInputs.filter((input) => input.required === true);
  if (required.length === 1) return { args: { [required[0].name]: discoveredValue } };
  if (required.length === 0) return { failure: 'The live descriptor declares no required publish input.' };
  return { failure: 'The live descriptor declares multiple required inputs; no value will be invented.' };
}

/** Native acceptance: HTTP ok plus every envelope item isSuccess with no
 * errors and no embedded output error message. */
export function isCdpPublishAccepted(status: number, body: unknown): boolean {
  if (!(status >= 200 && status < 300) || !Array.isArray(body) || body.length === 0) return false;
  return body.every((item) => {
    if (!record(item) || item.isSuccess !== true) return false;
    if (!(item.errors === null || item.errors === undefined ||
      (Array.isArray(item.errors) && item.errors.length === 0))) return false;
    if (item.errorCode !== undefined || item.errorMessage !== undefined) return false;
    if (record(item.outputValues) && typeof item.outputValues.errorMessage === 'string' &&
      item.outputValues.errorMessage.length > 0) return false;
    return true;
  });
}

function collectMessages(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value.length > 0 && value.length < 2000) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMessages(item, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'message' || key === 'errorMessage' || key === 'error_description' ||
        key === 'errorCode' || key === 'statusCode' || key === 'code') {
        if (typeof child === 'string') out.push(child);
        else collectMessages(child, out, depth + 1);
      } else if (child !== null && typeof child === 'object') {
        collectMessages(child, out, depth + 1);
      }
    }
  }
}

/** Operation state from a live upstream outcome. License is returned ONLY
 * on explicit license text; `not-found` only on explicit missing-record
 * text. Anything unrecognized is `rejected`, never upgraded. */
export function classifyCdpPublishState(status: number, body: unknown): 'accepted' | 'pending' | 'not-found' | 'license' | 'rejected' {
  const texts: string[] = [];
  collectMessages(body, texts, 0);
  const lower = texts.join('; ').toLowerCase();
  if (/\blicen[cs]e\b/.test(lower)) return 'license';
  if (isCdpPublishAccepted(status, body)) return 'accepted';
  if (/\bpending\b|in progress|queued|is running|accepted|check.*later|retry.*later/.test(lower)) return 'pending';
  if (/item_not_found|record not found|does not exist|no such|not found/.test(lower)) return 'not-found';
  return 'rejected';
}

/** Redacts caller-supplied secrets, Salesforce IDs, and emails from a diagnostic. */
export function redactCdpPublishDiagnostic(message: string, secrets: string[]): string {
  let text = message;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[value]');
  }
  return text
    .replace(/\b(?=[A-Za-z0-9]{15,18}\b)(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?\b/g, '[salesforce-id]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\s+/g, ' ')
    .slice(0, 320);
}

export async function runCdpPublishLifecycle(input: CdpPubLifecycleInput): Promise<CdpPubLifecycleResult> {
  const baseContext = {
    source: 'salesforce_live_cdp_publish',
    lifecycle: 'publish',
    actionName: input.actionName,
    automaticSteps: [
      'Discover the live publish substrate identity from the org (SOQL/REST, no invention)',
      'Invoke the native publish/send with declared descriptor inputs only',
      'Verify the publish lifecycle state from the target row',
    ],
  };
  const done = (
    result: TransportResult,
    success: boolean,
    operationState: CdpPubOperationState,
    extra: Record<string, unknown>,
  ): CdpPubLifecycleResult => ({
    status: result.status,
    body: result.body,
    success,
    operationState,
    ...(typeof extra.cleanupError === 'string' ? { cleanupError: extra.cleanupError as string } : {}),
    contextSchema: { ...baseContext, ...extra },
  });
  if (!input.root.startsWith('/services/data/') || !input.route.startsWith(`${input.root}/actions/`)) {
    return done(failure(400, 'CDP_PUB_ROUTE_INVALID', 'A live action route under the API root is required.'),
      false, 'rejected', { verified: false });
  }
  const discovery = await input.discover();
  if (!discovery.found) {
    return done(failure(422, 'CDP_PUB_SUBSTRATE_ABSENT',
      'No live publish substrate rows were discovered; the native call was not attempted with an invented identity.',
      { evidence: discovery.evidence }),
      false, 'substrate-absent', { verified: false, evidence: discovery.evidence });
  }
  const planned = buildCdpPublishArgs(input.descriptorInputs, discovery.value);
  if ('failure' in planned) {
    return done(failure(422, 'CDP_PUB_INPUT_UNAVAILABLE', planned.failure), false, 'rejected', {
      verified: false,
    });
  }
  const invoked = await input.request(input.route, 'POST', { inputs: [planned.args] });
  const state = classifyCdpPublishState(invoked.status, invoked.body);
  if (state === 'license') {
    return done(invoked, false, 'license', { verified: false });
  }
  if (state === 'not-found') {
    return done(failure(422, 'CDP_PUB_SUBSTRATE_NOT_FOUND',
      'Salesforce reports the referenced publish substrate record does not exist.',
      { upstreamOutcome: invoked.body }),
      false, 'not-found', { verified: false });
  }
  if (state === 'rejected') {
    return done(failure(422, 'CDP_PUB_ACTION_REJECTED',
      'Salesforce ended the publish operation without a verifiable effect.',
      { upstreamOutcome: invoked.body }),
      false, 'rejected', { verified: false });
  }
  const polls = Math.min(Math.max(input.maxVerifyPolls ?? 3, 1), 8);
  for (let attempt = 0; attempt < polls; attempt++) {
    const check = await input.verify(discovery);
    if (check.verified) {
      let cleanupError: string | undefined;
      if (input.cleanup) {
        const cleaned = await input.cleanup();
        if (!cleaned.cleaned) cleanupError = cleaned.error ?? 'Owned context cleanup could not be verified.';
      }
      if (cleanupError) {
        return done(failure(422, 'CDP_PUB_CLEANUP_UNVERIFIED', cleanupError, { upstreamOutcome: invoked.body }),
          false, state === 'pending' ? 'pending' : 'rejected', { verified: false, cleanupError });
      }
      return done(invoked, true, 'verified', { verified: true });
    }
  }
  return done({
    status: 202, ok: false,
    body: {
      errorCode: 'CDP_PUB_OPERATION_PENDING',
      message: 'The publish operation was accepted; the lifecycle state is not yet visible. The scheduler must reuse this operation and verify the target row.',
    },
  }, false, 'pending', { verified: false });
}
