import { validScope, validConfig, turnScopeMatches, type TenantScope, type ProxyConfig, type EchoAction } from '../../tubot-sf-proxy/src/contracts';
import {browserConfig,verifyBrowserTurn,discoverBrowserTurns,transcriptText} from './browser-echo';
import {echoParameters,validGuestId,qualifyDefinitionName,flipDefinitionTwin,isDefinitionInvalidInput} from './echo-params';
import {resolveSessionState} from './session-state';
import { injectSoapSession } from "./soap-session";
import { cacheLifecycleSchema } from "./lifecycle-schema-cache";
import { provisionCommerceFixtureAccess } from "./commerce-fixture-access";
import { deleteOwnedOrderSummary } from "./delete-owned-order-summary";
import { provisionOwnedOrderAccess } from "./owned-order-access";
import { flowReadFields, provisionFlowReadFields } from "./flow-read-field-grants";
import { isQueryOnlyFlowMetadata } from "./flow-read-metadata";
import { buildJwtAssertion, JWT_BEARER_GRANT_TYPE } from "./jwt";
import { extractTrailingResponseDocuments, parseSalesforceResponseJson } from './salesforce-response-json';
import { isCompoundParent, isNameMarkerField } from "./describe-marker-field";
import { invokeOwnedRecordAction } from './record-action-context';
import { invokeAppointmentInvitation } from "./appointment-invitation-context";
import { invokeAppointmentCancellation } from "./appointment-cancel-context";
import { invokeCartMutation } from "./cart-action-context";
import { invokeCartItemMutation, CART_ITEM_MUTATION_ACTIONS, CART_INVENTORY_RESERVATION_ACTIONS } from "./cart-item-action-context";
import { invokeInventoryReservation, INVENTORY_RESERVATION_ACTIONS } from "./inventory-reservation-action-context";
import { invokeGuestBuyerRegistration, GUEST_BUYER_ACTIONS } from "./guest-buyer-owned-context";
import { invokeSearchBoostBuryRuleWithContext, SEARCH_RULE_ACTIONS } from "./search-rule-owned-context";
import { invokePaymentAuthorizationWithContext, PAYMENT_AUTH_ACTIONS } from "./payment-auth-owned-context";
import { invokeFulfillmentCapacityWithContext, FULFILLMENT_CAPACITY_ACTIONS } from "./fulfillment-capacity-context";
import { invokeServiceReportWithContext, SERVICE_REPORT_ACTIONS } from "./service-report-context";
import { invokeWorkOrdersWithContext, WORK_ORDERS_ACTIONS } from "./work-orders-context";
import { invokeSingleFixtureAction, SINGLE_FIXTURE_ACTION_SPECS } from "./single-fixture-action-context";
import { invokeFixtureBackedRead, FIXTURE_READ_ACTION_SPECS } from "./fixture-read-context";
import { invokeContactRequestContext } from "./contact-request-context";
import { invokeWaitlistContext } from "./waitlist-action-context";
import { missingGraphDefinition, readOwnedGraphMetadata } from "./data-graph-metadata-retry";
import { describePackagedFlowContract, invokeFlowRecordContract } from "./flow-record-contract";
import { flowRecordCatalogCandidates, flowRecordCatalogSoql, flowRecordFixtureBlocker, resolveFlowRecordTarget } from "./flow-record-context";
import { invokeFlowUpdateContract } from "./flow-update-contract";
import { invokeLeadAssignmentContext } from "./lead-assignment-context";
import { invokeOwnedFlowCreation } from "./owned-flow-creation-context";
import { invokeCustomFieldActionContext, xmlText } from './custom-field-action-context';
import { invokeRoutingContext } from "./routing-action-context";
import { selfProvisionFixtureGrants as provisionFixtureGrants } from "./fixture-self-provision";
import { APPROVAL_ADVANCED_ACTIONS, APPROVAL_SUBMIT_ACTION, approvalActionName, invokeApprovalActionWithContext } from "./approval-owned-context";
import { invokeProcSimpleApprovalWithContext, procSimpleApprovalActionName } from "./approval-flow-lifecycle";
import { invokePricebookContext } from "./pricebook-action-context";
import { invokeWorkPlanContext, WORK_PLAN_CONTEXT_ACTIONS } from "./work-plan-context";
import { invokeSessionPermissionContext } from "./session-permission-context";
import { invokeKnowledgeContext } from "./knowledge-action-context";
import { invokeReferenceQuickAction } from "./reference-quick-action";
import { invokeOwnedQuickAction, quickActionRouteTerminal, seedLiveReferenceCache } from './quick-action-owned-context';
import { seedRequiredReferenceValues } from './fixture-reference-seeding';
import { isTriggerNullInsertFault, planTriggerNullEnrichment } from "./trigger-null-enrichment";
import { selectAlternativeMarkerField, type TargetField } from "./skipped-standards-context";
import { flowCreationRecipes } from "./flow-creation-context";
import { invokeFlowScalarCreationContract } from "./flow-scalar-creation-contract";
import { flowLookupBindings, flowFixtureValue, lookupIdBindings, commaStructuredProbeValue } from "./action-flow-context";
import { PRODUCER_REQUIRED_OUTPUTS, eventSlotCompletion, personIdentityCompletion, verificationProducerInput } from "./flow-producer-context";
import { sweepFlowCommunicationResidue, type ResidueSweep } from "./flow-residue-sweep";
import { flowOutputFailureSnippet, invokeFlowContactChain } from "./flow-fallback-contact-chain";
import { invokeOwnedSubstrate, isReadOnlyEvident, type OwnedSubstratePlan } from "./flow-owned-substrate-chain";
import { runFlowFaultRepairConsumer } from "./flow-fault-repair-consumer";
import { type ManagedFlowFault } from "./managed-flow-faults";
import { FLOW_LIVE_SOBJECT_SPECS, invokeFlowLiveSObject } from "./flow-live-sobject-context";
import { guerrillaInbox, invokeFlowVerificationCodeChain, mailslurpInbox } from "./flow-verification-code-chain";
import { invokeFlowVerifyLinkedChain } from "./flow-verify-linked-chain";

/** Disposable verification inbox: MailSlurp when its key is configured, else Guerrilla. */
function verificationInbox(env: AuthEnv) {
  return typeof env.MAILSLURP_API_KEY === "string" && env.MAILSLURP_API_KEY.length >= 8
    ? mailslurpInbox(env.MAILSLURP_API_KEY)
    : guerrillaInbox();
}
import { runCdpPublishLifecycle, type CdpPubDiscovery, type CdpPubTransport } from "./cdp-pub-executor";
import { invokeRemainderBookingFlow } from "./remainder-booking-flow-context";
import { invokeNotificationWithContext, notificationActionName } from "./notification-owned-context";
import { invokeNotificationFlowWithContext, notificationFlowActionName } from "./notification-flow-consumer-context";
import { invokeEmailAlertWithContext, emailAlertRouteParts } from "./email-alert-owned-context";
import { apexRelayActionName, invokeApexRelayWithContext } from "./apex-relay-context";
import { apexExecActionName, invokeApexExecWithContext } from "./apex-exec-context";
import { APEX_SOBJECT_RECORD_SPECS, invokeApexSObjectRecord } from "./apex-sobject-record-context";
import { ASSET_REPLACE_SPECS, invokeAssetReplace } from "./asset-replace-context";
import { decisionTableActionName, invokeDecisionTableWithContext } from "./decision-table-context";
import { apexCsvActionName, invokeApexCsvWithContext } from "./apex-csv-context";
import { apexOverlapActionName, invokeApexOverlapWithContext } from "./apex-overlap-context";
import { ORDER_SUMMARY_ACTIONS, invokeOrderSummaryPreviewWithContext } from "./order-summary-context";
import { researchActionName, invokeResearchWithOwnedContext } from "./research-lifecycle-context";
import { invokeSkippedStandardWithOwnedContext, skippedStandardFamilySlug, skippedStandardRouteInfo } from "./skipped-standard-lifecycle";
import { invokeAgentFlowWithProducerContext } from "./agent-customer-context";
import { commerceLifecycleKind, commerceLifecycleActionName, invokeCommerceLifecycleWithContext } from "./commerce-lifecycle-context";
import { readBodyBounded, readJsonBounded, requireScope, scopedTags, SecurityError } from "./request-security";
import { equalHash, maybePurgeRpcNonces, verifySignedRpcCall, type SignedRpcEnvelope } from "./rpc-signing";
import { getCallableToolUrlsForChannel, type Credential } from "./agent-script";
import { discoverAgents, startAgentSnapshot, advanceAgentSnapshot, planAgentSnapshotPoll, downloadAgentSnapshot, verifyAgentAccess, probeAgentMetadataPermissions, listAgentSnapshotsForScope, listSnapshotTeamsForOrg, readAgentSnapshotForScope, reconcileExtractionJobs, type AgentScope } from "./agent-snapshot";
import { Data360AgentClient } from "./data360-client";
import { hydrateAgentFromData360, listCachedAgents } from "./agent-blob";
import { repairPromptContext, inferredContextSchema } from "./prompt-context";
import {
  UserDataCacheStore,
  purgeEdgeCache,
  createCachedResponse,
  getDeclarativeCacheHeaders,
  computeETag,
  isNotModified,
} from "./cache-helper";
import { maybeRunRetention, purgeRetention } from "./retention";
import { claimEchoSubmit, completeEchoSubmit, releaseEchoSubmit } from "./echo-submit-claim";
// NOTE: no `export *` here — workerd rejects non-function module exports at
// boot (e.g. cache-helper's DEFAULT_CACHE_CONTROL string). Import helpers
// from their source modules directly.

/** Private service-binding API for channel-scoped Salesforce operations. */
export interface AuthEnv {
  DB: D1Database;
  /** Base64-encoded 32-byte AES-GCM key, configured as a Worker secret. */
  SF_CREDENTIAL_ENCRYPTION_KEY: string;
  /** Dedicated New Panel service key; the retired Panel key is never accepted. */
  SELF_OAUTH_NEW_PANEL_HMAC_KEY?: string;
  /** MailSlurp API key for disposable verification inboxes, configured as a Worker secret. Absent in tests. */
  MAILSLURP_API_KEY?: string;
  /** Private service binding to the Panel-only JWT signing RPC. */
  PANEL_JWT_SIGNER?: {
    signAssertion(input: { subjectUsername: string; isSandbox: boolean }): Promise<string>;
  };
  /** Local/test fallback only; production signing uses PANEL_JWT_SIGNER. */
  TUBOT_JWT_PRIVATE_KEY?: string;
  /** Per-caller RPC envelope keys (>=32 chars); *_NEXT is the rotation-overlap fallback. */
  AUTH_CALLER_KEY_PROXY?: string;
  AUTH_CALLER_KEY_SEARCHER?: string;
  AUTH_CALLER_KEY_DATA360?: string;
  AUTH_CALLER_KEY_CONVERSATION?: string;
  AUTH_CALLER_KEY_AGENTCODE?: string;
  AUTH_CALLER_KEY_PROXY_NEXT?: string;
  AUTH_CALLER_KEY_SEARCHER_NEXT?: string;
  AUTH_CALLER_KEY_DATA360_NEXT?: string;
  AUTH_CALLER_KEY_CONVERSATION_NEXT?: string;
  AUTH_CALLER_KEY_AGENTCODE_NEXT?: string;
  /** When "1", RPC envelope failures warn and proceed instead of rejecting. */
  AUTH_RPC_WARN_MODE?: string;
  AUTH_RPC_ALLOW_LEGACY?: string;
  RETRIEVE64?: {
    getCallableToolUrls?(params: any): Promise<string[]>;
    registerDefinition?(params: any): Promise<any>;
    fetch?(input: any, init?: any): Promise<Response>;
  };
  /** tubot-sf-data360 service binding for cached agent blob reads (optional; D1-only when absent). */
  DATA360?: { fetch(input: any, init?: any): Promise<Response> };
  /** Shared HMAC mesh key for data360 service routes (same value as data360's DATA360_INTERNAL_KEY). */
  DATA360_INTERNAL_KEY?: string;
}

type Key = { teamId: string; orgId: string; channelId: string };
export type Token = { accessToken: string; instanceUrl: string; expiresAt: number };
type ExecutionUserReference = Key & { integrationUserId: string; isPrimary: boolean };
type ExecutionUserDbRow = Omit<ExecutionUserReference, "isPrimary"> & { isPrimary: number };
type SelfOAuthPending = {
  state_hash: string;
  team_id: string;
  org_id: string;
  instance_url: string;
  client_id: string;
  redirect_uri: string;
  return_url: string;
  salesforce_user_id: string;
  code_verifier_cipher: string;
  code_verifier_iv: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
};
type SelfOAuthCredential = {
  team_id: string;
  org_id: string;
  instance_url: string;
  client_id: string;
  salesforce_user_id: string;
  refresh_token_cipher: string;
  refresh_token_iv: string;
  created_at: number;
  updated_at: number;
};
type SelfAccessToken = { accessToken: string; expiresAt: number };
type SelfOAuthGrant = { teamId: string; orgId: string };
type ToolTarget = {
  type: string;
  name: string;
  method?: string;
  path?: string;
  queryParams?: unknown;
};
type ApiVersion = { version: string; url: string };
type ToolResolution =
  | { available: true; route: string; inputs: unknown[]; outputs: unknown[]; method: string; api: boolean; target: ToolTarget }
  | { available: false; diagnostic: { code: string; message: string; retryable?: boolean } };
type SafeFailure = {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
};

class AuthFailure extends Error {
  constructor(readonly failure: SafeFailure) { super(failure.code); }
}

const tokenCache = new Map<string, Token>();
const tokenInflight = new Map<string, Promise<Token>>();
/** Channel credential rows per team+org+channel. Rows change only on
 * (re)connect/disconnect while nearly every RPC reads one, so a short TTL
 * keeps turns at ~0 D1 reads with bounded staleness. Local disconnects
 * invalidate; cross-worker reconnects converge within the TTL. */
const PANEL_CREDENTIAL_TTL_MS = 30_000;
const PANEL_CREDENTIAL_CACHE_CAP = 2000;
const panelCredentialCache = new Map<string, { at: number; row: Credential }>();

/** Test isolation for the credential cache (mirrors __resetRetentionGuardForTests). */
export function __resetPanelCredentialCacheForTests(): void {
  panelCredentialCache.clear();
}
// Resolved Flow routes per org+action. Discovery costs 3-4 Salesforce calls;
// the echo hot path reuses routes for 5 minutes and re-resolves on mismatch.
const flowRouteCache = new Map<string, { at: number; resolved: ToolResolution }>();
const selfTokenCache = new Map<string, SelfAccessToken>();
const encoder = new TextEncoder();
const API_VERSION = "v65.0";
const MAX_SALESFORCE_INSPECTION_BYTES = 1_800_000;
const SELF_OAUTH_CALLBACK_PATH = "/api/v1/salesforce/self-oauth/callback";
const SELF_OAUTH_PENDING_SECONDS = 600;

function json(body: unknown, requestId: string, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-cache, no-store, must-revalidate", "X-Request-Id": requestId },
  });
}
function error(requestId: string, status: number, code: string, message: string, retryable = false): Response {
  return json({ error: code, message, retryable, requestId }, requestId, status);
}
function failure(requestId: string, value: SafeFailure): Response {
  return error(requestId, value.status, value.code, value.message, value.retryable);
}
function authFailure(status: number, code: string, message: string, retryable = false): AuthFailure {
  return new AuthFailure({ status, code, message, retryable });
}
function upstreamFailure(status: number, code: string, message: string): SafeFailure {
  if (status === 429 || status >= 500) {
    return { status: 503, code, message, retryable: true };
  }
  return { status: 502, code, message, retryable: false };
}
function object(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown, max = 512): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}
function key(v: Record<string, unknown>): v is Record<string, unknown> & Key {
  return str(v.teamId, 128) && str(v.orgId, 128) && str(v.channelId, 128);
}
function validInstanceUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && !u.port &&
      u.pathname === "/" && !u.search && !u.hash &&
      [".my.salesforce.com", ".salesforce.com", ".my.salesforce.mil", ".salesforce.mil", ".force.com"]
        .some(suffix => u.hostname.endsWith(suffix));
  } catch { return false; }
}
function b64(v: Uint8Array): string { return btoa(String.fromCharCode(...v)); }
function b64url(v: Uint8Array): string { return b64(v).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function unb64(v: string): Uint8Array { return Uint8Array.from(atob(v), c => c.charCodeAt(0)); }
function validSalesforceOrgId(v: unknown): v is string {
  return typeof v === "string" && /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(v);
}
function validSalesforceUserId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
}
function validSelfOAuthCallbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      url.pathname === SELF_OAUTH_CALLBACK_PATH && !url.search && !url.hash;
  } catch { return false; }
}
function salesforceReturnUrl(instanceUrl: string): string {
  const apiUrl = new URL(instanceUrl);
  const hostname = apiUrl.hostname
    .replace(/\.my\.salesforce\.com$/i, ".lightning.force.com")
    .replace(/\.my\.salesforce\.mil$/i, ".lightning.force.mil")
    .replace(/\.salesforce\.com$/i, ".lightning.force.com")
    .replace(/\.salesforce\.mil$/i, ".lightning.force.mil");
  if (hostname === apiUrl.hostname) {
    throw authFailure(400, "invalid_salesforce_domain", "The Salesforce My Domain URL could not be resolved for the authorization return.");
  }
  try {
    return new URL("/lightning/n/tubot__Panel_Settings", `https://${hostname}`).toString();
  } catch {
    throw authFailure(400, "invalid_salesforce_domain", "The Salesforce My Domain URL could not be resolved for the authorization return.");
  }
}
async function aesKey(env: AuthEnv): Promise<CryptoKey> {
  if (!env.SF_CREDENTIAL_ENCRYPTION_KEY) {
    throw authFailure(500, "credential_encryption_key_missing", "Salesforce credential encryption is not configured. Set the Worker encryption secret and retry.");
  }
  let bytes: Uint8Array;
  try { bytes = unb64(env.SF_CREDENTIAL_ENCRYPTION_KEY); }
  catch {
    throw authFailure(500, "credential_encryption_key_invalid", "The Worker encryption secret is invalid. Set a base64-encoded 32-byte key and retry.");
  }
  if (bytes.length !== 32) {
    throw authFailure(500, "credential_encryption_key_invalid", "The Worker encryption secret is invalid. Set a base64-encoded 32-byte key and retry.");
  }
  try { return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]); }
  catch {
    throw authFailure(500, "credential_encryption_key_invalid", "The Worker encryption secret is invalid. Set a base64-encoded 32-byte key and retry.");
  }
}
async function encrypt(env: AuthEnv, secret: string): Promise<{ cipher: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), encoder.encode(secret));
  return { cipher: b64(new Uint8Array(cipher)), iv: b64(iv) };
}
async function decryptValue(env: AuthEnv, cipher: string, iv: string): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv) },
    await aesKey(env), unb64(cipher));
  return new TextDecoder().decode(plain);
}
async function hash(v: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(v))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function cacheKey(row: Credential & { agent_registration_version?: number }): string {
  // Tenant scope and asserted username prevent cached JWTs crossing orgs or
  // execution identities; metadata-user registration changes the version.
  const version = row.agent_registration_version === undefined ? "" : String(row.agent_registration_version);
  return [row.team_id, row.org_id, row.channel_id, row.instance_url, row.integration_username,
    row.is_sandbox, version].join("\u0000");
}

function jwtRow(row: Credential): row is Credential & { integration_username: string; is_sandbox: number } {
  return typeof row.integration_username === "string" && row.integration_username.length > 0 &&
    (row.is_sandbox === 0 || row.is_sandbox === 1);
}
function clearChannelTokens(k: Key): void {
  const prefix = [k.teamId, k.orgId, k.channelId].join("\u0000") + "\u0000";
  for (const cacheEntry of tokenCache.keys()) {
    if (cacheEntry.startsWith(prefix)) tokenCache.delete(cacheEntry);
  }
}
function sameSalesforceId(actual: unknown, expected: string): boolean {
  return typeof actual === "string" &&
    /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(actual) &&
    /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(expected) &&
    actual.slice(0, 15) === expected.slice(0, 15);
}

function selfOAuthCacheKey(row: Pick<SelfOAuthCredential, "team_id" | "org_id" | "client_id" | "refresh_token_iv">): string {
  return [row.team_id, row.org_id, row.client_id, row.refresh_token_iv].join("\u0000");
}

function selfReturnUrl(instanceUrl: string): string {
  return salesforceReturnUrl(instanceUrl);
}

async function selfOAuthStart(env: AuthEnv, body: Record<string, unknown>): Promise<{ authorizationUrl: string }> {
  const grant = selfOAuthGrantOrNull(body);
  if (!grant || !validSalesforceUserId(body.salesforceUserId) || !str(body.clientId, 255) ||
      !str(body.instanceUrl, 512) || !validInstanceUrl(body.instanceUrl) ||
      !str(body.redirectUri, 2048) || !validSelfOAuthCallbackUrl(body.redirectUri)) {
    throw authFailure(403, "self_oauth_not_authorized", "A valid Panel grant and Salesforce org connection request are required.");
  }

  const instanceUrl = new URL(body.instanceUrl).origin;
  const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
  const encryptedVerifier = await encrypt(env, verifier);
  const now = Math.floor(Date.now() / 1000);
  const returnUrl = selfReturnUrl(instanceUrl);
  await env.DB.prepare(`DELETE FROM salesforce_self_oauth_pending WHERE expires_at <= ?`).bind(now).run();
  await env.DB.prepare(`INSERT INTO salesforce_self_oauth_pending
    (state_hash, team_id, org_id, instance_url, client_id, redirect_uri, return_url,
     salesforce_user_id, code_verifier_cipher, code_verifier_iv,
     created_at, expires_at, consumed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
    .bind(await hash(state), grant.teamId, grant.orgId, instanceUrl, body.clientId, body.redirectUri,
      returnUrl, body.salesforceUserId, encryptedVerifier.cipher, encryptedVerifier.iv,
      now, now + SELF_OAUTH_PENDING_SECONDS).run();

  const authorizeUrl = new URL("/services/oauth2/authorize", instanceUrl);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: body.clientId,
    redirect_uri: body.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "api refresh_token openid",
  }).toString();
  return { authorizationUrl: authorizeUrl.toString() };
}

async function verifySelfSalesforceIdentity(accessToken: string, instanceUrl: string, row: SelfOAuthPending): Promise<string> {
  let response: Response;
  try {
    response = await fetch(instanceUrl + "/services/oauth2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
  } catch {
    throw authFailure(503, "salesforce_identity_unavailable", "Salesforce identity verification is temporarily unavailable. Retry the connection.", true);
  }
  if (!response.ok) {
    throw authFailure(response.status === 429 || response.status >= 500 ? 503 : 422,
      "salesforce_identity_failed", "Salesforce could not verify the authorized org and user. Check ECA API and identity scopes.",
      response.status === 429 || response.status >= 500);
  }
  let identity: unknown;
  try { identity = await response.json(); }
  catch { throw authFailure(502, "salesforce_identity_invalid_response", "Salesforce returned an invalid identity response. Retry the connection.", true); }
  if (!object(identity) || !sameSalesforceId(identity.organization_id, row.org_id) ||
      !sameSalesforceId(identity.user_id, row.salesforce_user_id)) {
    throw authFailure(422, "salesforce_identity_mismatch", "The Salesforce authorization belongs to a different org or user. Start again from the intended org.");
  }
  const tokenInstance = typeof identity.urls === "object" && identity.urls !== null &&
    typeof (identity.urls as Record<string, unknown>).custom_domain === "string"
    ? (identity.urls as Record<string, string>).custom_domain : instanceUrl;
  if (!validInstanceUrl(tokenInstance)) return instanceUrl;
  return new URL(tokenInstance).origin;
}

function selfOAuthReturn(row: SelfOAuthPending, result: "connected" | "error", code?: string): string {
  const target = new URL(row.return_url);
  target.searchParams.set("selfOrgOAuth", result);
  if (code) target.searchParams.set("selfOrgOAuthError", code);
  return target.toString();
}

async function verifySelfSalesforceSettingsAccess(accessToken: string, instanceUrl: string, row: SelfOAuthPending): Promise<void> {
  let response: Response;
  try {
    response = await fetch(instanceUrl + "/services/apexrest/tubot/panel-settings-access/v1", {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      redirect: "manual",
    });
  } catch {
    throw authFailure(503, "salesforce_settings_access_unavailable", "Salesforce settings permission could not be verified. Retry the connection.", true);
  }
  let access: unknown;
  try { access = await response.json(); } catch { access = null; }
  if (!response.ok || !object(access) || access.authorized !== true ||
      !sameSalesforceId(access.organization_id, row.org_id) || !sameSalesforceId(access.user_id, row.salesforce_user_id)) {
    throw authFailure(403, "salesforce_settings_access_denied", "Upgrade the TuBot package and connect as a user directly assigned Panel Settings Admin Access.");
  }
}

async function completeSelfOAuth(env: AuthEnv, body: Record<string, unknown>): Promise<{ redirectUrl: string }> {
  if (!str(body.state, 256)) throw authFailure(400, "invalid_oauth_state", "The Salesforce authorization state is invalid or expired.");
  const stateHash = await hash(body.state);
  const now = Math.floor(Date.now() / 1000);
  const pending = await env.DB.prepare(`UPDATE salesforce_self_oauth_pending SET consumed_at = ?
    WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?
    RETURNING *`).bind(now, stateHash, now).first<SelfOAuthPending>();
  if (!pending) throw authFailure(400, "invalid_oauth_state", "The Salesforce authorization state is invalid or expired.");

  if (str(body.error, 128)) return { redirectUrl: selfOAuthReturn(pending, "error", "authorization_denied") };
  if (!str(body.code, 4096)) return { redirectUrl: selfOAuthReturn(pending, "error", "authorization_incomplete") };
  try {
    const verifier = await decryptValue(env, pending.code_verifier_cipher, pending.code_verifier_iv);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: body.code,
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      code_verifier: verifier,
    });
    let response: Response;
    try {
      response = await fetch(pending.instance_url + "/services/oauth2/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form,
      });
    } catch {
      return { redirectUrl: selfOAuthReturn(pending, "error", "salesforce_unavailable") };
    }
    let data: unknown;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok || !object(data) || !str(data.access_token, 4096) || !str(data.refresh_token, 4096)) {
      return { redirectUrl: selfOAuthReturn(pending, "error", "token_exchange_failed") };
    }
    const identityInstance = typeof data.instance_url === "string" && validInstanceUrl(data.instance_url)
      ? new URL(data.instance_url).origin : pending.instance_url;
    let instanceUrl: string;
    try {
      instanceUrl = await verifySelfSalesforceIdentity(data.access_token, identityInstance, pending);
      await verifySelfSalesforceSettingsAccess(data.access_token, instanceUrl, pending);
    } catch (error) {
      // Denied grants must not remain usable in Salesforce after a failed connection.
      try {
        await fetch(identityInstance + "/services/oauth2/revoke", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: data.refresh_token }), redirect: "manual",
        });
      } catch { /* The connection still fails closed; no credential is persisted. */ }
      throw error;
    }
    const refreshToken = await encrypt(env, data.refresh_token);
    const timestamp = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`INSERT INTO salesforce_self_oauth_credential
      (team_id, org_id, instance_url, client_id, salesforce_user_id, refresh_token_cipher,
       refresh_token_iv, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, org_id) DO UPDATE SET instance_url=excluded.instance_url,
        client_id=excluded.client_id, salesforce_user_id=excluded.salesforce_user_id,
        refresh_token_cipher=excluded.refresh_token_cipher, refresh_token_iv=excluded.refresh_token_iv,
        updated_at=excluded.updated_at`)
      .bind(pending.team_id, pending.org_id, instanceUrl, pending.client_id, pending.salesforce_user_id,
        refreshToken.cipher, refreshToken.iv, timestamp, timestamp).run();
    return { redirectUrl: selfOAuthReturn(pending, "connected") };
  } catch (err) {
    const code = err instanceof AuthFailure ? err.failure.code : "authorization_failed";
    console.error(JSON.stringify({ error: "self_salesforce_oauth_completion_failed", code }));
    return { redirectUrl: selfOAuthReturn(pending, "error", code) };
  }
}

async function selfOAuthStatus(env: AuthEnv, grant: { teamId: string; orgId: string }): Promise<{
  connected: boolean; orgId: string; salesforceUserId?: string; instanceUrl?: string;
}> {
  const row = await env.DB.prepare(`SELECT salesforce_user_id, instance_url FROM salesforce_self_oauth_credential
    WHERE team_id = ? AND org_id = ? LIMIT 1`).bind(grant.teamId, grant.orgId)
    .first<{ salesforce_user_id: string; instance_url: string }>();
  return {
    connected: !!row,
    orgId: grant.orgId,
    ...(row ? { salesforceUserId: row.salesforce_user_id, instanceUrl: row.instance_url } : {}),
  };
}

async function selfOAuthToken(env: AuthEnv, grant: { teamId: string; orgId: string }): Promise<{ accessToken: string; instanceUrl: string; expiresIn: number }> {
  const row = await env.DB.prepare(`SELECT * FROM salesforce_self_oauth_credential
    WHERE team_id = ? AND org_id = ? LIMIT 1`).bind(grant.teamId, grant.orgId)
    .first<SelfOAuthCredential>();
  if (!row) throw authFailure(404, "self_oauth_not_connected", "Connect this Salesforce org before running Salesforce API actions.");
  const cacheKey = selfOAuthCacheKey(row);
  const cached = selfTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return { accessToken: cached.accessToken, instanceUrl: row.instance_url, expiresIn: Math.floor((cached.expiresAt - Date.now()) / 1000) };
  }
  const refreshToken = await decryptValue(env, row.refresh_token_cipher, row.refresh_token_iv);
  const form = new URLSearchParams({ grant_type: "refresh_token", client_id: row.client_id, refresh_token: refreshToken });
  let response: Response;
  try {
    response = await fetch(row.instance_url + "/services/oauth2/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form,
    });
  } catch {
    throw authFailure(503, "salesforce_oauth_unavailable", "Salesforce OAuth is temporarily unavailable. Retry the API request.", true);
  }
  let data: unknown;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok || !object(data) || !str(data.access_token, 4096)) {
    throw authFailure(response.status === 429 || response.status >= 500 ? 503 : 422,
      "salesforce_refresh_failed", "The Salesforce API connection needs to be reauthorized.", response.status === 429 || response.status >= 500);
  }
  const instanceUrl = typeof data.instance_url === "string" && validInstanceUrl(data.instance_url)
    ? new URL(data.instance_url).origin : row.instance_url;
  if (str(data.refresh_token, 4096) && data.refresh_token !== refreshToken) {
    const encryptedRefresh = await encrypt(env, data.refresh_token);
    await env.DB.prepare(`UPDATE salesforce_self_oauth_credential SET refresh_token_cipher = ?,
      refresh_token_iv = ?, updated_at = ? WHERE team_id = ? AND org_id = ?`)
      .bind(encryptedRefresh.cipher, encryptedRefresh.iv, Math.floor(Date.now() / 1000), grant.teamId, grant.orgId).run();
    selfTokenCache.delete(cacheKey);
    row.refresh_token_cipher = encryptedRefresh.cipher;
    row.refresh_token_iv = encryptedRefresh.iv;
  }
  if (instanceUrl !== row.instance_url) {
    await env.DB.prepare(`UPDATE salesforce_self_oauth_credential SET instance_url = ?, updated_at = ?
      WHERE team_id = ? AND org_id = ?`).bind(instanceUrl, Math.floor(Date.now() / 1000), grant.teamId, grant.orgId).run();
    row.instance_url = instanceUrl;
  }
  const seconds = typeof data.expires_in === "number" && data.expires_in > 0 ? Math.min(data.expires_in, 300) : 120;
  const token = { accessToken: data.access_token, expiresAt: Date.now() + seconds * 1000 };
  selfTokenCache.set(selfOAuthCacheKey(row), token);
  return { accessToken: token.accessToken, instanceUrl, expiresIn: seconds };
}

function validSelfOAuthApiPath(value: unknown): value is string {
  if (!str(value, 8192) || !value.startsWith("/services/") || value.startsWith("//") || value.includes("\\")) return false;
  try {
    const url = new URL(value, "https://salesforce.invalid");
    return url.origin === "https://salesforce.invalid" && !url.username && !url.password && !url.hash &&
      (url.pathname.startsWith("/services/data/") || /^\/services\/Soap\/(?:m|u)\/\d+\.\d+$/.test(url.pathname));
  } catch { return false; }
}

async function selfOAuthApiRequest(
  env: AuthEnv,
  grant: { teamId: string; orgId: string },
  body: Record<string, unknown>,
  requestId: string,
): Promise<Response> {
  const method = typeof body.method === "string" ? body.method.toUpperCase() : "";
  const requestBody = body.requestBody;
  const requestedHeaders = object(body.headers) ? body.headers : {};
  if (!validSelfOAuthApiPath(body.path) || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
      (requestBody !== null && requestBody !== undefined && typeof requestBody !== "string") ||
      (typeof requestBody === "string" && requestBody.length > 5_500_000)) {
    throw authFailure(400, "invalid_salesforce_request", "The Salesforce API request is invalid or exceeds the supported size.");
  }
  const headers = new Headers({ Accept: "application/json" });
  const contentType = requestedHeaders.contentType;
  if (typeof contentType === "string" && /^(?:application\/json|application\/xml|text\/xml)(?:\s*;\s*charset=[A-Za-z0-9._-]+)?$/i.test(contentType)) {
    headers.set("Content-Type", contentType);
  }
  const accept = requestedHeaders.accept;
  if (typeof accept === "string" && /^(?:application\/json|application\/xml|text\/xml)(?:\s*;\s*charset=[A-Za-z0-9._-]+)?$/i.test(accept)) {
    headers.set("Accept", accept);
  }
  const soapAction = requestedHeaders.soapAction;
  if (typeof soapAction === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(soapAction)) headers.set("SOAPAction", soapAction);

  for (let attempt = 0; attempt < 2; attempt++) {
    const auth = await selfOAuthToken(env, grant);
    let response: Response;
    try {
      const outgoingHeaders = new Headers(headers);
      outgoingHeaders.set("Authorization", `Bearer ${auth.accessToken}`);
      const outgoingBody = injectSoapSession(body.path, requestBody, auth.accessToken);
      response = await fetch(auth.instanceUrl + body.path, {
        method,
        headers: outgoingHeaders,
        ...(typeof outgoingBody === "string" ? { body: outgoingBody } : {}),
      });
    } catch {
      throw authFailure(503, "salesforce_request_unavailable", "Salesforce could not complete the API request. Retry it shortly.", true);
    }
    if (response.status === 401 && attempt === 0) {
      const current = await env.DB.prepare(`SELECT team_id, org_id, client_id, refresh_token_iv
        FROM salesforce_self_oauth_credential WHERE team_id = ? AND org_id = ? LIMIT 1`).bind(grant.teamId, grant.orgId)
        .first<Pick<SelfOAuthCredential, "team_id" | "org_id" | "client_id" | "refresh_token_iv">>();
      if (current) selfTokenCache.delete(selfOAuthCacheKey(current));
      continue;
    }
    const responseHeaders = new Headers({
      "Content-Type": response.headers.get("Content-Type") || "application/json",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "X-Request-Id": requestId,
      "X-Self-OAuth-Upstream": "salesforce",
    });
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  }
  throw authFailure(503, "salesforce_request_unavailable", "Salesforce could not complete the API request. Retry it shortly.", true);
}

const SALESFORCE_BATCH_METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);
const SALESFORCE_BATCH_RESOURCES = /^(?:limits(?:\?|$)|(?:query|queryAll)(?:\/[A-Za-z0-9_-]+)?(?:\?|$)|search\/\?|sobjects\/[A-Za-z][A-Za-z0-9_]*(?:\/[^?#]*)?(?:\?|$)|connect\/[^?#]+(?:\?|$)|chatter\/[^?#]+(?:\?|$)|actions\/(?:standard|custom)\/[^?#]+(?:\?|$))/;

function validSelfOAuthBatchRequest(value: unknown, apiVersion: string): value is Record<string, unknown> & {
  method: string; url: string; richInput?: unknown;
} {
  if (!object(value) || typeof value.method !== "string" || !SALESFORCE_BATCH_METHODS.has(value.method) ||
      typeof value.url !== "string" || value.url.length > 8192 ||
      /[\\#\u0000-\u001f\u007f]/.test(value.url) || value.url.startsWith("/") || value.url.includes("//")) return false;
  const prefix = `v${apiVersion}/`;
  if (!value.url.startsWith(prefix)) return false;
  const remainder = value.url.slice(prefix.length);
  const path = remainder.split("?", 1)[0];
  if (!SALESFORCE_BATCH_RESOURCES.test(remainder)) return false;
  for (const part of path.split("/")) {
    let decoded: string;
    try { decoded = decodeURIComponent(part); } catch { return false; }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return false;
  }
  if (value.method === "GET") return value.richInput === undefined;
  if (value.richInput === undefined) return value.method === "DELETE";
  try {
    const serialized = JSON.stringify(value.richInput);
    return serialized !== undefined && serialized.length <= 64_000 &&
      (object(value.richInput) || Array.isArray(value.richInput));
  } catch { return false; }
}

async function selfOAuthApiBatch(
  env: AuthEnv,
  grant: SelfOAuthGrant,
  body: Record<string, unknown>,
  requestId: string,
): Promise<Response> {
  const apiVersion = typeof body.apiVersion === "string" ? body.apiVersion.replace(/^v/, "") : "";
  const versionNumber = Number(apiVersion);
  if (!/^\d{2,3}(?:\.\d{1,2})?$/.test(apiVersion) || !Number.isFinite(versionNumber) || versionNumber < 34 ||
      !Array.isArray(body.batchRequests) || body.batchRequests.length < 1 || body.batchRequests.length > 25 ||
      (body.haltOnError !== undefined && typeof body.haltOnError !== "boolean") ||
      !body.batchRequests.every(item => validSelfOAuthBatchRequest(item, apiVersion))) {
    throw authFailure(400, "invalid_salesforce_batch", "The Salesforce batch must contain 1 to 25 supported, org-relative API requests.");
  }
  const payload = {
    batchRequests: body.batchRequests,
    ...(typeof body.haltOnError === "boolean" ? { haltOnError: body.haltOnError } : {}),
  };
  return selfOAuthApiRequest(env, grant, {
    method: "POST",
    path: `/services/data/v${apiVersion}/composite/batch`,
    requestBody: JSON.stringify(payload),
    headers: { contentType: "application/json", accept: "application/json" },
  }, requestId);
}

async function selfOAuthDisconnect(env: AuthEnv, grant: { teamId: string; orgId: string }): Promise<void> {
  const row = await env.DB.prepare(`SELECT * FROM salesforce_self_oauth_credential
    WHERE team_id = ? AND org_id = ? LIMIT 1`).bind(grant.teamId, grant.orgId)
    .first<SelfOAuthCredential>();
  if (!row) return;
  const refreshToken = await decryptValue(env, row.refresh_token_cipher, row.refresh_token_iv);
  let response: Response;
  try {
    response = await fetch(row.instance_url + "/services/oauth2/revoke", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw authFailure(502, "salesforce_revoke_unconfirmed", "Salesforce could not be reached to revoke the stored grant; the connection was retained so disconnect can be retried.", true);
  }
  if (!response.ok) {
    throw authFailure(502, "salesforce_revoke_unconfirmed", "Salesforce did not confirm revocation; the connection was retained so disconnect can be retried.", true);
  }
  selfTokenCache.delete(selfOAuthCacheKey(row));
  await env.DB.prepare(`DELETE FROM salesforce_self_oauth_credential WHERE team_id = ? AND org_id = ?`)
    .bind(grant.teamId, grant.orgId).run();
}

async function hasOtherTeamOrgData(env: AuthEnv, scope: { teamId: string; orgId: string }): Promise<boolean> {
  const tables = [
    "panel_salesforce_channels",
    "panel_salesforce_execution_users",
    "panel_salesforce_setup_oauth_pending",
    "salesforce_self_oauth_credential",
    "salesforce_self_oauth_pending",
    "sf_agent_snapshot_chunk",
    "sf_agent_snapshot_file",
    "sf_agent_snapshot_job",
    "sf_agent_metadata_user",
    "action_graph_context",
    "sf_user_data_cache_v2",
    "panel_messaging_proxies",
    "panel_org_oauth_clients",
    "panel_routing_backups",
    "panel_activate_tokens",
  ];
  for (const table of tables) {
    const exists = await env.DB.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
      .bind(table).first<{ present: number }>();
    if (!exists) continue;
    const rows = await env.DB.prepare(`SELECT 1 AS present FROM ${table}
      WHERE org_id=? AND team_id<>? LIMIT 1`).bind(scope.orgId, scope.teamId).first<{ present: number }>();
    if (rows) return true;
  }
  return false;
}

async function cleanupSalesforceOrg(
  env: AuthEnv,
  scope: { teamId: string; orgId: string },
): Promise<{ deleted: Record<string, number>; remaining: Record<string, number>; remoteRevocation: { attempted: boolean; confirmed: boolean; status: number | null } }> {
  if (await hasOtherTeamOrgData(env, scope)) {
    throw authFailure(409, "org_cleanup_conflict", "This Salesforce org still has TuBot data owned by another Panel team. Remove that team's connection first.");
  }
  const oauth = await env.DB.prepare(`SELECT * FROM salesforce_self_oauth_credential
    WHERE team_id = ? AND org_id = ? LIMIT 1`).bind(scope.teamId, scope.orgId)
    .first<SelfOAuthCredential>();
  let remoteStatus: number | null = null;
  if (oauth) {
    try {
      const refreshToken = await decryptValue(env, oauth.refresh_token_cipher, oauth.refresh_token_iv);
      const response = await fetch(oauth.instance_url + "/services/oauth2/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }),
        signal: AbortSignal.timeout(10_000),
      });
      remoteStatus = response.status;
      if (!response.ok) {
        throw authFailure(502, "salesforce_revoke_unconfirmed", "Salesforce did not confirm revocation; the stored grant was retained so teardown can be retried.");
      }
    } catch {
      if (remoteStatus === null) {
        throw authFailure(502, "salesforce_revoke_unconfirmed", "Salesforce could not be reached to revoke the stored grant; teardown can be retried.");
      }
      throw authFailure(502, "salesforce_revoke_unconfirmed", "Salesforce did not confirm revocation; the stored grant was retained so teardown can be retried.");
    }
    selfTokenCache.delete(selfOAuthCacheKey(oauth));
  }

  const channels = await env.DB.prepare(`SELECT channel_id FROM panel_salesforce_channels
    WHERE team_id = ? AND org_id = ?`).bind(scope.teamId, scope.orgId)
    .all<{ channel_id: string }>();
  for (const row of channels.results ?? []) {
    clearChannelTokens({ teamId: scope.teamId, orgId: scope.orgId, channelId: row.channel_id });
    panelCredentialCache.delete(panelCredentialCacheKey(
      { teamId: scope.teamId, orgId: scope.orgId, channelId: row.channel_id }));
  }

  const namedStatements: Array<[string, D1PreparedStatement]> = [
    ["agent_snapshot_chunks", env.DB.prepare(`DELETE FROM sf_agent_snapshot_chunk WHERE team_id=? AND org_id=?`).bind(scope.teamId, scope.orgId)],
    ["agent_snapshot_files", env.DB.prepare(`DELETE FROM sf_agent_snapshot_file WHERE team_id=? AND org_id=?`).bind(scope.teamId, scope.orgId)],
    ["agent_snapshot_jobs", env.DB.prepare(`DELETE FROM sf_agent_snapshot_job WHERE team_id=? AND org_id=?`).bind(scope.teamId, scope.orgId)],
    ["agent_metadata_users", env.DB.prepare(`DELETE FROM sf_agent_metadata_user WHERE team_id=? AND org_id=?`).bind(scope.teamId, scope.orgId)],
    ["action_graph_context", env.DB.prepare(`DELETE FROM action_graph_context WHERE team_id=? AND org_id=?`).bind(scope.teamId, scope.orgId)],
    ["self_oauth_pending", env.DB.prepare(`DELETE FROM salesforce_self_oauth_pending WHERE team_id=? AND org_id=?`).bind(scope.teamId, scope.orgId)],
    ["panel_setup_oauth_pending", env.DB.prepare(`DELETE FROM panel_salesforce_setup_oauth_pending WHERE team_id=? AND org_id=?`).bind(scope.teamId, scope.orgId)],
    ["self_oauth_credentials", env.DB.prepare(`DELETE FROM salesforce_self_oauth_credential WHERE team_id=? AND org_id=?`).bind(scope.teamId, scope.orgId)],
    ["panel_execution_users", env.DB.prepare(`DELETE FROM panel_salesforce_execution_users WHERE team_id=? AND org_id=?`).bind(scope.teamId, scope.orgId)],
    ["panel_channels", env.DB.prepare(`DELETE FROM panel_salesforce_channels WHERE team_id=? AND org_id=?`).bind(scope.teamId, scope.orgId)],
  ];
  const cache = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sf_user_data_cache_v2'`)
    .first<{ name: string }>();
  if (cache) {
    namedStatements.push(["user_data_cache", env.DB.prepare(`DELETE FROM sf_user_data_cache_v2 WHERE team_id=? AND org_id=?`)
      .bind(scope.teamId, scope.orgId)]);
  }
  const optionalTenantTables: Array<[string, string]> = [
    ["org_oauth_clients", "panel_org_oauth_clients"],
    ["routing_backups", "panel_routing_backups"],
    ["activate_tokens", "panel_activate_tokens"],
  ];
  const presentOptionalTables: string[] = [];
  for (const [label, table] of optionalTenantTables) {
    const exists = await env.DB.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
      .bind(table).first<{ present: number }>();
    if (!exists) continue;
    presentOptionalTables.push(table);
    namedStatements.push([label, env.DB.prepare(`DELETE FROM ${table} WHERE team_id=? AND org_id=?`)
      .bind(scope.teamId, scope.orgId)]);
  }
  const data360Tables = [
    "data360_user_cache",
    "data360_session_cache",
    "data360_conversation_cache",
    "data360_global_cache",
    "data360_agent_code_cache",
    "data360_tool_urls_cache",
  ];
  const presentData360Tables: string[] = [];
  for (const table of data360Tables) {
    const exists = await env.DB.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
      .bind(table).first<{ present: number }>();
    if (!exists) continue;
    presentData360Tables.push(table);
    namedStatements.push([`data360:${table}`, env.DB.prepare(`DELETE FROM ${table} WHERE org_id=?`).bind(scope.orgId)]);
  }
  const results = await env.DB.batch(namedStatements.map(([, statement]) => statement));
  const deleted = Object.fromEntries(namedStatements.map(([name], index) => [name, results[index]?.meta.changes ?? 0]));

  const remaining: Record<string, number> = {};
  const checks: Array<[string, string, string]> = [
    ["agent_snapshot_chunks", "sf_agent_snapshot_chunk", "team_id=? AND org_id=?"],
    ["agent_snapshot_files", "sf_agent_snapshot_file", "team_id=? AND org_id=?"],
    ["agent_snapshot_jobs", "sf_agent_snapshot_job", "team_id=? AND org_id=?"],
    ["agent_metadata_users", "sf_agent_metadata_user", "team_id=? AND org_id=?"],
    ["action_graph_context", "action_graph_context", "team_id=? AND org_id=?"],
    ["self_oauth_pending", "salesforce_self_oauth_pending", "team_id=? AND org_id=?"],
    ["panel_setup_oauth_pending", "panel_salesforce_setup_oauth_pending", "team_id=? AND org_id=?"],
    ["self_oauth_credentials", "salesforce_self_oauth_credential", "team_id=? AND org_id=?"],
    ["panel_execution_users", "panel_salesforce_execution_users", "team_id=? AND org_id=?"],
    ["panel_channels", "panel_salesforce_channels", "team_id=? AND org_id=?"],
  ];
  if (cache) checks.push(["user_data_cache", "sf_user_data_cache_v2", "team_id=? AND org_id=?"]);
  for (const table of presentOptionalTables) {
    const label = optionalTenantTables.find(([, name]) => name === table)?.[0] ?? table;
    checks.push([label, table, "team_id=? AND org_id=?"]);
  }
  for (const table of presentData360Tables) checks.push([`data360:${table}`, table, "org_id=?"]);
  for (const [label, table, where] of checks) {
    const statement = where === "org_id=?"
      ? env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).bind(scope.orgId)
      : env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).bind(scope.teamId, scope.orgId);
    const row = await statement.first<{ count: number }>();
    remaining[label] = Number(row?.count ?? 0);
  }
  return {
    deleted,
    remaining,
    remoteRevocation: { attempted: !!oauth, confirmed: !oauth || (remoteStatus !== null && remoteStatus >= 200 && remoteStatus < 300), status: remoteStatus },
  };
}

function selfOAuthGrantOrNull(body: Record<string, unknown>): SelfOAuthGrant | null {
  // These routes are HMAC-verified before this function runs. New Panel supplies
  // the authenticated team and org; there is no legacy token-table fallback.
  if (str(body.teamId, 128) && validSalesforceOrgId(body.orgId)) {
    return { teamId: body.teamId, orgId: body.orgId };
  }
  return null;
}

async function verifySignedSelfOAuthRequest(request: Request, env: AuthEnv, path: string): Promise<boolean> {
  const serviceSecrets = [env.SELF_OAUTH_NEW_PANEL_HMAC_KEY];
  const secrets = serviceSecrets.filter((secret): secret is string => typeof secret === "string" && secret.length >= 32);
  if (secrets.length === 0) {
    throw authFailure(503, "self_oauth_signing_not_configured", "Internal Salesforce authorization is not configured.");
  }
  const timestampHeader = request.headers.get("x-tubot-sf-auth-timestamp") || "";
  const nonce = request.headers.get("x-tubot-sf-auth-nonce") || "";
  const suppliedSignature = request.headers.get("x-tubot-sf-auth-signature") || "";
  const timestamp = Number(timestampHeader);
  if (!/^\d{10}$/.test(timestampHeader) || !Number.isSafeInteger(timestamp) ||
      Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 60 ||
      !/^[A-Za-z0-9_-]{24}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(suppliedSignature)) return false;
  const maxBytes = path === "/internal/self-oauth/request" ? 10_000_000 :
    path === "/internal/self-oauth/batch" ? 512_000 : 64_000;
  const contentLength = Number(request.headers.get("Content-Length") || "0");
  if (contentLength > maxBytes) return false;
  const rawBody = await readBodyBounded(request.clone(), maxBytes);
  const bodyDigest = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", rawBody)));
  const target = new URL(request.url);
  const canonical = `${request.method}\n${target.pathname}${target.search}\n${timestampHeader}\n${nonce}\n${bodyDigest}`;
  let signatureValid = false;
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expectedSignature = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(canonical))));
    signatureValid = equalHash(expectedSignature, suppliedSignature) || signatureValid;
  }
  if (!signatureValid) return false;

  const now = Math.floor(Date.now() / 1000);
  const nonceHash = await hash(nonce);
  await maybePurgeRpcNonces(env.DB, now);
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO salesforce_self_oauth_internal_nonce
    (nonce_hash, expires_at) VALUES (?, ?)`)
    .bind(nonceHash, now + 120).run();
  return inserted.meta.changes === 1;
}

type PanelCredentialDbRow = {
  team_id: string;
  org_id: string;
  channel_id: string;
  instance_url: string | null;
  integration_user_id: string | null;
  integration_username: string | null;
  is_sandbox: number | null;
  client_id: string | null;
};

function panelCredentialCacheKey(scope: Key): string {
  return [scope.teamId, scope.orgId, scope.channelId].join("\u0000");
}

function credentialFromRow(row: PanelCredentialDbRow): Credential {
  if (!row.instance_url || !validInstanceUrl(row.instance_url) || !row.integration_user_id ||
      !row.integration_username || (row.is_sandbox !== 0 && row.is_sandbox !== 1)) {
    throw authFailure(500, "credential_misconfigured", "The stored Salesforce channel credential is incomplete.", false);
  }
  return {
    team_id: row.team_id,
    org_id: row.org_id,
    channel_id: row.channel_id,
    instance_url: new URL(row.instance_url).origin,
    integration_user_id: row.integration_user_id,
    integration_username: row.integration_username,
    is_sandbox: row.is_sandbox,
    client_id: row.client_id,
  };
}

function cachePanelCredential(scope: Key, credential: Credential): void {
  if (panelCredentialCache.size >= PANEL_CREDENTIAL_CACHE_CAP) panelCredentialCache.clear();
  panelCredentialCache.set(panelCredentialCacheKey(scope), { at: Date.now(), row: credential });
}

async function panelCredential(env: AuthEnv, scope: Key): Promise<Credential | null> {
  const hit = panelCredentialCache.get(panelCredentialCacheKey(scope));
  if (hit && Date.now() - hit.at < PANEL_CREDENTIAL_TTL_MS) return hit.row;
  const row = await env.DB.prepare(`SELECT team_id, org_id, channel_id, instance_url,
      integration_user_id, integration_username, is_sandbox, client_id
    FROM panel_salesforce_channels
    WHERE team_id = ? AND org_id = ? AND channel_id = ? LIMIT 1`)
    .bind(scope.teamId, scope.orgId, scope.channelId)
    .first<PanelCredentialDbRow>();
  if (!row) return null;
  const credential = credentialFromRow(row);
  cachePanelCredential(scope, credential);
  return credential;
}

async function panelExecutionUserCredential(
  env: AuthEnv,
  scope: Key,
  integrationUserId: string,
): Promise<Credential | null> {
  const row = await env.DB.prepare(`SELECT e.team_id, e.org_id, e.channel_id, e.integration_user_id,
      c.instance_url, c.integration_username, c.is_sandbox, c.client_id
    FROM panel_salesforce_execution_users e
    JOIN panel_salesforce_channels c ON c.team_id=e.team_id AND c.org_id=e.org_id AND c.channel_id=e.channel_id
    WHERE e.team_id=? AND e.org_id=? AND e.channel_id=? AND substr(e.integration_user_id, 1, 15)=? LIMIT 1`)
    .bind(scope.teamId, scope.orgId, scope.channelId, integrationUserId.slice(0, 15))
    .first<PanelCredentialDbRow>();
  if (!row || !sameSalesforceId(row.integration_user_id, integrationUserId)) return null;
  if (!row.instance_url || !validInstanceUrl(row.instance_url) || !row.integration_user_id ||
      !row.integration_username || (row.is_sandbox !== 0 && row.is_sandbox !== 1)) {
    throw authFailure(500, "credential_misconfigured", "The stored Salesforce execution credential is incomplete.", false);
  }
  return {
    team_id: row.team_id,
    org_id: row.org_id,
    channel_id: row.channel_id,
    instance_url: new URL(row.instance_url).origin,
    integration_user_id: row.integration_user_id,
    integration_username: row.integration_username,
    is_sandbox: row.is_sandbox,
    client_id: row.client_id,
  };
}

export async function credentialForEntrypoint(env: AuthEnv, ref: Key): Promise<Credential> {
  const row = await panelCredential(env, ref);
  if (!row) throw authFailure(404, "channel_not_found", "The Salesforce channel is unavailable.");
  return row;
}

async function activeChannelExecutionUsers(env: AuthEnv, channelId: string): Promise<ExecutionUserReference[]> {
  if (!validSalesforceChannelId(channelId)) {
    throw authFailure(400, "invalid_channel_id", "A valid Salesforce Messaging Channel ID is required.");
  }
  const prefix = channelId.slice(0, 15);
  const rows = await env.DB.prepare(`
    SELECT team_id AS teamId, org_id AS orgId, channel_id AS channelId,
      integration_user_id AS integrationUserId, is_primary AS isPrimary
    FROM panel_salesforce_execution_users
    WHERE substr(channel_id, 1, 15)=?
    ORDER BY isPrimary DESC, integrationUserId ASC
  `).bind(prefix).all<ExecutionUserDbRow>();
  const result: ExecutionUserReference[] = [];
  const seenUsers = new Set<string>();
  for (const row of rows.results ?? []) {
    const userKey = `${row.teamId}\u0000${row.orgId}\u0000${row.channelId}\u0000${row.integrationUserId.slice(0, 15)}`;
    if (seenUsers.has(userKey)) continue;
    seenUsers.add(userKey);
    result.push({ ...row, isPrimary: row.isPrimary === 1 });
  }
  if (result.length === 0) {
    throw authFailure(404, "channel_not_found", "No active Salesforce credentials are configured for this channel.");
  }
  const scopes = new Set(result.map(row => `${row.teamId}\u0000${row.orgId}\u0000${row.channelId}`));
  if (scopes.size !== 1) {
    throw authFailure(409, "channel_org_ambiguous", "More than one connected Salesforce org matches this channel.");
  }
  return result;
}

async function activeExecutionCredential(env: AuthEnv, scope: Key, integrationUserId: string): Promise<Credential | null> {
  const primary = await panelCredential(env, scope);
  if (primary && sameSalesforceId(primary.integration_user_id, integrationUserId)) return primary;
  return panelExecutionUserCredential(env, scope, integrationUserId);
}

function validSalesforceChannelId(value: string): boolean {
  return /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(value);
}

export async function token(env: AuthEnv, row: Credential): Promise<Token> {
  const id = cacheKey(row);
  const cached = tokenCache.get(id);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached;
  // Single-flight: parallel waves share one cold-cache token POST per
  // credential instead of stampeding the OAuth endpoint (a stampede
  // bursts invalid_grant noise that poisons action verdicts downstream).
  // Failures are never cached: the waiter rethrows and the next caller
  // retries with a fresh POST.
  const inflight = tokenInflight.get(id);
  if (inflight) return inflight;
  const pending = fetchToken(env, row, id).finally(() => {
    if (tokenInflight.get(id) === pending) tokenInflight.delete(id);
  });
  tokenInflight.set(id, pending);
  return pending;
}

async function fetchToken(env: AuthEnv, row: Credential, id: string, cacheResult = true): Promise<Token> {
  if (!jwtRow(row)) {
    throw authFailure(500, "credential_misconfigured", "The Salesforce channel is missing its verified execution user. Reconnect the channel.", false);
  }
  let assertion: string;
  try {
    const clientId = typeof row.client_id === "string" && row.client_id ? row.client_id : undefined;
    if (env.PANEL_JWT_SIGNER) {
      assertion = await env.PANEL_JWT_SIGNER.signAssertion({
        subjectUsername: row.integration_username,
        isSandbox: row.is_sandbox === 1,
        ...(clientId ? { clientId } : {}),
      });
    } else if (env.TUBOT_JWT_PRIVATE_KEY) {
      assertion = await buildJwtAssertion(env.TUBOT_JWT_PRIVATE_KEY, row.integration_username, row.is_sandbox === 1,
        Math.floor(Date.now() / 1000), clientId);
    } else {
      throw new Error("jwt_private_key_misconfigured");
    }
    if (!str(assertion, 8192)) throw new Error("jwt_assertion_invalid");
  } catch (cause) {
    if (cause instanceof Error && cause.message === "jwt_private_key_misconfigured") {
      throw authFailure(500, "jwt_private_key_misconfigured", "JWT signing is misconfigured. Contact support.", false);
    }
    throw authFailure(503, "jwt_signer_unavailable", "JWT signing is temporarily unavailable. Retry the request.", true);
  }
  const form = new URLSearchParams({ grant_type: JWT_BEARER_GRANT_TYPE, assertion });
  let response: Response;
  try {
    response = await fetch(row.instance_url + "/services/oauth2/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form,
    });
  } catch {
    throw authFailure(503, "salesforce_oauth_unavailable", "Salesforce OAuth is temporarily unavailable. Retry the connection.", true);
  }
  if (!response.ok) {
    // Read only Salesforce's stable OAuth error identifier. Never forward or
    // log error_description because it may contain sensitive configuration.
    let oauthCode = "";
    try {
      const details: unknown = await response.clone().json();
      if (object(details) && typeof details.error === "string") oauthCode = details.error;
    } catch { /* use the status-based safe fallback */ }
    if (response.status === 429 || response.status >= 500) {
      throw authFailure(503, "salesforce_oauth_unavailable", "Salesforce OAuth is temporarily unavailable. Retry the connection.", true);
    }
    if (oauthCode === "invalid_app_access" || oauthCode === "invalid_grant") {
      throw authFailure(422, "salesforce_preauth_required", "The integration user is not pre-authorized for the packaged execution client. Run setup-eca-policies.mjs, assign the TuBot JWT PreAuth set, and retry.");
    }
    if (["invalid_grant", "unauthorized_client", "unsupported_grant_type"].includes(oauthCode)) {
      throw authFailure(422, "salesforce_oauth_not_configured", "Salesforce rejected the JWT grant. Check that the packaged execution client is active and the user is pre-authorized.");
    }
    throw authFailure(422, "salesforce_oauth_rejected", "Salesforce rejected the packaged JWT execution client. Check the org setup and retry.");
  }
  let data: unknown;
  try { data = await response.json(); }
  catch {
    throw authFailure(502, "salesforce_oauth_invalid_response", "Salesforce returned an invalid OAuth response. Retry, and contact support if it continues.", true);
  }
  if (!object(data) || !str(data.access_token, 4096)) {
    throw authFailure(502, "salesforce_oauth_invalid_response", "Salesforce returned an invalid OAuth response. Retry, and contact support if it continues.", true);
  }
  const instanceUrl = typeof data.instance_url === "string" && validInstanceUrl(data.instance_url)
    ? new URL(data.instance_url).origin : row.instance_url;
  let identityResponse: Response;
  try {
    identityResponse = await fetch(instanceUrl + "/services/oauth2/userinfo", {
      headers: { Authorization: "Bearer " + data.access_token, Accept: "application/json" },
    });
  } catch {
    throw authFailure(503, "salesforce_identity_unavailable", "Salesforce could not verify the integration user right now. Retry the connection.", true);
  }
  if (!identityResponse.ok) {
    const details = upstreamFailure(identityResponse.status, "salesforce_identity_failed", "Salesforce could not verify the integration user. Check the ECA scopes and retry.");
    throw new AuthFailure(details);
  }
  let identity: unknown;
  try { identity = await identityResponse.json(); }
  catch {
    throw authFailure(502, "salesforce_identity_invalid_response", "Salesforce returned an invalid identity response. Retry, and contact support if it continues.", true);
  }
  if (!object(identity) || !sameSalesforceId(identity.organization_id, row.org_id) ||
      !sameSalesforceId(identity.user_id, row.integration_user_id)) {
    throw authFailure(422, "salesforce_identity_mismatch",
      "The JWT grant resolved to a different Salesforce org or user. Check the selected org and integration username.");
  }
  const seconds = typeof data.expires_in === "number" && data.expires_in > 0
    ? Math.min(data.expires_in, 300) : 120;
  const result = { accessToken: data.access_token, instanceUrl, expiresAt: Date.now() + seconds * 1000 };
  if (cacheResult) tokenCache.set(id, result);
  return result;
}

type JwtApiDiagnosticInput = Key & {
  instanceUrl: string;
  integrationUserId: string;
  integrationUsername: string;
  isSandbox: boolean;
};

type JwtApiDiagnosticCall = {
  name: string;
  status: number;
  ok: boolean;
  errorCode?: "request_target_invalid" | "upstream_unreachable" | "redirect_response" | "response_too_large" | "invalid_json" | "salesforce_api_rejected" | "INSUFFICIENT_ACCESS" | "INSUFFICIENT_ACCESS_OR_READONLY" | "API_DISABLED_FOR_ORG" | "INVALID_TYPE" | "INVALID_FIELD" | "MALFORMED_QUERY" | "REQUEST_LIMIT_EXCEEDED" | "INVALID_SESSION_ID";
  summary?: Record<string, unknown>;
};

type JwtPermissionDiagnosticInput = {
  teamId: string;
  orgId: string;
  instanceUrl: string;
  integrationUserId: string;
  integrationUsername: string;
  isSandbox: boolean;
};

type JwtPermissionDiagnosticCheck = {
  name: string;
  status: number;
  ok: boolean;
  required?: boolean;
  skipped?: boolean;
  errorCode?: string;
  summary?: Record<string, unknown>;
};

async function diagnosticSalesforceJson(
  instanceUrl: string,
  accessToken: string,
  path: string,
): Promise<{ status: number; data: unknown; errorCode?: JwtApiDiagnosticCall["errorCode"] }> {
  const url = new URL(path, instanceUrl);
  if (url.origin !== instanceUrl || !url.pathname.startsWith("/services/data/")) {
    return { status: 0, data: null, errorCode: "request_target_invalid" };
  }
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      redirect: "manual",
    });
  } catch {
    return { status: 0, data: null, errorCode: "upstream_unreachable" };
  }
  if (response.status >= 300 && response.status < 400) {
    return { status: response.status, data: null, errorCode: "redirect_response" };
  }
  const declaredBytes = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > 262_144) {
    return { status: response.status, data: null, errorCode: "response_too_large" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await readBodyBounded(response, 262_144));
  } catch (cause) {
    return { status: response.status, data: null,
      errorCode: cause instanceof SecurityError && cause.status === 413 ? "response_too_large" : "upstream_unreachable" };
  }
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { return { status: response.status, data: null, errorCode: "invalid_json" }; }
  }
  const upstreamCode = Array.isArray(data) && object(data[0]) && typeof data[0].errorCode === "string"
    ? data[0].errorCode
    : object(data) && typeof data.errorCode === "string" ? data.errorCode : "";
  const safeUpstreamCodes = new Set([
    "INSUFFICIENT_ACCESS", "INSUFFICIENT_ACCESS_OR_READONLY", "API_DISABLED_FOR_ORG",
    "INVALID_TYPE", "INVALID_FIELD", "MALFORMED_QUERY", "REQUEST_LIMIT_EXCEEDED", "INVALID_SESSION_ID",
  ]);
  return {
    status: response.status,
    data,
    errorCode: response.ok ? undefined : safeUpstreamCodes.has(upstreamCode)
      ? upstreamCode as JwtApiDiagnosticCall["errorCode"] : "salesforce_api_rejected",
  };
}

async function runJwtApiDiagnostics(
  env: AuthEnv,
  input: JwtApiDiagnosticInput,
  requestId: string,
): Promise<Response> {
  const row: Credential = {
    team_id: input.teamId,
    org_id: input.orgId,
    channel_id: input.channelId,
    instance_url: new URL(input.instanceUrl).origin,
    integration_user_id: input.integrationUserId,
    integration_username: input.integrationUsername,
    is_sandbox: input.isSandbox ? 1 : 0,
  };

  // Do not use token(): it deliberately caches regular channel tokens in the
  // isolate. This diagnostic keeps the JWT access token request-local.
  const auth = await fetchToken(env, row, `jwt-api-diagnostic:${requestId}`, false);
  const checks: JwtApiDiagnosticCall[] = [];

  const run = async (name: string, path: string): Promise<unknown> => {
    try {
      const result = await diagnosticSalesforceJson(auth.instanceUrl, auth.accessToken, path);
      checks.push({ name, status: result.status, ok: result.status >= 200 && result.status < 300,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}) });
      return result.data;
    } catch {
      checks.push({ name, status: 0, ok: false, errorCode: "upstream_unreachable" });
      return null;
    }
  };

  const versions = await run("rest_api_versions", "/services/data/");
  const versionsAvailable = Array.isArray(versions) && versions.length > 0;
  if (checks[0]) {
    checks[0].ok = checks[0].ok && versionsAvailable;
    checks[0].summary = { versionCount: Array.isArray(versions) ? versions.length : 0 };
  }

  const orgSoql = encodeURIComponent("SELECT Id, IsSandbox FROM Organization LIMIT 1");
  const orgResult = await run("organization_query", `/services/data/${API_VERSION}/query?q=${orgSoql}`);
  const orgRecords = object(orgResult) && Array.isArray(orgResult.records) ? orgResult.records : [];
  const orgRecord = object(orgRecords[0]) ? orgRecords[0] : null;
  const orgMatches = orgRecord !== null && sameSalesforceId(orgRecord.Id, input.orgId) && orgRecord.IsSandbox === input.isSandbox;
  const orgCheck = checks.find(check => check.name === "organization_query");
  if (orgCheck) {
    orgCheck.ok = orgCheck.ok && orgMatches;
    orgCheck.summary = { recordCount: orgRecords.length, orgMatches };
  }

  const userSoql = encodeURIComponent(
    `SELECT Id, Name, Username, IsActive FROM User WHERE Id = '${input.integrationUserId}' LIMIT 1`,
  );
  const userResult = await run("integration_user_query", `/services/data/${API_VERSION}/query?q=${userSoql}`);
  const userRecords = object(userResult) && Array.isArray(userResult.records) ? userResult.records : [];
  const userRecord = object(userRecords[0]) ? userRecords[0] : null;
  const identityMatches = userRecord !== null && sameSalesforceId(userRecord.Id, input.integrationUserId) &&
    userRecord.Username === input.integrationUsername && userRecord.IsActive === true && typeof userRecord.Name === "string";
  const userCheck = checks.find(check => check.name === "integration_user_query");
  if (userCheck) {
    userCheck.ok = userCheck.ok && identityMatches;
    userCheck.summary = { recordCount: userRecords.length, identityMatches };
  }

  const ok = checks.length === 3 && checks.every(check => check.ok);
  return json({
    ok,
    orgId: input.orgId,
    integrationUser: userRecord && identityMatches ? {
      id: userRecord.Id,
      name: userRecord.Name,
      username: userRecord.Username,
      active: userRecord.IsActive,
    } : null,
    checks,
  }, requestId, ok ? 200 : 502);
}

async function runJwtApiPermissionDiagnostics(
  env: AuthEnv,
  input: JwtPermissionDiagnosticInput,
  requestId: string,
): Promise<Response> {
  const row: Credential = {
    team_id: input.teamId,
    org_id: input.orgId,
    channel_id: "permission-diagnostic",
    instance_url: new URL(input.instanceUrl).origin,
    integration_user_id: input.integrationUserId,
    integration_username: input.integrationUsername,
    is_sandbox: input.isSandbox ? 1 : 0,
  };
  // This token is request-scoped. It is neither stored in D1 nor put in the
  // regular token cache, and every Salesforce response is reduced to flags.
  const auth = await fetchToken(env, row, `jwt-permission-diagnostic:${requestId}`, false);
  const checks: JwtPermissionDiagnosticCheck[] = [];
  const run = async (name: string, path: string): Promise<unknown> => {
    const result = await diagnosticSalesforceJson(auth.instanceUrl, auth.accessToken, path);
    checks.push({ name, status: result.status, ok: result.status >= 200 && result.status < 300,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}) });
    return result.data;
  };

  const versions = await run("rest_api_versions", "/services/data/");
  const availableVersions = Array.isArray(versions)
    ? versions.map(version => object(version) ? version.version : null)
      .filter((version): version is string => typeof version === "string" && /^\d+\.\d+$/.test(version))
    : [];
  const latestVersion = availableVersions.sort((left, right) => Number(right) - Number(left))[0];
  const versionsCheck = checks[checks.length - 1];
  if (versionsCheck) {
    versionsCheck.ok = versionsCheck.ok && availableVersions.length > 0;
    versionsCheck.required = true;
    versionsCheck.summary = { versionCount: availableVersions.length, latestVersion: latestVersion ?? null };
  }
  const apiRootForOrg = `/services/data/v${latestVersion ?? API_VERSION}`;

  const orgSoql = encodeURIComponent("SELECT Id, IsSandbox FROM Organization LIMIT 1");
  const orgResult = await run("organization_query", `${apiRootForOrg}/query?q=${orgSoql}`);
  const orgRecords = object(orgResult) && Array.isArray(orgResult.records) ? orgResult.records : [];
  const orgRecord = object(orgRecords[0]) ? orgRecords[0] : null;
  const orgMatches = orgRecord !== null && sameSalesforceId(orgRecord.Id, input.orgId) && orgRecord.IsSandbox === input.isSandbox;
  const orgCheck = checks[checks.length - 1];
  if (orgCheck) {
    orgCheck.ok = orgCheck.ok && orgMatches;
    orgCheck.required = true;
    orgCheck.summary = { orgMatches };
  }

  const userSoql = encodeURIComponent(`SELECT Id, Username, IsActive FROM User WHERE Id = '${input.integrationUserId}' LIMIT 1`);
  const userResult = await run("selected_user_query", `${apiRootForOrg}/query?q=${userSoql}`);
  const userRecords = object(userResult) && Array.isArray(userResult.records) ? userResult.records : [];
  const userRecord = object(userRecords[0]) ? userRecords[0] : null;
  const identityMatches = userRecord !== null && sameSalesforceId(userRecord.Id, input.integrationUserId) &&
    userRecord.Username === input.integrationUsername && userRecord.IsActive === true;
  const userCheck = checks[checks.length - 1];
  if (userCheck) {
    userCheck.ok = userCheck.ok && identityMatches;
    userCheck.required = true;
    userCheck.summary = { identityMatches, active: userRecord?.IsActive === true };
  }

  const recordScenarios = [
    { key: "account", objectName: "Account" },
    { key: "contact", objectName: "Contact" },
    { key: "case", objectName: "Case" },
    { key: "messaging_session", objectName: "MessagingSession" },
    { key: "messaging_end_user", objectName: "MessagingEndUser" },
  ];
  for (const scenario of recordScenarios) {
    const description = await diagnosticSalesforceJson(auth.instanceUrl, auth.accessToken,
      `${apiRootForOrg}/sobjects/${scenario.objectName}/describe`);
    const describe = object(description.data) ? description.data : null;
    if (!description.status || description.status < 200 || description.status >= 300 || !describe) {
      checks.push({ name: `object_${scenario.key}`, status: description.status, ok: false,
        skipped: description.errorCode === "INVALID_TYPE" || description.status === 404,
        errorCode: description.errorCode ?? "invalid_response", summary: {} });
      continue;
    }
    const permissions = {
      queryable: describe.queryable === true,
      createable: describe.createable === true,
      updateable: describe.updateable === true,
      deletable: describe.deletable === true,
    };
    if (!permissions.queryable) {
      checks.push({ name: `object_${scenario.key}`, status: description.status, ok: false,
        errorCode: "not_queryable", summary: permissions });
      continue;
    }
    const soql = encodeURIComponent(`SELECT Id FROM ${scenario.objectName} LIMIT 1`);
    const query = await diagnosticSalesforceJson(auth.instanceUrl, auth.accessToken, `${apiRootForOrg}/query?q=${soql}`);
    const queryData = object(query.data) ? query.data : null;
    const records = queryData && Array.isArray(queryData.records) ? queryData.records : [];
    checks.push({ name: `object_${scenario.key}`, status: query.status,
      ok: query.status >= 200 && query.status < 300,
      skipped: query.errorCode === "INVALID_TYPE" || query.status === 404,
      ...(query.errorCode ? { errorCode: query.errorCode } : {}),
      summary: { ...permissions, sampleRecords: Math.min(records.length, 1) } });
  }

  try {
    const metadata = await probeAgentMetadataPermissions({
      instanceUrl: auth.instanceUrl,
      accessToken: auth.accessToken,
    });
    checks.push({ name: "agent_metadata_access", status: metadata.agentRetrieve === "pending" ? 202 : 200,
      ok: metadata.agentRetrieve === "ready",
      required: true,
      skipped: metadata.agentRetrieve === "not_available",
      ...(metadata.agentRetrieve === "pending" ? { errorCode: "metadata_retrieval_pending" } :
        metadata.agentRetrieve === "denied" ? { errorCode: "agent_metadata_permission_required" } :
        metadata.agentRetrieve === "failed" ? { errorCode: "agent_metadata_retrieve_failed" } : {}),
      summary: { apiVersion: metadata.apiVersion, agentCount: metadata.agentCount, retrieve: metadata.agentRetrieve } });
    checks.push({ name: "prompt_template_access", status: metadata.promptRetrieve === "pending" ? 202 : 200,
      ok: metadata.promptRetrieve === "ready",
      skipped: metadata.promptRetrieve === "not_available",
      ...(metadata.promptRetrieve === "pending" ? { errorCode: "metadata_retrieval_pending" } :
        metadata.promptRetrieve === "denied" ? { errorCode: "prompt_template_permission_required" } :
        metadata.promptRetrieve === "failed" ? { errorCode: "prompt_template_retrieve_failed" } : {}),
      summary: { templateCount: metadata.promptCount, retrieve: metadata.promptRetrieve } });
  } catch (cause) {
    const denied = cause instanceof SecurityError && cause.status === 403;
    checks.push({ name: "agent_metadata_access", status: cause instanceof SecurityError ? cause.status : 502,
      ok: false, required: true,
      errorCode: denied ? "agent_metadata_permission_required" : "agent_metadata_check_failed", summary: {} });
    checks.push({ name: "prompt_template_access", status: cause instanceof SecurityError ? cause.status : 502,
      ok: false, skipped: true,
      errorCode: denied ? "prompt_template_permission_required" : "agent_metadata_check_failed", summary: {} });
  }

  const ok = checks.filter(check => check.required === true && check.skipped !== true).every(check => check.ok);
  return json({ ok, checks }, requestId, 200);
}
async function sfGet(env: AuthEnv, row: Credential, path: string, requestId: string): Promise<Response> {
  return sfRequest(env, row, path, "GET", undefined, requestId);
}

const FIXTURE_CREATE_PATH = /^\/services\/data\/v\d+(?:\.\d+)?\/sobjects\/[A-Za-z][A-Za-z0-9_]+$/;
/**
 * Owned-fixture creates must stay owned by the execution identity: active
 * assignment rules would reassign them (queue drift) and break cleanup.
 * The platform skips assignment-rule evaluation on creates carrying
 * Sforce-Auto-Assign: FALSE. Shape-gated to exact POST-to-sobjects
 * creates and applied only inside probe owned-context transports; action
 * invokes, reads, Tooling, and panel runtime traffic never match.
 */
function fixtureCreateHeaders(method: string, path: string): Record<string, string> | undefined {
  return (method === "POST" && FIXTURE_CREATE_PATH.test(path) ||
    method === "PATCH" && /^\/services\/data\/v\d+(?:\.\d+)?\/sobjects\/[A-Za-z][A-Za-z0-9_]+\/[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(path))
    ? { "Sforce-Auto-Assign": "FALSE" } : undefined;
}
async function sfRequest(
  env: AuthEnv,
  row: Credential,
  path: string,
  method: string,
  body: string | undefined,
  requestId: string,
  preserveResponseHeaders = false,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const auth = await token(env, row);
    let response: Response;
    try {
      response = await fetch(auth.instanceUrl + path, {
        method,
        headers: {
          Authorization: "Bearer " + auth.accessToken,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(extraHeaders ?? {}),
        },
        ...(body === undefined ? {} : { body }),
        ...(signal ? { signal } : {}),
      });
    } catch (fetchError) {
      if (signal?.aborted) return Response.json([{ errorCode: "SALESFORCE_TIMEOUT",
        message: "Salesforce did not complete this action check within 60 seconds. Its execution outcome is unknown; it was not automatically replayed." }], { status: 504 });
      console.error(JSON.stringify({ requestId, error: "salesforce_fetch_thrown", method,
        route: path.split("?")[0].slice(0, 160),
        cause: (fetchError instanceof Error ? fetchError.message : String(fetchError)).slice(0, 160) }));
      throw authFailure(503, "salesforce_request_unavailable", "Salesforce could not complete the request. Retry it shortly.", true);
    }
    if (response.status === 401 && attempt === 0) {
      tokenCache.delete(cacheKey(row));
      continue;
    }
    if (!response.ok) {
      console.error(JSON.stringify({ requestId, error: "salesforce_request_failed", method,
        route: path.split("?")[0].slice(0, 160), status: response.status }));
    }
    if (preserveResponseHeaders) return response;
    const headers = new Headers({
      "Content-Type": response.headers.get("Content-Type") || "application/json",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "X-Request-Id": requestId,
    });
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  throw authFailure(502, "salesforce_auth_failed", "Salesforce authentication failed. Retry the request or reconnect this channel.");
}

const ACTION_ROUTES: Record<string, { scope: "custom" | "standard"; actionType?: string }> = {
  apex: { scope: "custom", actionType: "apex" },
  flow: { scope: "custom", actionType: "flow" },
  prompt: { scope: "custom", actionType: "generatePromptResponse" },
  generatePromptResponse: { scope: "custom", actionType: "generatePromptResponse" },
  standardAction: { scope: "standard" },
  standardInvocableAction: { scope: "standard" },
  externalService: { scope: "custom", actionType: "externalService" },
  predictiveModel: { scope: "custom", actionType: "cdpMlPrediction" },
};
const API_METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);
const SALESFORCE_API_PREFIX = "/services/data/";

function unavailable(code: string, message: string, retryable?: boolean): ToolResolution {
  return { available: false, diagnostic: { code, message, ...(retryable === undefined ? {} : { retryable }) } };
}
function isToolTarget(v: unknown): v is ToolTarget {
  return object(v) && str(v.type, 64) && str(v.name, 256) &&
    (v.method === undefined || str(v.method, 16)) &&
    (v.path === undefined || str(v.path, 4096));
}
function safeActionName(name: string): boolean {
  return name.length <= 256 && !/[\\/?#\u0000-\u001f\u007f]/.test(name);
}
function numericVersion(version: string): number[] | null {
  if (!/^\d+(?:\.\d+)?$/.test(version)) return null;
  return version.split(".").map(Number);
}
function compareVersions(a: string, b: string): number {
  const av = numericVersion(a) ?? [];
  const bv = numericVersion(b) ?? [];
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const delta = (av[i] ?? 0) - (bv[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
}
async function responseJson(response: Response): Promise<unknown> {
  try {
    const bytes = await readBodyBounded(response, 8 * 1024 * 1024);
    return parseSalesforceResponseJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return { errorCode: 'SALESFORCE_RESPONSE_UNREADABLE', message: 'The Salesforce response could not be safely read; execution success could not be verified.' };
  }
}
function salesforceError(value: unknown, depth = 0): { code?: string; message?: string } {
  if (depth > 8) return {};
  const values = Array.isArray(value) ? value : [value];
  const first = values.find(item => object(item) &&
    (typeof item.errorCode === "string" || typeof item.message === "string"));
  if (!object(first)) {
    for (const item of values.filter(object)) {
      for (const field of ["errors", "error", "outputValues", "body", "responseBody"]) {
        const nested = salesforceError(item[field], depth + 1);
        if (nested.code || nested.message) return nested;
      }
    }
    return {};
  }
  return {
    ...(typeof (first.errorCode ?? first.statusCode) === "string" ? { code: String(first.errorCode ?? first.statusCode).slice(0, 128) } : {}),
    ...(typeof first.message === "string" ? { message: first.message.slice(0, 1024) } : {}),
  };
}
export async function synthesizeRecordValues(env: AuthEnv, row: Credential, apiRoot: string, objectName: string,
  namePrefix: string, overrides: Record<string, unknown> = {}, referenceCache = new Map<string, string | null>(),
  schemaOverride?: unknown):
  Promise<{ values: Record<string, unknown> } | { failure: { status: number; body: unknown } }> {
  // Callers holding a freshly batched describe pass it through so fixture
  // synthesis costs zero subrequests; long lifecycles would otherwise
  // starve their own cleanup past the invocation subrequest cap.
  let schema: unknown = schemaOverride;
  let schemaStatus = 502;
  if (schema === undefined) {
    const describe = await sfRequest(env, row, `${apiRoot}/sobjects/${objectName}/describe`,
      "GET", undefined, crypto.randomUUID(), true);
    schemaStatus = describe.status;
    schema = await responseJson(describe);
  }
  if (!object(schema) || !Array.isArray(schema.fields)) {
    return { failure: { status: schemaStatus, body: {
      errorCode: "SYNTHETIC_RECORD_SCHEMA_UNAVAILABLE",
      message: `Salesforce could not describe ${objectName} (HTTP ${schemaStatus}).`,
    } } };
  }
  const values: Record<string, unknown> = {};
  for (const field of schema.fields.filter(object)) {
    if (typeof field.name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(field.name)) continue;
    if (Object.hasOwn(overrides, field.name)) {
      values[field.name] = overrides[field.name];
      continue;
    }
    // Identity fields are always populated: the live describe can mark a
    // name nillable while the runtime requires it (Person-Account orgs
    // describe Account.Name nillable, but business inserts 400
    // REQUIRED_FIELD_MISSING without it). Text-shaped names only;
    // compound members (Person LastName) stay excluded — they are invalid
    // on the fixture's record type.
    const fieldType = typeof field.type === "string" ? field.type.toLowerCase() : "";
    const identityName = isNameMarkerField(field) && ["string", "textarea", "combobox"].includes(fieldType);
    if ((!identityName && field.nillable !== false) || field.defaultedOnCreate === true || field.calculated === true ||
        field.autoNumber === true) continue;
    if (field.createable !== true && (field.permissionable === false || schema.fields.filter(object).some(
      component => component.compoundFieldName === field.name))) continue;
    // Rollup summaries and other platform-computed fields are required but
    // settable by nobody (neither createable nor updateable); the platform
    // fills them, so omitting is the only consistent choice. A field that is
    // updateable but not createable stays a failure: someone else could set it.
    // A merely-nillable identity name keeps the old omit behavior when it is
    // not createable: failing here would regress currently-skipped fields.
    if (field.createable !== true && field.updateable !== true) continue;
    if (field.createable !== true && !identityName) return { failure: { status: 422, body: {
      errorCode: "SYNTHETIC_RECORD_REQUIRED_FIELD_UNAVAILABLE",
      message: `The temporary ${objectName} has a required field the integration user cannot set.`,
    } } };
    if (field.createable !== true) continue;
    const type = typeof field.type === "string" ? field.type.toLowerCase() : "";
    // Live length caps bind every synthesized free-text value: an over-long
    // probe 400s STRING_TOO_LONG (live evidence: AccountNumber caps at 40).
    const liveLength = typeof field.length === "number" && Number.isFinite(field.length) && field.length > 0
      ? Math.floor(field.length) : null;
    const fit = (value: string): string => liveLength === null ? value : value.slice(0, liveLength);
    if (field.name === "Name" && type === "string") {
      values[field.name] = fit(`${namePrefix} ${crypto.randomUUID()}`);
    } else if (type === "boolean") {
      values[field.name] = false;
    } else if (type === "combobox") {
      // Combobox accepts free text with picklist suggestions: prefer a live
      // active choice, otherwise synthesize like a string. The real create
      // API validates either shape.
      const choices = Array.isArray(field.picklistValues) ? field.picklistValues.filter(object) : [];
      const choice = choices.find(value => value.active === true && typeof value.value === "string");
      values[field.name] = choice ? choice.value : fit("Action Searcher temporary validation");
    } else if (type === "picklist" || type === "multipicklist") {
      const choices = Array.isArray(field.picklistValues) ? field.picklistValues.filter(object) : [];
      const choice = choices.find(value => value.active === true && typeof value.value === "string");
      if (!choice) return { failure: { status: 422, body: {
        errorCode: "SYNTHETIC_RECORD_REQUIRED_VALUE_UNAVAILABLE",
        message: `Salesforce has no active value for a required temporary ${objectName} field.`,
      } } };
      values[field.name] = choice.value;
    } else if (type === "reference") {
      const references = Array.isArray(field.referenceTo) ? field.referenceTo : [];
      const scoped = references.filter((name): name is string => typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name))
        .map(name => referenceCache.get(name)).filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(id));
      // Every cached id was deliberately seeded by the calling lifecycle
      // (live lookup or planned owned dependency), never guessed, so the
      // first hit in describe order wins deterministically per org. This
      // admits polymorphic required references (Swarm.RelatedRecordId names
      // 8 live objects); an empty cache still refuses, and synthesis itself
      // performs no lookups, so the record-action no-borrow posture holds.
      if (scoped.length === 0) return { failure: { status: 422, body: {
        errorCode: "OWNED_CONTEXT_REQUIRED_REFERENCE_UNRESOLVED",
        message: `The temporary ${objectName}.${field.name} needs one explicit scoped reference or a planned owned dependency; an arbitrary existing record cannot supply fixture context.`,
      } } };
      values[field.name] = scoped[0];
    } else if (type === "email") {
      values[field.name] = "action-searcher@example.invalid";
    } else if (type === "phone") {
      values[field.name] = "+15550100123";
    } else if (type === "url") {
      values[field.name] = "https://example.invalid/action-searcher";
    } else if (["int", "integer", "double", "currency", "percent"].includes(type)) {
      values[field.name] = 1;
    } else if (type === "date") {
      values[field.name] = new Date().toISOString().slice(0, 10);
    } else if (type === "datetime") {
      values[field.name] = new Date().toISOString();
    } else if (type === "time") {
      values[field.name] = `${new Date().toISOString().slice(11, 23)}Z`;
    } else if (type === "base64") {
      values[field.name] = "QWN0aW9uUHJvYmU=";
    } else if (["string", "textarea", "encryptedstring"].includes(type)) {
      // Encrypted-string wire format is plain text; the platform encrypts
      // server-side. The real create API validates the value.
      values[field.name] = fit("Action Searcher temporary validation");
    } else {
      return { failure: { status: 422, body: {
        errorCode: "SYNTHETIC_RECORD_REQUIRED_FIELD_UNSUPPORTED",
        message: `Salesforce exposes a required ${objectName} field type the worker cannot synthesize.`,
      } } };
    }
  }
  // Explicit default record type: org automation can reject fixtures whose
  // type was left for the platform to default (live evidence: an SDO
  // Account insert faults "record type missing"). Only a real,
  // available, non-Master default is ever sent. Gated on a live
  // createable RecordTypeId field: objects without record-type support
  // (Asset) still describe a Master type entry but reject the column on
  // insert ("No such column"). Caller overrides stay authoritative, and
  // objects without a real default keep the omit behavior.
  const rtFieldSettable = schema.fields.filter(object).some(field =>
    field.name === "RecordTypeId" && field.createable === true);
  if (!Object.hasOwn(values, "RecordTypeId") && rtFieldSettable && Array.isArray(schema.recordTypeInfos)) {
    const infos = schema.recordTypeInfos.filter(object);
    // Real default only: the Master placeholder (012000000000000AAA) often
    // describes as available+default for users without an assigned type,
    // but sending it explicitly 400s INVALID_CROSS_REFERENCE_KEY
    // ("not valid for the user") while omitting resolves Master fine
    // (live evidence: Opportunity fixtures across 39 actions). No default
    // keeps the omit behavior.
    const pick = infos.find(f => f.available === true && f.defaultRecordTypeMapping === true && f.master !== true &&
      typeof f.recordTypeId === "string" && f.recordTypeId !== "012000000000000AAA");
    if (pick && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(pick.recordTypeId as string)) values.RecordTypeId = pick.recordTypeId;
  }
  // Caller-planned overrides are authoritative even when the live describe omits
  // the field (describe visibility quirks); the real create API validates them.
  for (const [name, value] of Object.entries(overrides)) {
    if (/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name)) values[name] = value;
  }
  return { values };
}
async function existingOrSyntheticAccount(env: AuthEnv, row: Credential, apiRoot: string,
  referenceCache = new Map<string, string | null>()):
  Promise<{ id: string; temporaryId?: string } | { failure: { status: number; body: unknown } }> {
  const query = "SELECT Id FROM Account LIMIT 1";
  const response = await sfRequest(env, row, `${apiRoot}/query?q=${encodeURIComponent(query)}`,
    "GET", undefined, crypto.randomUUID(), true);
  const body = await responseJson(response);
  const records = object(body) && Array.isArray(body.records) ? body.records : [];
  const first = records.find(object);
  if (typeof first?.Id === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(first.Id)) {
    referenceCache.set("Account", first.Id);
    return { id: first.Id };
  }

  const built = await synthesizeRecordValues(env, row, apiRoot, "Account",
    "Action Searcher temporary account probe", {}, referenceCache);
  if ("failure" in built) return built;
  const create = await sfRequest(env, row, `${apiRoot}/sobjects/Account`, "POST", JSON.stringify(built.values),
    crypto.randomUUID(), true);
  const createBody = await responseJson(create);
  if (!create.ok || !object(createBody) || typeof createBody.id !== "string" ||
      !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(createBody.id)) {
    const errorDetails = salesforceError(createBody);
    return { failure: { status: create.status, body: {
      errorCode: errorDetails.code ?? "SYNTHETIC_ACCOUNT_CREATE_FAILED",
      message: `Temporary Account creation failed (HTTP ${create.status}): ${errorDetails.message ?? "Salesforce returned no error details."}`,
    } } };
  }
  referenceCache.set("Account", createBody.id);
  return { id: createBody.id, temporaryId: createBody.id };
}
async function liveApiVersions(env: AuthEnv, row: Credential, requestId: string): Promise<ApiVersion[] | null> {
  const response = await sfGet(env, row, "/services/data/", requestId);
  if (!response.ok) return null;
  const body = await responseJson(response);
  if (!Array.isArray(body)) return null;
  const versions = body.flatMap((item): ApiVersion[] => {
    if (!object(item) || typeof item.version !== "string" || !numericVersion(item.version) ||
        typeof item.url !== "string" || item.url !== `/services/data/v${item.version}`) return [];
    return [{ version: item.version, url: item.url }];
  });
  return versions.length ? versions : null;
}
function latestVersion(versions: ApiVersion[]): ApiVersion {
  return [...versions].sort((a, b) => compareVersions(b.version, a.version))[0];
}
function schemaFields(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const allowed = ["name", "label", "type", "description", "required", "maxOccurs", "sObjectType", "apexClass"] as const;
  return value.filter(object).map(field => {
    const projected: Record<string, unknown> = {};
    for (const key of allowed) {
      if (field[key] !== undefined && ["string", "number", "boolean"].includes(typeof field[key])) {
        projected[key] = field[key];
      }
    }
    return projected;
  });
}
function routePathFromCatalog(value: unknown, row: Credential, version: string, expected: string): string | null {
  if (typeof value !== "string" || !value.startsWith(SALESFORCE_API_PREFIX) ||
      value.startsWith("//") || /[\\?#\u0000-\u001f\u007f]/.test(value)) return null;
  const url = new URL(value, row.instance_url);
  if (url.origin !== row.instance_url || url.pathname !== value || url.search || url.hash ||
      !url.pathname.startsWith(`/services/data/v${version}/actions/${expected}/`)) return null;
  return url.pathname;
}
function actionTypeAvailable(catalog: unknown, spec: { scope: "custom" | "standard"; actionType?: string }, version: string): boolean {
  if (spec.scope === "standard") return object(catalog) && Array.isArray(catalog.actions);
  if (!object(catalog) || !spec.actionType) return false;
  const route = catalog[spec.actionType];
  return typeof route === "string" && route === `/services/data/v${version}/actions/custom/${spec.actionType}`;
}
function actionEntries(catalog: unknown): Array<Record<string, unknown>> {
  if (!object(catalog) || !Array.isArray(catalog.actions)) return [];
  return catalog.actions.filter(object);
}
function actionEntryForTarget(
  entries: Array<Record<string, unknown>>,
  targetName: string,
  allowNamespacedAlias: boolean,
): Record<string, unknown> | undefined {
  const exact = entries.find(item => item.name === targetName);
  if (exact || !allowNamespacedAlias || targetName.includes("__")) return exact;
  const matches = entries.filter(item => {
    if (typeof item.name !== "string") return false;
    const boundary = item.name.indexOf("__");
    return boundary > 0 && boundary === item.name.lastIndexOf("__") && item.name.slice(boundary + 2) === targetName;
  });
  return matches.length === 1 ? matches[0] : undefined;
}
function safeApiDeclaredPath(rawPath: string, versions: ApiVersion[]): { path: string; version: string; resource: string } | null {
  if (!rawPath.startsWith(SALESFORCE_API_PREFIX) || rawPath.startsWith("//") ||
      /[\\#\u0000-\u001f\u007f]/.test(rawPath) || rawPath.length > 4096) return null;
  const queryIndex = rawPath.indexOf("?");
  const pathname = queryIndex < 0 ? rawPath : rawPath.slice(0, queryIndex);
  const query = queryIndex < 0 ? "" : rawPath.slice(queryIndex + 1);
  if (pathname.includes("//")) return null;
  const segments = pathname.slice(SALESFORCE_API_PREFIX.length).split("/");
  if (!segments.length || !segments[0]) return null;
  let version = latestVersion(versions).version;
  let resource = segments[0];
  let routePath = pathname;
  const declaredVersion = /^v(\d+(?:\.\d+)?)$/.exec(segments[0]);
  if (declaredVersion) {
    version = declaredVersion[1];
    if (!versions.some(item => item.version === version)) return null;
    resource = segments[1] ?? "";
  } else {
    routePath = `${SALESFORCE_API_PREFIX}v${version}/${pathname.slice(SALESFORCE_API_PREFIX.length)}`;
  }
  if (!resource || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(resource)) return null;
  for (const segment of routePath.split("?")[0].split("/")) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); }
    catch { return null; }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return null;
  }
  const url = new URL(routePath + (query ? `?${query}` : ""), "https://salesforce.invalid");
  if (url.origin !== "https://salesforce.invalid" || !url.pathname.startsWith(SALESFORCE_API_PREFIX)) return null;
  return { path: routePath + (query ? `?${query}` : ""), version, resource };
}
function interpolationValue(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}
function interpolateTemplate(value: string, args: Record<string, unknown>): string | null {
  const fullReference = /^\$input\.([A-Za-z][A-Za-z0-9_]*)$/.exec(value);
  if (fullReference) return interpolationValue(args[fullReference[1]]);
  if (Object.hasOwn(args, value)) return interpolationValue(args[value]);
  let missing = false;
  const result = value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const input = interpolationValue(args[name]);
    if (input === null) { missing = true; return ""; }
    return input;
  });
  return missing ? null : result;
}
function appendQueryValue(params: URLSearchParams, name: string, value: unknown): boolean {
  if (!/^[A-Za-z0-9_.~-]{1,128}$/.test(name)) return false;
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (item === null || item === undefined) continue;
    const rendered = interpolationValue(item);
    if (rendered === null) return false;
    params.append(name, rendered);
  }
  return true;
}
function validQueryParamsSpec(spec: unknown): boolean {
  if (spec === undefined) return true;
  if (Array.isArray(spec)) {
    return spec.every(entry => typeof entry === "string"
      ? /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(entry)
      : object(entry) && typeof entry.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(entry.name) &&
        (entry.input === undefined || typeof entry.input === "string") &&
        (entry.value === undefined || typeof entry.value === "string" || typeof entry.value === "number" || typeof entry.value === "boolean"));
  }
  if (!object(spec)) return false;
  return Object.entries(spec).every(([name, value]) => /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name) && (
    typeof value === "string" || typeof value === "number" || typeof value === "boolean" ||
    (Array.isArray(value) && value.every(item => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) ||
    (object(value) && ((typeof value.input === "string" && value.value === undefined) ||
      (value.input === undefined && (typeof value.value === "string" || typeof value.value === "number" || typeof value.value === "boolean"))))
  ));
}
function applyApiArguments(route: string, target: ToolTarget, args: Record<string, unknown>): string | null {
  const queryIndex = route.indexOf("?");
  const rawPath = queryIndex < 0 ? route : route.slice(0, queryIndex);
  const rawQuery = queryIndex < 0 ? "" : route.slice(queryIndex + 1);
  let pathMissing = false;
  const path = rawPath.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = interpolationValue(args[name]);
    if (value === null) { pathMissing = true; return ""; }
    return encodeURIComponent(value);
  });
  if (pathMissing) return null;
  const params = new URLSearchParams(rawQuery);
  for (const [key, value] of params.entries()) {
    const resolved = interpolateTemplate(value, args);
    if (resolved === null) return null;
    params.set(key, resolved);
  }
  const spec = target.queryParams;
  if (spec === undefined) {
    if (target.method?.toUpperCase() === "GET") {
      for (const [key, value] of Object.entries(args)) if (!appendQueryValue(params, key, value)) return null;
    }
  } else if (Array.isArray(spec)) {
    for (const entry of spec) {
      if (typeof entry === "string") {
        if (!Object.hasOwn(args, entry) || !appendQueryValue(params, entry, args[entry])) return null;
      } else if (object(entry) && typeof entry.name === "string") {
        if (typeof entry.value === "string" || typeof entry.value === "number" || typeof entry.value === "boolean") {
          const value = typeof entry.value === "string" ? interpolateTemplate(entry.value, args) : entry.value;
          if (value === null || !appendQueryValue(params, entry.name, value)) return null;
        } else {
          const sourceName = typeof entry.input === "string" ? entry.input : entry.name;
          if (!Object.hasOwn(args, sourceName) || !appendQueryValue(params, entry.name, args[sourceName])) return null;
        }
      } else return null;
    }
  } else if (object(spec)) {
    for (const [key, value] of Object.entries(spec)) {
      let resolved: unknown = value;
      if (object(value) && typeof value.input === "string") {
        if (!Object.hasOwn(args, value.input)) return null;
        resolved = args[value.input];
      } else if (object(value) && value.value !== undefined) {
        resolved = typeof value.value === "string" ? interpolateTemplate(value.value, args) : value.value;
      } else if (typeof value === "string") {
        const templated = interpolateTemplate(value, args);
        if (templated === null) return null;
        resolved = templated;
      }
      if (!appendQueryValue(params, key, resolved)) return null;
    }
  } else return null;
  const query = params.toString();
  return path + (query ? `?${query}` : "");
}
function apiInputNames(target: ToolTarget, path: string): unknown[] {
  const names = new Set<string>();
  for (const match of path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) names.add(match[1]);
  if (Array.isArray(target.queryParams)) {
    for (const entry of target.queryParams) {
      if (typeof entry === "string") names.add(entry);
      else if (object(entry) && typeof entry.input === "string") names.add(entry.input);
    }
  } else if (object(target.queryParams)) {
    for (const value of Object.values(target.queryParams)) {
      if (object(value) && typeof value.input === "string") names.add(value.input);
      else if (object(value) && typeof value.value === "string") {
        for (const match of value.value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) names.add(match[1]);
        const reference = /^\$input\.([A-Za-z][A-Za-z0-9_]*)$/.exec(value.value);
        if (reference) names.add(reference[1]);
      } else if (typeof value === "string") {
        const matches = value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g);
        for (const match of matches) names.add(match[1]);
        const reference = /^\$input\.([A-Za-z][A-Za-z0-9_]*)$/.exec(value);
        if (reference) names.add(reference[1]);
      }
    }
  }
  return [...names].map(name => ({ name }));
}
async function resolveTool(env: AuthEnv, row: Credential, target: ToolTarget, requestId: string): Promise<ToolResolution> {
  if (target.type === "api") {
    if (!str(target.method, 16) || !str(target.path, 4096)) {
      return unavailable("invalid_api_target", "API targets require a Salesforce method and path.");
    }
    const method = target.method.toUpperCase();
    if (!API_METHODS.has(method)) return unavailable("unsupported_api_method", "The declared API method is not supported.");
    if (!validQueryParamsSpec(target.queryParams)) return unavailable("invalid_api_query_params", "The API query parameter declaration is invalid.");
    if (!target.path.startsWith(SALESFORCE_API_PREFIX) || target.path.startsWith("//") ||
        target.path.split("?")[0].includes("//") ||
        /[\\#\u0000-\u001f\u007f]/.test(target.path)) {
      return unavailable("invalid_api_path", "The API path must name a supported Salesforce REST resource.");
    }
    const versions = await liveApiVersions(env, row, requestId);
    if (!versions) return unavailable("api_version_list_unavailable", "Salesforce API versions could not be discovered.", true);
    const normalized = safeApiDeclaredPath(target.path, versions);
    if (!normalized) return unavailable("invalid_api_path", "The API path must name a supported Salesforce REST resource.");
    const catalogResponse = await sfGet(env, row, `/services/data/v${normalized.version}/`, requestId);
    const catalog = catalogResponse.ok ? await responseJson(catalogResponse) : null;
    if (!object(catalog) || typeof catalog[normalized.resource] !== "string") {
      return unavailable("api_resource_unavailable", "The declared Salesforce REST resource is not available.");
    }
    return {
      available: true,
      route: normalized.path,
      inputs: apiInputNames(target, normalized.path),
      outputs: [],
      method,
      api: true,
      target,
    };
  }

  const spec = Object.hasOwn(ACTION_ROUTES, target.type) ? ACTION_ROUTES[target.type] : undefined;
  if (!spec) return unavailable("unsupported_target_type", "The Salesforce action target type is not supported.");
  if (!safeActionName(target.name)) return unavailable("invalid_action_name", "The Salesforce action name is invalid.");
  const versions = await liveApiVersions(env, row, requestId);
  if (!versions) return unavailable("api_version_list_unavailable", "Salesforce API versions could not be discovered.", true);
  const version = latestVersion(versions).version;
  const catalogUrl = `/services/data/v${version}/actions/${spec.scope}`;
  const rootResponse = await sfGet(env, row, catalogUrl, requestId);
  const rootCatalog = rootResponse.ok ? await responseJson(rootResponse) : null;
  if (!actionTypeAvailable(rootCatalog, spec, version)) {
    return unavailable("action_catalog_unavailable", "The Salesforce action catalog is unavailable.", true);
  }
  const actionCatalogUrl = spec.scope === "standard"
    ? catalogUrl
    : `${catalogUrl}/${spec.actionType}`;
  const actionCatalogResponse = spec.scope === "standard" ? rootResponse : await sfGet(env, row, actionCatalogUrl, requestId);
  const actionCatalog = spec.scope === "standard" ? rootCatalog :
    actionCatalogResponse.ok ? await responseJson(actionCatalogResponse) : null;
  const entry = actionEntryForTarget(
    actionEntries(actionCatalog),
    target.name,
    spec.scope === "custom",
  );
  if (!entry) return unavailable("action_not_found", "The Salesforce action is not available to this connection.");
  const expected = spec.scope === "standard" ? "standard" : `custom/${spec.actionType}`;
  const route = routePathFromCatalog(entry.url, row, version, expected);
  if (!route) return unavailable("invalid_action_route", "Salesforce returned an invalid action route.");
  const descriptorResponse = await sfGet(env, row, route, requestId);
  if (!descriptorResponse.ok) {
    return unavailable("action_describe_unavailable", "The Salesforce action descriptor could not be loaded.", descriptorResponse.status >= 500);
  }
  const descriptor = await responseJson(descriptorResponse);
  if (!object(descriptor) || descriptor.name !== entry.name) {
    return unavailable("action_describe_invalid", "Salesforce returned an invalid action descriptor.");
  }
  return {
    available: true,
    route,
    inputs: schemaFields(descriptor.inputs),
    outputs: schemaFields(descriptor.outputs),
    method: "POST",
    api: false,
    target,
  };
}
function safeDiagnosticFromFailure(cause: unknown): ToolResolution {
  if (cause instanceof AuthFailure) {
    return unavailable(cause.failure.code, cause.failure.message, cause.failure.retryable);
  }
  return unavailable("salesforce_describe_failed", "Salesforce action discovery failed.", true);
}
function apiRequestTarget(path: string, instanceUrl: string): boolean {
  if (!path.startsWith(SALESFORCE_API_PREFIX) || path.startsWith("//") ||
      /[\\#\u0000-\u001f\u007f]/.test(path)) return false;
  try {
    const url = new URL(path, instanceUrl);
    return url.origin === instanceUrl && url.pathname.startsWith(SALESFORCE_API_PREFIX) && !url.username && !url.password;
  } catch { return false; }
}
async function parse(request: Request, maxBytes = 64_000): Promise<Record<string, unknown> | null> {
  try { return await readJsonBounded(request, maxBytes); }
  catch (e) { if (e instanceof SecurityError && e.status === 413) throw e; return null; }
}

async function resolveCredentialForChannel(
  env: AuthEnv,
  channelId?: string | null
): Promise<Credential | null> {
  if (!channelId || !validSalesforceChannelId(channelId)) return null;
  const rows = await env.DB.prepare(`SELECT team_id, org_id, channel_id, instance_url,
      integration_user_id, integration_username, is_sandbox, client_id
    FROM panel_salesforce_channels WHERE channel_id = ? OR substr(channel_id, 1, 15) = ? LIMIT 3`)
    .bind(channelId, channelId.slice(0, 15)).all<PanelCredentialDbRow>();
  const matches = rows.results ?? [];
  if (!matches.length) return null;
  const scopes = new Set(matches.map(row => panelCredentialCacheKey(
    { teamId: row.team_id, orgId: row.org_id, channelId: row.channel_id })));
  if (scopes.size !== 1) throw authFailure(409, "channel_org_ambiguous", "More than one connected Salesforce org matches this channel.");
  const first = matches[0];
  const credential = credentialFromRow(first);
  cachePanelCredential({ teamId: first.team_id, orgId: first.org_id, channelId: first.channel_id }, credential);
  return credential;
}

async function querySalesforceUserData(
  env: AuthEnv,
  row: Credential,
  userId: string,
  requestId: string
): Promise<Record<string, unknown> | null> {
  const esc = userId.replace(/'/g, "\\'");

  // 1. Try User
  try {
    const userSoql = `SELECT Id, Username, Name, FirstName, LastName, Email, IsActive, UserType, Title, Department, CompanyName FROM User WHERE Id = '${esc}' OR Username = '${esc}' LIMIT 1`;
    const res = await sfGet(env, row, `/services/data/${API_VERSION}/query?q=${encodeURIComponent(userSoql)}`, requestId);
    if (res.ok) {
      const body = (await res.json()) as any;
      if (body?.records && body.records.length > 0) {
        return body.records[0];
      }
    }
  } catch {}

  // 2. Try Contact
  try {
    const contactSoql = `SELECT Id, Name, FirstName, LastName, Email, Phone, AccountId, Title, Department FROM Contact WHERE Id = '${esc}' OR Email = '${esc}' LIMIT 1`;
    const res = await sfGet(env, row, `/services/data/${API_VERSION}/query?q=${encodeURIComponent(contactSoql)}`, requestId);
    if (res.ok) {
      const body = (await res.json()) as any;
      if (body?.records && body.records.length > 0) {
        return body.records[0];
      }
    }
  } catch {}

  // 3. Try MessagingEndUser
  try {
    const endUserSoql = `SELECT Id, Name, MessagingChannelId, MessageType, ContactId, LeadId FROM MessagingEndUser WHERE Id = '${esc}' LIMIT 1`;
    const res = await sfGet(env, row, `/services/data/${API_VERSION}/query?q=${encodeURIComponent(endUserSoql)}`, requestId);
    if (res.ok) {
      const body = (await res.json()) as any;
      if (body?.records && body.records.length > 0) {
        return body.records[0];
      }
    }
  } catch {}

  // 4. Try REST sobject User
  if (/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(userId)) {
    try {
      const res = await sfGet(env, row, `/services/data/${API_VERSION}/sobjects/User/${encodeURIComponent(userId)}`, requestId);
      if (res.ok) {
        const body = (await res.json()) as any;
        if (body && typeof body === "object") return body;
      }
    } catch {}
  }

  return null;
}

async function querySalesforceMessagingSession(
  env: AuthEnv,
  row: Credential,
  sessionId: string,
  requestId: string
): Promise<Record<string, unknown> | null> {
  const esc = sessionId.replace(/'/g, "\\'");
  const soql = `SELECT Id, ChannelName, ChannelType, Status, StartTime, EndTime, MessagingEndUserId, ContactId, LeadId FROM MessagingSession WHERE Id = '${esc}' LIMIT 1`;
  const res = await sfGet(env, row, `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`, requestId);
  if (!res.ok) {
    return null;
  }
  const body = (await res.json()) as any;
  if (!body?.records || body.records.length === 0) {
    return null;
  }
  return body.records[0];
}

export interface ConversationMessageEntry {
  id?: string;
  senderType: "user" | "agent" | "bot" | "system";
  message: string;
  timestamp: string;
  actorId?: string;
  actorName?: string;
  metadata?: Record<string, any>;
}

export interface UserSessionConversation {
  sessionId: string;
  channelId?: string;
  startTime: string;
  endTime?: string;
  status?: string;
  messages: ConversationMessageEntry[];
  metadata?: Record<string, any>;
}

export interface UserConversationHistory {
  userId: string;
  sessions: UserSessionConversation[];
  totalSessions: number;
  totalMessages: number;
  lastActiveAt?: string;
  extractedAt: string;
}

async function querySalesforceUserConversations(
  env: AuthEnv,
  row: Credential,
  userId: string,
  options?: { currentSessionId?: string; limit?: number },
  requestId = crypto.randomUUID()
): Promise<UserConversationHistory> {
  const esc = userId.replace(/'/g, "\\'");
  const sessionLimit = options?.limit || 50;

  // 1. Query MessagingSession records for this user (or current session)
  const sessionConditions = [
    `MessagingEndUserId = '${esc}'`,
    `ContactId = '${esc}'`,
    `LeadId = '${esc}'`,
    `Id = '${esc}'`,
  ];
  if (options?.currentSessionId) {
    const escSess = options.currentSessionId.replace(/'/g, "\\'");
    sessionConditions.push(`Id = '${escSess}'`);
  }

  const sessionSoql = `SELECT Id, ConversationId, ChannelName, ChannelType, Status, StartTime, EndTime, EndTimeReason, MessagingEndUserId, ContactId, LeadId, CreatedDate FROM MessagingSession WHERE ${sessionConditions.join(" OR ")} ORDER BY StartTime DESC LIMIT ${sessionLimit}`;

  let sessionsList: any[] = [];
  try {
    const res = await sfGet(env, row, `/services/data/${API_VERSION}/query?q=${encodeURIComponent(sessionSoql)}`, requestId);
    if (res.ok) {
      const data = (await res.json()) as any;
      sessionsList = data?.records || [];
    }
  } catch (err) {
    console.warn("Error querying MessagingSessions for conversations:", err);
  }

  // If no sessions found by user ID directly, check if user is Contact/Lead linked to MessagingEndUser
  if (sessionsList.length === 0) {
    try {
      const meuSoql = `SELECT Id FROM MessagingEndUser WHERE ContactId = '${esc}' OR LeadId = '${esc}' LIMIT 10`;
      const meuRes = await sfGet(env, row, `/services/data/${API_VERSION}/query?q=${encodeURIComponent(meuSoql)}`, requestId);
      if (meuRes.ok) {
        const meuData = (await meuRes.json()) as any;
        const meuIds = (meuData?.records || []).map((r: any) => r.Id).filter(Boolean);
        if (meuIds.length > 0) {
          const meuIn = meuIds.map((id: string) => `'${id.replace(/'/g, "\\'")}'`).join(",");
          const fallbackSoql = `SELECT Id, ConversationId, ChannelName, ChannelType, Status, StartTime, EndTime, EndTimeReason, MessagingEndUserId, ContactId, LeadId, CreatedDate FROM MessagingSession WHERE MessagingEndUserId IN (${meuIn}) ORDER BY StartTime DESC LIMIT ${sessionLimit}`;
          const fallbackRes = await sfGet(env, row, `/services/data/${API_VERSION}/query?q=${encodeURIComponent(fallbackSoql)}`, requestId);
          if (fallbackRes.ok) {
            const fbData = (await fallbackRes.json()) as any;
            sessionsList = fbData?.records || [];
          }
        }
      }
    } catch {}
  }

  if (sessionsList.length === 0) {
    return {
      userId,
      sessions: [],
      totalSessions: 0,
      totalMessages: 0,
      extractedAt: new Date().toISOString(),
    };
  }

  // 2. Query ConversationEntry records for all sessions
  const sessionIds = sessionsList.map((s) => s.Id).filter(Boolean);
  const sessionIn = sessionIds.map((id: string) => `'${id.replace(/'/g, "\\'")}'`).join(",");
  const entrySoql = `SELECT Id, ConversationId, EntryType, MessageText, ActorType, ActorName, ClientTimestamp, CreatedDate FROM ConversationEntry WHERE ConversationId IN (${sessionIn}) ORDER BY CreatedDate ASC`;

  let entriesList: any[] = [];
  try {
    const entryRes = await sfGet(env, row, `/services/data/${API_VERSION}/query?q=${encodeURIComponent(entrySoql)}`, requestId);
    if (entryRes.ok) {
      const entryData = (await entryRes.json()) as any;
      entriesList = entryData?.records || [];
    }
  } catch (err) {
    console.warn("Error querying ConversationEntry records:", err);
  }

  // 3. Group entries by session
  const entriesBySession = new Map<string, ConversationMessageEntry[]>();
  for (const entry of entriesList) {
    const sId = entry.ConversationId;
    if (!entriesBySession.has(sId)) {
      entriesBySession.set(sId, []);
    }

    let senderType: "user" | "agent" | "bot" | "system" = "user";
    const rawActor = (entry.ActorType || "").toLowerCase();
    if (rawActor.includes("enduser") || rawActor.includes("user") || rawActor.includes("customer")) {
      senderType = "user";
    } else if (rawActor.includes("agent") || rawActor.includes("rep")) {
      senderType = "agent";
    } else if (rawActor.includes("bot") || rawActor.includes("copilot") || rawActor.includes("ai")) {
      senderType = "bot";
    } else if (rawActor.includes("system") || rawActor.includes("router")) {
      senderType = "system";
    }

    entriesBySession.get(sId)!.push({
      id: entry.Id,
      senderType,
      message: entry.MessageText || "",
      timestamp: entry.ClientTimestamp || entry.CreatedDate || new Date().toISOString(),
      actorName: entry.ActorName,
      metadata: {
        entryType: entry.EntryType,
        actorType: entry.ActorType,
      },
    });
  }

  let totalMessages = 0;
  const sessions: UserSessionConversation[] = sessionsList.map((s) => {
    const msgs = entriesBySession.get(s.Id) || [];
    totalMessages += msgs.length;
    return {
      sessionId: s.Id,
      channelId: s.ChannelName || s.ChannelType,
      startTime: s.StartTime || s.CreatedDate || new Date().toISOString(),
      endTime: s.EndTime,
      status: s.Status || "Unknown",
      messages: msgs,
      metadata: {
        conversationId: s.ConversationId,
        channelType: s.ChannelType,
        channelName: s.ChannelName,
        endTimeReason: s.EndTimeReason,
        contactId: s.ContactId,
        leadId: s.LeadId,
        messagingEndUserId: s.MessagingEndUserId,
        isCurrentSession: options?.currentSessionId ? s.Id === options.currentSessionId : undefined,
      },
    };
  });

  return {
    userId,
    sessions,
    totalSessions: sessions.length,
    totalMessages,
    lastActiveAt: sessions[0]?.startTime,
    extractedAt: new Date().toISOString(),
  };
}

async function handle(request: Request, env: AuthEnv, requestId: string, ctx?: any): Promise<Response> {
  const path = new URL(request.url).pathname;
  const panelChannelCleanupPath = path === "/internal/channels/cleanup";
  const orgCleanupPath = path === "/internal/orgs/cleanup";
  const panelJwtDiagnosticsPath = path === "/internal/jwt-api-diagnostics";
  const panelJwtPermissionDiagnosticsPath = path === "/internal/jwt-api-permission-diagnostics";
  if (path.startsWith("/internal/self-oauth/") || path.startsWith("/internal/agents/") || panelChannelCleanupPath || orgCleanupPath || panelJwtDiagnosticsPath || panelJwtPermissionDiagnosticsPath) {
    if (request.method !== "POST") return error(requestId, 405, "method_not_allowed", "Use POST for this internal Salesforce service operation.");
    try {
      if (!await verifySignedSelfOAuthRequest(request, env, path)) {
        return error(requestId, 401, "invalid_internal_signature", "A valid Panel service signature is required.");
      }
    } catch (err: unknown) {
      if (err instanceof AuthFailure) return failure(requestId, err.failure);
      throw err;
    }
  }
  const body = await parse(request, path === "/internal/self-oauth/request" ? 10_000_000 :
    path === "/internal/self-oauth/batch" ? 512_000 : 64_000);

  // Only signed Panel requests enter here. Panel supplies the verified tenant,
  // and credentials are loaded from the exact registered channel, never input.
  if (path.startsWith("/internal/agents/")) {
    if (!body || !key(body) || !validSalesforceOrgId(body.orgId)) throw new SecurityError(400, "invalid_tenant_scope");
    const scope = requireScope(body);
    let row: Credential & { agent_registration_version?: number } = await credentialForEntrypoint(env, scope);
    if (path === "/internal/agents/connect") {
      if (!validSalesforceUserId(body.metadataUserId) || !str(body.metadataUsername, 254) || /\s/.test(body.metadataUsername) || !jwtRow(row)) throw new SecurityError(400, "invalid_metadata_user");
      const candidate: Credential = { ...row, integration_user_id: body.metadataUserId, integration_username: body.metadataUsername };
      const auth = await fetchToken(env, candidate, `agent-metadata-verify:${requestId}`, false);
      await discoverAgents({ instanceUrl: auth.instanceUrl, accessToken: auth.accessToken });
      await env.DB.prepare(`INSERT INTO sf_agent_metadata_user(team_id,org_id,channel_id,integration_user_id,integration_username,verified_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(team_id,org_id,channel_id) DO UPDATE SET integration_user_id=excluded.integration_user_id,integration_username=excluded.integration_username,verified_at=excluded.verified_at,verification_json=NULL`)
        .bind(scope.teamId, scope.orgId, scope.channelId, body.metadataUserId, body.metadataUsername, Date.now()).run();
      // Explicit re-registration must discard sessions minted before license/grant changes.
      clearChannelTokens(scope);
      // ... and in-flight extractions owned by a previous user, which can never advance.
      await reconcileExtractionJobs(env.DB, scope, body.metadataUserId);
      return json({ connected: true, metadataUserId: body.metadataUserId }, requestId);
    }
    if (path === "/internal/agents/download") return downloadAgentSnapshot(env.DB, scope, body.jobId as string);
    const metadataUser = await env.DB.prepare("SELECT integration_user_id,integration_username,verified_at FROM sf_agent_metadata_user WHERE team_id=? AND org_id=? AND channel_id=?")
      .bind(scope.teamId, scope.orgId, scope.channelId).first<{ integration_user_id: string; integration_username: string; verified_at: number }>();
    if (metadataUser) row = { ...row, ...metadataUser, agent_registration_version: metadataUser.verified_at };
    const execute = async () => {
      // Poll-to-advance: the agent-save flow polls extract+status only, so a
      // status poll on a retrieving job advances it one round inline.
      // Terminal/failed jobs pass through without a Salesforce session; the
      // poll plan additionally goes status-only while another poll holds the
      // lease, the last round is fresh, or Salesforce failed recently (F11).
      if (path === "/internal/agents/status") {
        const poll = await planAgentSnapshotPoll(env.DB, scope, body.jobId as string);
        if (!poll.advance) return json(poll.status, requestId);
      }
      const auth = await token(env, row);
      const conn = { instanceUrl: auth.instanceUrl, accessToken: auth.accessToken, integrationUserId: row.integration_user_id };
      if (path === "/internal/agents/status") return json(await advanceAgentSnapshot(env.DB, scope, conn, body.jobId as string), requestId);
      if (path === "/internal/agents/verify") {
        const result = await verifyAgentAccess(env.DB, scope, conn);
        return json(result, requestId, result.ready ? 200 : 202);
      }
      if (path === "/internal/agents/list") return json(await discoverAgents(conn), requestId);
      if (path === "/internal/agents/extract") return json(await startAgentSnapshot(env.DB, scope, conn, body.agentName as string, body.agentType as string | undefined), requestId, 202);
      if (path === "/internal/agents/advance") return json(await advanceAgentSnapshot(env.DB, scope, conn, body.jobId as string), requestId);
      throw new SecurityError(404, "not_found");
    };
    try { return await execute(); } catch (cause) {
      if (!(cause instanceof SecurityError) || cause.status !== 401) throw cause;
      clearChannelTokens(scope);
      return execute();
    }
  }

  if (path === "/internal/channels/cleanup") {
    if (!body || !key(body) || !validSalesforceOrgId(body.orgId) || !validSalesforceUserId(body.channelId)) {
      return error(requestId, 400, "invalid_request", "A valid tenant, org, and channel are required.");
    }
    await env.DB.prepare("DELETE FROM sf_agent_metadata_user WHERE team_id=? AND org_id=? AND channel_id=?")
      .bind(body.teamId, body.orgId, body.channelId).run();
    // F3: single-channel disconnects keep sf_agent_snapshot_job/file/chunk so
    // a reconnect reuses the extracted schema instead of re-extracting from
    // zero. Only channel-bound rows (metadata user, graph context, plus the
    // panel-side channel/execution-user rows) are purged here; full org
    // teardown in cleanupSalesforceOrg still purges the snapshot tables.
    clearChannelTokens(body as Key);
    await env.DB.prepare("DELETE FROM action_graph_context WHERE team_id=? AND org_id=? AND channel_id=?")
      .bind(body.teamId, body.orgId, body.channelId).run();
    return json({ ok: true }, requestId);
  }

  if (orgCleanupPath) {
    if (!body || !str(body.teamId, 128) || !validSalesforceOrgId(body.orgId)) {
      return error(requestId, 400, "invalid_request", "A valid Panel team and Salesforce org are required.");
    }
    const result = await cleanupSalesforceOrg(env, { teamId: body.teamId, orgId: body.orgId });
    return json({ ok: true, ...result }, requestId);
  }

  if (path === "/internal/jwt-api-diagnostics") {
    if (request.method !== "POST") return error(requestId, 405, "method_not_allowed", "Use POST for this internal Salesforce diagnostic.");
    if (!body || !key(body) || !validSalesforceOrgId(body.orgId) ||
        !validSalesforceUserId(body.integrationUserId) || !str(body.integrationUsername, 254) ||
        !str(body.instanceUrl, 512) || !validInstanceUrl(body.instanceUrl) || typeof body.isSandbox !== "boolean") {
      return error(requestId, 400, "invalid_request", "A valid channel identity is required.");
    }
    try {
      return await runJwtApiDiagnostics(env, body as JwtApiDiagnosticInput, requestId);
    } catch (cause) {
      if (cause instanceof AuthFailure) return failure(requestId, cause.failure);
      console.error(JSON.stringify({ requestId, error: "jwt_api_diagnostics_failed" }));
      return error(requestId, 502, "jwt_api_diagnostics_failed", "The integration user API checks could not be completed.", true);
    }
  }

  if (path === "/internal/jwt-api-permission-diagnostics") {
    if (request.method !== "POST") return error(requestId, 405, "method_not_allowed", "Use POST for this internal Salesforce permission diagnostic.");
    if (!body || !str(body.teamId, 128) || !validSalesforceOrgId(body.orgId) ||
        !validSalesforceUserId(body.integrationUserId) || !str(body.integrationUsername, 254) ||
        !str(body.instanceUrl, 512) || !validInstanceUrl(body.instanceUrl) || typeof body.isSandbox !== "boolean") {
      return error(requestId, 400, "invalid_request", "A valid Salesforce org and selected user are required.");
    }
    try {
      return await runJwtApiPermissionDiagnostics(env, body as JwtPermissionDiagnosticInput, requestId);
    } catch (cause) {
      if (cause instanceof AuthFailure) return failure(requestId, cause.failure);
      console.error(JSON.stringify({ requestId, error: "jwt_api_permission_diagnostics_failed" }));
      return error(requestId, 502, "jwt_api_permission_diagnostics_failed", "The selected Salesforce user's live permission checks could not be completed.", true);
    }
  }

  if (path.startsWith("/internal/self-oauth/") && request.method === "POST") {
    if (!body) return error(requestId, 400, "invalid_request", "A valid JSON request is required.");
    try {
      if (path === "/internal/self-oauth/complete") {
        const result = await completeSelfOAuth(env, body);
        return json({ ok: true, ...result }, requestId);
      }
      const grant = selfOAuthGrantOrNull(body);
      if (!grant) return error(requestId, 401, "unauthorized", "A valid active Panel Salesforce grant is required.");
      if (path === "/internal/self-oauth/start") {
        const result = await selfOAuthStart(env, body);
        return json({ ok: true, ...result }, requestId);
      }
      if (path === "/internal/self-oauth/status") {
        return json({ ok: true, ...await selfOAuthStatus(env, grant) }, requestId);
      }
      if (path === "/internal/self-oauth/request") {
        return selfOAuthApiRequest(env, grant, body, requestId);
      }
      if (path === "/internal/self-oauth/batch") {
        return selfOAuthApiBatch(env, grant, body, requestId);
      }
      if (path === "/internal/self-oauth/disconnect") {
        await selfOAuthDisconnect(env, grant);
        return json({ ok: true, connected: false }, requestId);
      }
      return error(requestId, 404, "not_found", "The requested self-authorization operation was not found.");
    } catch (err: unknown) {
      if (err instanceof AuthFailure) return failure(requestId, err.failure);
      console.error(JSON.stringify({ requestId, error: "self_salesforce_oauth_failed" }));
      return error(requestId, 500, "internal_error", "The Salesforce connection service could not complete the request.");
    }
  }

  return error(requestId, 404, "not_found", "The requested auth service endpoint was not found.");
}

let BaseWorkerEntrypoint: any = class {
  constructor(public ctx: any, public env: any) {}
};
try {
  // @ts-ignore
  const cf = await import("cloudflare:workers");
  if (cf?.WorkerEntrypoint) {
    BaseWorkerEntrypoint = cf.WorkerEntrypoint;
  }
} catch {
  // Fallback for non-workerd runtimes
}

// The primary deployment gates registration, not the messaging path:
// visitor turns ride the v1 widget shape on Web deployments (widget token,
// esDeveloperName of the Web deployment — accepted live by the v2 message
// endpoint) or the v2 API shape on API deployments, and agent replies
// submit through the channel's Flow action. Nothing mints a v2 token with
// this deployment, so API and Web both proxy; only Mobile cannot (the
// iamessage token endpoint rejects it: "Supported deployment types: API"),
// and it keeps its own code. Proven live: web-only sdolite1.
export function assertProxyDeployment(payload: unknown, channelAddressIdentifier: string): void {
  const root = object(payload) ? payload : null;
  const config = root && object(root.embeddedServiceConfig) ? root.embeddedServiceConfig : null;
  const channel = config && object(config.embeddedServiceMessagingChannel) ? config.embeddedServiceMessagingChannel : null;
  if (config?.deploymentType === "Mobile") {
    throw authFailure(400, "proxy_deployment_type_unsupported", "The Mobile deployment cannot be proxied through the messaging path. Register an API or Web deployment instead.");
  }
  const type = config?.deploymentType;
  if ((type !== "API" && type !== "Web") || channel?.channelAddressIdentifier !== channelAddressIdentifier) {
    throw authFailure(400, "proxy_deployment_mismatch", "The published API or Web deployment must belong to this channel.");
  }
}

/** Private service binding for messaging proxies. Never exposes Salesforce tokens or arbitrary API access. */
function assertActionMapping(action: EchoAction, resolved: Extract<ToolResolution, { available: true }>): void {
  const inputs = resolved.inputs.filter(object);
  const names = new Set(inputs.map(field => field.name));
  const mapped = new Set(Object.values(action.inputMapping));
  if ([...mapped].some(name => !names.has(name)) || inputs.some(field => field.required === true && !mapped.has(String(field.name))) ||
      !Object.values(action.outputMapping).every(name => resolved.outputs.some(field => object(field) && field.name === name))) {
    throw authFailure(400, "proxy_action_mapping_invalid", "The mapping does not match live Flow metadata.");
  }
}
export class MessagingProxyBroker extends BaseWorkerEntrypoint {
  async #connection(scope: TenantScope) {
    if (!validScope(scope)) throw authFailure(400, "invalid_proxy_scope", "A valid tenant channel is required.");
    return credentialForEntrypoint(this.env as AuthEnv, scope);
  }
  async authorize(scope:TenantScope, signed?: SignedRpcEnvelope):Promise<void>{await verifySignedRpcCall(this.env as AuthEnv, "authorize", [scope], signed);await this.#connection(scope);}
  async #action(row: Credential, action: EchoAction) {
    const resolved = await resolveTool(this.env as AuthEnv, row, {type:"flow",name:action.name}, crypto.randomUUID());
    if (!resolved.available) throw authFailure(404, "proxy_action_unavailable", "The configured Flow action is unavailable.");
    assertActionMapping(action, resolved);
    return resolved;
  }
  async #actionCached(row: Credential, action: EchoAction) {
    const key = `${row.org_id}\n${action.name}`;
    const hit = flowRouteCache.get(key);
    if (hit && Date.now() - hit.at < 300000 && hit.resolved.available) {
      try { assertActionMapping(action, hit.resolved); return hit.resolved; }
      catch { flowRouteCache.delete(key); }
    }
    const resolved = await resolveTool(this.env as AuthEnv, row, {type:"flow",name:action.name}, crypto.randomUUID());
    if (!resolved.available) throw authFailure(404, "proxy_action_unavailable", "The configured Flow action is unavailable.");
    assertActionMapping(action, resolved);
    if (flowRouteCache.size > 500) flowRouteCache.clear();
    flowRouteCache.set(key, { at: Date.now(), resolved });
    return resolved;
  }
  async validate(scope:TenantScope,config:ProxyConfig, signed?: SignedRpcEnvelope):Promise<{scrtOrigin:string;browser?:import('../../tubot-sf-proxy/src/contracts').BrowserConfig}> {
    await verifySignedRpcCall(this.env as AuthEnv, "validate", [scope, config], signed);
    try{return await this.#validate(scope,config);}catch(cause){
      throw new Error('proxy_broker_'+(cause instanceof AuthFailure?cause.failure.code:'validation_unavailable'));
    }
  }
  async #validate(scope: TenantScope, config: ProxyConfig): Promise<{scrtOrigin:string;browser?:import('../../tubot-sf-proxy/src/contracts').BrowserConfig}> {
    if (!validConfig(config)) throw authFailure(400, "invalid_proxy_config", "A valid deployment and Flow mapping are required.");
    let stage="connection";
    try {
    const row = await this.#connection(scope);
    stage="action_discovery";
    await this.#action(row, config.action);
    stage="channel_read";
    const channelResponse = await sfGet(this.env as AuthEnv, row, `/services/data/${API_VERSION}/sobjects/MessagingChannel/${scope.channelId}`, crypto.randomUUID());
    const channel = channelResponse.ok ? await responseJson(channelResponse) : null;
    if (!object(channel) || channel.IsActive !== true || typeof channel.ChannelAddressIdentifier !== "string") {
      throw authFailure(404, "proxy_channel_unavailable", "An active messaging channel is required.");
    }
    const host = new URL(row.instance_url).hostname;
    if (!host.endsWith(".my.salesforce.com")) throw authFailure(400, "unsupported_scrt_domain", "The connection must use its Salesforce My Domain.");
    const scrtOrigin = `https://${host.slice(0,-".my.salesforce.com".length)}.my.salesforce-scrt.com`;
    const url = new URL("/embeddedservice/v1/embedded-service-config", scrtOrigin);
    url.search = new URLSearchParams({orgId:scope.orgId,esConfigName:config.deploymentName,language:"en_US"}).toString();
    stage="scrt_configuration";
    const response = await fetch(url.toString(), {redirect:"manual",signal:AbortSignal.timeout(20000)});
    const payload: any = response.ok ? await response.json() : null;
    assertProxyDeployment(payload, channel.ChannelAddressIdentifier);
    stage='browser_configuration';
    let browser;
    if(config.browserDeploymentName){
      try{browser=await browserConfig(path=>sfGet(this.env as AuthEnv,row,path,crypto.randomUUID()),API_VERSION,scrtOrigin,scope,config.browserDeploymentName,channel.ChannelAddressIdentifier);}
      catch(cause){const code=cause instanceof Error?cause.message:'';if(/^browser_(config_unavailable|config_transport_unavailable|config_invalid_json|channel_mismatch|deployment_type_unsupported|site_insecure|site_invalid|schema_unavailable|schema_transport_unavailable|schema_invalid_json|binding_field_unavailable)$/.test(code))throw authFailure(502,code,'Browser configuration validation failed.');throw cause;}
    }
    return {scrtOrigin,...(browser?{browser}:{})};
    } catch(cause) {if(cause instanceof AuthFailure)throw cause;throw authFailure(502,"proxy_"+stage+"_exception","Proxy validation failed.");}
  }
  async browserTurn(scope:TenantScope,config:import('../../tubot-sf-proxy/src/contracts').BrowserConfig,turn:import('../../tubot-sf-proxy/src/contracts').BrowserTurnInput, signed?: SignedRpcEnvelope):Promise<import('../../tubot-sf-proxy/src/contracts').BrowserVerifyResult>{
    await verifySignedRpcCall(this.env as AuthEnv, "browserTurn", [scope, config, turn], signed);
    const row=await this.#connection(scope);
    const env=this.env as AuthEnv;
    const verdict=await verifyBrowserTurn(path=>sfGet(env,row,path,crypto.randomUUID()),scope,config,turn,(path,body)=>sfRequest(env,row,path,"PATCH",body,crypto.randomUUID()));
    return {code:verdict.code,...(verdict.recipient?{recipient:verdict.recipient}:{})};
  }
  async browserSync(scope:TenantScope,config:import('../../tubot-sf-proxy/src/contracts').BrowserConfig,input:{reference:string;conversationId?:string;sinceMs?:number}, signed?: SignedRpcEnvelope):Promise<import('../../tubot-sf-proxy/src/contracts').BrowserSyncResult>{
    await verifySignedRpcCall(this.env as AuthEnv, "browserSync", [scope, config, input], signed);
    const row=await this.#connection(scope);
    const env=this.env as AuthEnv;
    return discoverBrowserTurns(path=>sfGet(env,row,path,crypto.randomUUID()),scope,config,input);
  }
  // Retired: the merged verify+submit echo RPC is gone with echo serving.
  // Agent-only flow is browserTurn (verify) -> agentcode -> echo (submit of
  // the AGENT REPLY). echo() below remains the submitter; it never receives
  // visitor text from any caller anymore.
  // F5: read-only Flow-route pre-resolve. The proxy fires this alongside the
  // agent turn so submit's echo() usually finds #actionCached warm instead of
  // paying Salesforce discovery serially after the reply. Warms the same cache
  // echo() reads (plus connection/token); never submits. Fail-open by design:
  // any throw leaves the caller to re-resolve serially inside echo().
  async resolveFlowRoute(scope: TenantScope, action: EchoAction, signed?: SignedRpcEnvelope): Promise<{ok:true}> {
    await verifySignedRpcCall(this.env as AuthEnv, "resolveFlowRoute", [scope, action], signed);
    if (!validConfig({deploymentName:"Validation",action})) throw authFailure(400, "invalid_proxy_turn", "The Flow action is invalid.");
    await this.#actionCached(await this.#connection(scope), action);
    return {ok:true};
  }
  async echo(scope: TenantScope, action: EchoAction, turn: import('../../tubot-sf-proxy/src/contracts').EchoTurn, signed?: SignedRpcEnvelope): Promise<{requestId:string}> {
    await verifySignedRpcCall(this.env as AuthEnv, "echo", [scope, action, turn], signed);
    if (!validConfig({deploymentName:"Validation",action}) || !turn || !/^[a-f0-9-]{36}$/i.test(turn.conversationId) ||
        typeof turn.text !== "string" || !turn.text.length || turn.text.length > 4096 || !/^[a-f0-9]{64}$/.test(turn.requestKey) ||
        !turnScopeMatches(scope, turn)) {
      throw authFailure(400, "invalid_proxy_turn", "The messaging turn is invalid.");
    }
    const env = this.env as AuthEnv;
    const row = await this.#connection(scope);
    const resolved = await this.#actionCached(row, action);
    // A verify-supplied recipient skips this duplicate session query; an
    // absent or malformed hint falls back to the query below.
    const passthrough = validGuestId(turn.recipient) ? turn.recipient : undefined;
    const soql = `SELECT MessagingEndUserId FROM MessagingSession WHERE Conversation.ConversationIdentifier='${turn.conversationId}' AND MessagingChannelId='${scope.channelId}' ORDER BY CreatedDate DESC LIMIT 1`;
    const lookup = passthrough === undefined ? await sfGet(env, row, `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`, crypto.randomUUID()) : null;
    const sessions: any = lookup?.ok ? await responseJson(lookup) : null;
    const recipient = passthrough ?? sessions?.records?.[0]?.MessagingEndUserId;
    if (!validGuestId(recipient)) throw authFailure(404, "proxy_session_pending", "The channel session is not available yet.", true);
    // Submit idempotency: the proxy's 25s inline race orphan + alarm (or an
    // adopted echo_inline retry) invoke echo() twice for one visitor message.
    // Same requestKey returns the first invocation's requestId; only the
    // claim owner POSTs. Claim-store errors fail open (send anyway).
    const claim = await claimEchoSubmit(env.DB, turn.requestKey);
    if (!claim.owned) return { requestId: claim.requestId };
    const tracked = !('failOpen' in claim);
    const m = action.inputMapping;
    // Stored-first twin order (sdo2 2026-10-30: the route's stored
    // definitionName is live-picked from the org's definition listing at
    // provisioning, so it names a definition that EXISTS; it must go
    // first. Deriving from the flow namespace first burns one doomed
    // interview (and a Flow error email per turn) on mixed orgs where the
    // resolved flow and the stored definition live in different
    // namespaces (unpackaged twin flow + packaged definition). The flip
    // stays as the single INVALID_INPUT fallback (rejected pre-send, so
    // the retry cannot double-send).
    const flowNs = /\/flow\/([A-Za-z0-9]+)__[^/]+$/.exec(resolved.route)?.[1] ?? null;
    const qualified = qualifyDefinitionName(action.definitionName, flowNs);
    const submitWith = (definitionName: string) =>
      sfRequest(env,row,resolved.route,"POST",JSON.stringify({inputs:[{
        [m.definition]:definitionName,[m.recipients]:[recipient],[m.parameters]:echoParameters(scope,recipient,turn.text)
      }]}),crypto.randomUUID(),true);
    let used = action.definitionName;
    let response = await submitWith(action.definitionName);
    let result: any = await responseJson(response);
    const fallback = qualified !== action.definitionName ? qualified : flipDefinitionTwin(action.definitionName);
    if (fallback && isDefinitionInvalidInput(result)) {
      used = fallback;
      response = await submitWith(fallback);
      result = await responseJson(response);
    }
    const output = result?.[0]?.outputValues;
    if (!response.ok || result?.[0]?.isSuccess !== true ||
        !/^[A-Za-z0-9]{15,18}$/.test(output?.[action.outputMapping.requestId] || "")) {
      console.error(JSON.stringify({error:"salesforce_notify_rejected",route:String(resolved.route).slice(0,160),
        definition:used,status:response.status,isSuccess:result?.[0]?.isSuccess === true,
        errorCode:String(result?.[0]?.errorCode ?? result?.[0]?.errors?.[0]?.errorCode ?? "").slice(0,80)}));
      if (tracked) await releaseEchoSubmit(env.DB, turn.requestKey, claim.claimant);
      throw authFailure(502, "proxy_echo_rejected", "Salesforce did not confirm the notification request.", true);
    }
    if (tracked) await completeEchoSubmit(env.DB, turn.requestKey, claim.claimant, output[action.outputMapping.requestId]);
    return {requestId:output[action.outputMapping.requestId]};
  }
  async confirmInbound(scope:TenantScope, conversationId:string, messageId:string,text?:string, signed?: SignedRpcEnvelope): Promise<boolean> {
    await verifySignedRpcCall(this.env as AuthEnv, "confirmInbound", [scope, conversationId, messageId, text], signed);
    if (![conversationId,messageId].every(v=>typeof v === "string" && /^[a-f0-9-]{36}$/i.test(v))) throw authFailure(400,"invalid_proxy_entry","Invalid conversation entry.");
    const row = await this.#connection(scope);
    const soql = `SELECT Id FROM MessagingSession WHERE Conversation.ConversationIdentifier='${conversationId}' AND MessagingChannelId='${scope.channelId}' LIMIT 1`;
    const response = await sfGet(this.env as AuthEnv,row,`/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`,crypto.randomUUID());
    const sessions:any = response.ok ? await responseJson(response) : null;
    if (!sessions?.records?.length) return false;
    const entries = await sfGet(this.env as AuthEnv,row,`/services/data/${API_VERSION}/connect/conversation/${conversationId}/entries?recordLimit=1000`,crypto.randomUUID());
    if (!entries.ok) throw authFailure(502,"proxy_entries_unavailable","Conversation entries are unavailable.",true);
    const body:any = await responseJson(entries);
    return Array.isArray(body?.conversationEntries) && body.conversationEntries.some((entry:any)=>entry.identifier === messageId&&entry.sender?.role==='EndUser'&&(text===undefined||entry.messageText===transcriptText(text)));
  }
  async sessionState(scope: TenantScope, conversationId:string, signed?: SignedRpcEnvelope): Promise<import('../../tubot-sf-proxy/src/contracts').SessionHandoffState|null> {
    await verifySignedRpcCall(this.env as AuthEnv, "sessionState", [scope, conversationId], signed);
    if (typeof conversationId !== "string" || !/^[a-f0-9-]{36}$/i.test(conversationId)) throw authFailure(400,"invalid_proxy_entry","Invalid conversation entry.");
    const row = await this.#connection(scope);
    return resolveSessionState(path=>sfGet(this.env as AuthEnv,row,path,crypto.randomUUID()),API_VERSION,scope,conversationId);
  }
  async status(scope: TenantScope, requestId:string, signed?: SignedRpcEnvelope): Promise<{state:"pending"|"delivered"|"failed";errors?:string[]}> {
    await verifySignedRpcCall(this.env as AuthEnv, "status", [scope, requestId], signed);
    if (!/^1sr[A-Za-z0-9]{12,15}$/.test(requestId)) throw authFailure(400,"invalid_send_request","Invalid notification request.");
    const row = await this.#connection(scope);
    const response = await sfGet(this.env as AuthEnv,row,`/services/data/${API_VERSION}/sobjects/ConvMessageSendRequest/${requestId}`,crypto.randomUUID());
    const result: any = response.ok ? await responseJson(response) : null;
    if (!result) throw authFailure(502,"proxy_status_unavailable","Notification status is unavailable.",true);
    if (result.RequestStatus !== "Completed") return {state:"pending"};
    return result.SuccessMessageCount === 1 && result.FailedMessageCount === 0 ? {state:"delivered"} :
      {state:"failed",errors:Array.isArray(result.FailedMessageErrorReasons)?result.FailedMessageErrorReasons.filter((v:unknown)=>typeof v==="string"):[]};
  }
}

/** Data360 blob client for snapshot read-through. Module-level (not a method)
 * so the entrypoint keeps exposing exactly the guarded RPC surface. */
function data360AgentClientFor(env: AuthEnv): Data360AgentClient | null {
  if (!env.DATA360 || typeof env.DATA360_INTERNAL_KEY !== "string" || env.DATA360_INTERNAL_KEY.length < 32) return null;
  return new Data360AgentClient(env.DATA360, env.DATA360_INTERNAL_KEY);
}

export class TubotSfAuthEntrypoint extends BaseWorkerEntrypoint {
  /** Service-binding-only inventory for autonomous, tenant-scoped discovery. */
  async listConnectedOrgs(signed?: SignedRpcEnvelope): Promise<Key[]> {
    const org = await verifySignedRpcCall(this.env as AuthEnv, "listConnectedOrgs", [], signed);
    const env = this.env as AuthEnv;
    // F6: push the bound org into SQL (covering SEARCH on
    // panel_salesforce_channels_org_teams_idx) instead of GROUP-BY-scanning
    // every channel and filtering in JS. The legacy scopeless path (empty org)
    // keeps the full inventory scan; the residual filter is a no-op safety net.
    const rows = org
      ? await env.DB.prepare(`SELECT team_id AS teamId, org_id AS orgId,
        MIN(channel_id) AS channelId FROM panel_salesforce_channels WHERE org_id=? GROUP BY team_id, org_id`).bind(org).all<Key>()
      : await env.DB.prepare(`SELECT team_id AS teamId, org_id AS orgId,
        MIN(channel_id) AS channelId FROM panel_salesforce_channels GROUP BY team_id, org_id`).all<Key>();
    const all = rows.results ?? [];
    return org ? all.filter(k => k.orgId === org) : all;
  }

  /** Agentcode tenant picker: distinct teams holding ready snapshots for
   * the calling org. Scopeless (envelope org binds in the body); covers
   * teams with no channel row, which listConnectedOrgs cannot see. */
  async listSnapshotTeams(signed?: SignedRpcEnvelope): Promise<string[]> {
    const org = await verifySignedRpcCall(this.env as AuthEnv, "listSnapshotTeams", [], signed);
    try {
      return await listSnapshotTeamsForOrg((this.env as AuthEnv).DB, org);
    } catch (cause) {
      if (cause instanceof SecurityError) throw authFailure(cause.status, cause.code, cause.code);
      throw cause;
    }
  }

  /** Agentcode session source: latest ready snapshot per saved agent. Scope-first (arg 0); envelope org binds to scope.orgId. */
  async listAgentSnapshots(scope: AgentScope, signed?: SignedRpcEnvelope): Promise<Array<{ agentName: string; jobId: string; status: string; updatedAt: number }>> {
    await verifySignedRpcCall(this.env as AuthEnv, "listAgentSnapshots", [scope], signed);
    try {
      const env = this.env as AuthEnv;
      const d1 = await listAgentSnapshotsForScope(env.DB, scope);
      const client = data360AgentClientFor(env);
      if (!client) return d1;
      try {
        return await listCachedAgents(env.DB, client, scope, d1);
      } catch (cause) {
        console.log(JSON.stringify({ event: "data360_list_fallback", team: (scope as any)?.teamId, org: (scope as any)?.orgId, error: cause instanceof Error ? cause.message : String(cause) }));
        return d1;
      }
    } catch (cause) {
      if (cause instanceof SecurityError) throw authFailure(cause.status, cause.code, cause.code);
      throw cause;
    }
  }

  /** Agentcode session source: reassembled snapshot files for one saved agent. Scope-first (arg 0). */
  async getAgentSnapshot(scope: AgentScope, agentName: string, signed?: SignedRpcEnvelope): Promise<{ agentName: string; jobId: string; sha: string; manifest: unknown; files: Array<{ path: string; sha256: string; byteSize: number; content: string }> }> {
    await verifySignedRpcCall(this.env as AuthEnv, "getAgentSnapshot", [scope, agentName], signed);
    const env = this.env as AuthEnv;
    try {
      return await readAgentSnapshotForScope(env.DB, scope, agentName);
    } catch (cause) {
      // D1 miss: read through the data360 blob cache (ownership-checked, integrity-verified).
      if (cause instanceof SecurityError && cause.code === "agent_snapshot_not_found") {
        const client = data360AgentClientFor(env);
        if (client) {
          try {
            const hydrateT0 = Date.now();
            const hydrated = await hydrateAgentFromData360(env.DB, client, scope, agentName);
            console.log(JSON.stringify({ event: "sf_hydrate_agent", agent: agentName, outcome: hydrated ? "ok" : "miss", latencyMs: Date.now() - hydrateT0 }));
            if (hydrated) return hydrated;
          } catch (nested) {
            if (!(nested instanceof SecurityError)) throw nested;
            if (nested.code === "data360_invalid_response" || nested.code === "data360_misconfigured") throw authFailure(nested.status, nested.code, nested.code);
            // Transport failures on the read-through path surface the original 404 shape.
            console.log(JSON.stringify({ event: "data360_hydrate_failed", agent: agentName, error: nested.message }));
          }
        }
      }
      if (cause instanceof SecurityError) throw authFailure(cause.status, cause.code, cause.code);
      throw cause;
    }
  }

  /** Restricted Salesforce proxy. Tokens never leave this Worker. */
  async inspectSalesforce(ref: Key, requests: Array<{
    method: "GET" | "HEAD" | "POST";
    path: string;
    jsonBody?: Record<string, unknown>;
  }>, signed?: SignedRpcEnvelope):
    Promise<Array<{ status: number; body: unknown }>> {
    await verifySignedRpcCall(this.env as AuthEnv, "inspectSalesforce", [ref, requests], signed);
    const env = this.env as AuthEnv;
    if (!key(ref) || !Array.isArray(requests) || requests.length < 1 || requests.length > 25) {
      throw authFailure(400, "invalid_request", "A valid tenant and up to 25 requests are required.");
    }
    const row = await credentialForEntrypoint(env, ref);
    const results: Array<{ status: number; body: unknown; trailingDocuments?: unknown }> =
      new Array(requests.length);
    // QUOTABURN Q1: fold eligible GETs into composite/batch (25 max, 1 call
    // per batch). Validation still runs per item in order and throws on the
    // first invalid route exactly as before; only verified-valid items batch.
    // QUOTABURN Q2: POST invocable-action invocations fold too. The REST API
    // Developer Guide lists Actions (vXX.X/actions) as batch-eligible since
    // API v35.0; the invocation body travels as the subrequest richInput.
    // Verdicts still derive per subrequest (statusCode + result), so mapping
    // is identical to one direct POST per action.
    const batchVersion = (item: { method: string; path: string; jsonBody?: Record<string, unknown> }): string | null => {
      if (typeof item.path !== "string") return null;
      if (item.method === "GET") {
        if (/^\/services\/data\/(?:v\d+(?:\.\d+)?\/)?tooling\//.test(item.path)) return null;
        return item.path.match(/^\/services\/data\/(v\d+(?:\.\d+)?)\//)?.[1] ?? null;
      }
      if (item.method === "POST" && item.jsonBody !== undefined) {
        const version = item.path.match(/^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/(?:standard|custom)\//)?.[1] ?? null;
        if (version === null) return null;
        return Number(version.slice(1)) >= 35 ? version : null;
      }
      return null;
    };
    const fetchDirect = async (item: { method: "GET" | "HEAD" | "POST"; path: string; jsonBody?: Record<string, unknown> }):
      Promise<{ status: number; body: unknown; trailingDocuments?: unknown }> => {
      const response = await sfRequest(env, row, item.path, item.method,
        item.method === "POST" ? (item.jsonBody ? JSON.stringify(item.jsonBody) : "{") : undefined,
        crypto.randomUUID(), true, AbortSignal.timeout(60_000));
      if (item.method === "HEAD") return { status: response.status, body: null };
      const route = item.path.split("?")[0].slice(0, 256);
      const contentLength = response.headers.get("content-length");
      if (contentLength && Number(contentLength) > MAX_SALESFORCE_INSPECTION_BYTES) {
        await response.body?.cancel();
        return { status: 502, body: {
          errorCode: "RESPONSE_TOO_LARGE",
          message: `Salesforce inspection response exceeds the size limit for ${item.method} ${route}.`,
        } };
      }
      let raw: string;
      try {
        raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await readBodyBounded(response, MAX_SALESFORCE_INSPECTION_BYTES));
      } catch (failure) {
        return { status: 502, body: {
          errorCode: failure instanceof SecurityError && failure.code === 'body_too_large' ? 'RESPONSE_TOO_LARGE' : 'SALESFORCE_RESPONSE_UNREADABLE',
          message: failure instanceof SecurityError && failure.code === 'body_too_large'
            ? `Salesforce inspection response exceeds the size limit for ${item.method} ${route}.`
            : `Salesforce inspection response could not be safely read for ${item.method} ${route}.`,
        } };
      }
      const body = parseSalesforceResponseJson(raw, MAX_SALESFORCE_INSPECTION_BYTES);
      const trailingDocuments = extractTrailingResponseDocuments(raw);
      return trailingDocuments.length
        ? { status: response.status, body, trailingDocuments }
        : { status: response.status, body };
    };
    const fetchBatch = async (version: string, indices: number[]): Promise<boolean> => {
      const subrequests = indices.map((i) => ({
        method: requests[i].method,
        url: requests[i].path.slice("/services/data/".length).replace(/'/g, "%27"),
        ...(requests[i].method === "POST" && requests[i].jsonBody !== undefined
          ? { richInput: requests[i].jsonBody }
          : {}),
      }));
      let envelope: unknown;
      try {
        const response = await sfRequest(env, row, `/services/data/${version}/composite/batch`, "POST",
          JSON.stringify({ batchRequests: subrequests }), crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
          .decode(await readBodyBounded(response, MAX_SALESFORCE_INSPECTION_BYTES));
        if (response.status < 200 || response.status >= 300) return false;
        envelope = parseSalesforceResponseJson(raw, MAX_SALESFORCE_INSPECTION_BYTES);
      } catch { return false; }
      const items = typeof envelope === "object" && envelope !== null && Array.isArray((envelope as { results?: unknown }).results)
        ? (envelope as { results: unknown[] }).results : null;
      if (!items || items.length !== indices.length ||
        !items.every((entry) => typeof entry === "object" && entry !== null &&
          typeof (entry as { statusCode?: unknown }).statusCode === "number")) return false;
      items.forEach((entry, slot) => {
        const typed = entry as { statusCode: number; result?: unknown };
        results[indices[slot]] = { status: typed.statusCode, body: typed.result ?? null };
      });
      return true;
    };
    for (const item of requests) {
      const isActionRoute = typeof item?.path === "string" &&
        /^\/services\/data\/(?:v\d+(?:\.\d+)?\/)?actions(?:\/|$)/.test(item.path);
      const isToolingQuery = typeof item?.path === "string" &&
        /^\/services\/data\/(?:v\d+(?:\.\d+)?\/)?tooling\/query\?/.test(item.path);
      const isVersionRoot = item?.method === "GET" && item.path === "/services/data/";
      const isSObjectMetadata = typeof item?.path === "string" && item.method === "GET" &&
        /^\/services\/data\/v\d+(?:\.\d+)?\/sobjects\/(?:[A-Za-z][A-Za-z0-9_]{0,127}\/describe\/?)?$/.test(item.path);
      const isQuickActionDefinition = typeof item?.path === "string" && item.method === "GET" &&
        /^\/services\/data\/v\d+(?:\.\d+)?\/(?:sobjects\/[A-Za-z][A-Za-z0-9_]{0,127}\/)?quickActions\/[A-Za-z][A-Za-z0-9_]{0,127}\/describe$/.test(item.path);
      const isCustomFieldMetadata = typeof item?.path === 'string' && item.method === 'GET' &&
        /^\/services\/data\/v\d+(?:\.\d+)?\/tooling\/sobjects\/CustomField\/describe$/.test(item.path);
      const isRelatedListMetadata = typeof item?.path === "string" && item.method === "GET" &&
        /^\/services\/data\/v\d+(?:\.\d+)?\/ui-api\/related-list-info\/[A-Za-z][A-Za-z0-9_]{0,127}(?:\?recordTypeId=[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)?$/.test(item.path);
      const isReportTypeCatalog = typeof item?.path === "string" && item.method === "GET" &&
        /^\/services\/data\/v\d+(?:\.\d+)?\/analytics\/reportTypes$/.test(item.path);
      const isDataSpaceCatalog = typeof item?.path === "string" && item.method === "GET" &&
        /^\/services\/data\/v\d+(?:\.\d+)?\/ssot\/data-spaces$/.test(item.path);
      const isRetrieverCatalog = typeof item?.path === "string" && item.method === "GET" &&
        /^\/services\/data\/v\d+(?:\.\d+)?\/ssot\/machine-learning\/retrievers$/.test(item.path);
      const isPromptMetadata = typeof item?.path === "string" && item.method === "GET" &&
        /^\/services\/data\/v\d+(?:\.\d+)?\/einstein\/prompt-templates\/[A-Za-z][A-Za-z0-9_]{0,127}$/.test(item.path);
      // Read-only single-row fetch by record ID (native standard actions:
      // getDataForGrounding / queryRecords verification / summarize).
      const isSObjectRow = typeof item?.path === "string" && item.method === "GET" &&
        /^\/services\/data\/v\d+(?:\.\d+)?\/sobjects\/[A-Za-z][A-Za-z0-9_]{0,127}\/[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(item.path);
      // Read-only child relationship records of one parent row.
      const isChildRelationship = typeof item?.path === "string" && item.method === "GET" &&
        /^\/services\/data\/v\d+(?:\.\d+)?\/sobjects\/[A-Za-z][A-Za-z0-9_]{0,127}\/[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?\/[A-Za-z][A-Za-z0-9_]{0,127}$/.test(item.path);
      // Tightly-shaped SOSL: one FIND literal (no operators/quotes/braces
      // possible), single RETURNING object, Id-first field list.
      let isSoslSearch = false;
      if (typeof item?.path === "string" && item.method === "GET") {
        const sosl = item.path.match(/^\/services\/data\/v\d+(?:\.\d+)?\/search\?q=(.*)$/);
        if (sosl) {
          try {
            const soslQuery = decodeURIComponent(sosl[1]);
            isSoslSearch =
              /^FIND \{[A-Za-z0-9@._\- ]{1,100}\} IN ALL FIELDS RETURNING [A-Za-z][A-Za-z0-9_]{0,127}(\(Id(,\s*[A-Za-z][A-Za-z0-9_]*){0,20}\))?$/.test(soslQuery) &&
              !/\b(AND|OR|NOT)\b/i.test(soslQuery);
          } catch { isSoslSearch = false; }
        }
      }
      const isIdentityRoute = typeof item?.path === "string" && item.method === "GET" &&
        /^\/services\/data\/v\d+(?:\.\d+)?\/chatter\/users\/me$/.test(item.path);
      const isPromptGeneration = typeof item?.path === "string" && item.method === "POST" &&
        /^\/services\/data\/v\d+(?:\.\d+)?\/einstein\/prompt-templates\/[A-Za-z][A-Za-z0-9_]{0,127}\/generations$/.test(item.path);
      const promptBody = isPromptGeneration && object(item.jsonBody) && item.jsonBody.isPreview === false &&
        object(item.jsonBody.inputParams) && object(item.jsonBody.inputParams.valueMap) &&
        Object.entries(item.jsonBody.inputParams.valueMap).length <= 10 &&
        Object.entries(item.jsonBody.inputParams.valueMap).every(([name, wrapped]) =>
          /^Input:[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name) && object(wrapped) && Object.hasOwn(wrapped, "value"));
      const objectQuery = typeof item?.path === "string" &&
        item.method === "GET" && item.path.match(/^\/services\/data\/v\d+(?:\.\d+)?\/query\?q=(.*)$/);
      let isTestRecordQuery = false;
      let isNativeSelect = false;
      if (objectQuery) {
        try {
          const soql = decodeURIComponent(objectQuery[1]);
          // Native standard-action executor (searcher standard-native):
          // record-ID prefix resolution. Exact emitted shape, tight.
          const isPrefixLookup =
            /^SELECT QualifiedApiName FROM EntityDefinition WHERE KeyPrefix='[A-Za-z0-9]{3}' LIMIT 5$/i.test(soql);
          // Native QueryRecords: single read-only SELECT the executor
          // already gated (no DML, FROM = resolved catalog object, LIMIT
          // <= 50). The broker mirrors that gate structurally: strict
          // charset, no second SELECT (no subqueries), no FOR UPDATE.
          const nativeShape =
            /^SELECT ([A-Za-z][A-Za-z0-9_., '()]{0,500}) FROM ([A-Za-z][A-Za-z0-9_]{0,127})( WHERE ([A-Za-z0-9_., =<>'%!()\-:@+]+))?( ORDER BY [A-Za-z][A-Za-z0-9_]{0,127}( (ASC|DESC))?)? LIMIT ([1-9]|[1-4][0-9]|50)$/i.test(soql);
          isNativeSelect = nativeShape &&
            !/\b(delete|update|insert|upsert|merge|undelete|for\s+update)\b/i.test(soql) &&
            (soql.match(/\bselect\b/gi) ?? []).length <= 1;
          isTestRecordQuery = isPrefixLookup || isNativeSelect ||
            /^SELECT Id(?:, [A-Za-z][A-Za-z0-9_]{0,127}){1,59} FROM [A-Za-z][A-Za-z0-9_]{0,127} LIMIT 3$/i.test(soql) ||
            /^SELECT Id, Quantity FROM OrderItemSummary WHERE OrderSummaryId = '[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?' LIMIT 5$/i.test(soql) ||
            /^SELECT Reason FROM OrderItemSummaryChangeReason LIMIT 5$/i.test(soql) ||
            /^SELECT Id FROM [A-Za-z][A-Za-z0-9_]{0,127} LIMIT 1$/i.test(soql) ||
            /^SELECT Id FROM [A-Za-z][A-Za-z0-9_]{0,127} LIMIT 8$/i.test(soql) ||
            /^SELECT RelatedRecordId FROM Swarm WHERE Status != 'Closed' LIMIT 200$/i.test(soql) ||
            /^SELECT Id, DeveloperName, MasterLabel FROM Skill LIMIT 1$/i.test(soql) ||
            /^SELECT Id, RecordTypeId FROM [A-Za-z][A-Za-z0-9_]{0,127} WHERE Id='[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?' LIMIT 1$/i.test(soql) ||
            /^SELECT Id FROM MessagingSession WHERE ConversationId != null(?: AND Status = 'Ended')? LIMIT 1$/i.test(soql) ||
            /^SELECT Id FROM Conversation WHERE ConversationIdentifier = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' LIMIT 1$/i.test(soql) ||
            /^SELECT Id, SessionKey FROM MessagingSession WHERE ConversationId = '[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?' LIMIT 1$/i.test(soql) ||
            /^SELECT DurableId,ApiName,Label FROM FlowDefinitionView WHERE ApiName IN \('[A-Za-z][A-Za-z0-9_]{0,127}'(?:,'[A-Za-z][A-Za-z0-9_]{0,127}')?\)$/i.test(soql) ||
            /^SELECT Id FROM [A-Za-z][A-Za-z0-9_]{0,127} WHERE [A-Za-z][A-Za-z0-9_]{0,127}='ACTIVE' LIMIT [1-5]$/i.test(soql) ||
            /^SELECT Id FROM ContentDocument WHERE FileType IN \('AMR','AU','FLAC','M4A','MP3','MP4','MPEG','MPGA','OGG','OGA','WAV','WAVE','WEBM'\) LIMIT 1$/i.test(soql) ||
            /^SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName LIKE '%__kav' LIMIT 10$/i.test(soql) ||
            /^SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName LIKE '%[A-Za-z][A-Za-z0-9_]{2,127}%' LIMIT 50$/i.test(soql) ||
            /^SELECT QualifiedApiName, KeyPrefix, Label FROM EntityDefinition WHERE QualifiedApiName IN \('[A-Za-z][A-Za-z0-9_]{0,127}'(?:,'[A-Za-z][A-Za-z0-9_]{0,127}')*\)$/i.test(soql) ||
            /^SELECT QualifiedApiName, KeyPrefix, Label, IsQueryable, IsLayoutable FROM EntityDefinition WHERE QualifiedApiName IN \('[A-Za-z][A-Za-z0-9_]{0,127}'(?:,'[A-Za-z][A-Za-z0-9_]{0,127}')*\)$/i.test(soql) ||
            /^SELECT QualifiedApiName, KeyPrefix, Label, IsQueryable, IsLayoutable FROM EntityDefinition(?: WHERE QualifiedApiName > '[A-Za-z][A-Za-z0-9_]{0,127}')? ORDER BY QualifiedApiName LIMIT 500$/i.test(soql) ||
            /^SELECT TimeZoneSidKey FROM Organization LIMIT 1$/i.test(soql) ||
            /^SELECT DeveloperName, Endpoint FROM NamedCredential LIMIT 50$/i.test(soql);
        } catch { isTestRecordQuery = false; }
      }
      if (!object(item) || !["GET", "HEAD", "POST"].includes(item.method as string) ||
          typeof item.path !== "string" || item.path.length > 4096 ||
          (item.jsonBody !== undefined && (!object(item.jsonBody) || JSON.stringify(item.jsonBody).length > 32_000)) ||
          (item.jsonBody !== undefined && !promptBody && (!Array.isArray(item.jsonBody.inputs) || item.jsonBody.inputs.length < 1 ||
            item.jsonBody.inputs.length > 10 || !item.jsonBody.inputs.every(object))) ||
          (item.jsonBody !== undefined && item.method !== "POST") ||
          !(isVersionRoot || isActionRoute || isToolingQuery || isTestRecordQuery || isSObjectMetadata || isSObjectRow || isChildRelationship || isSoslSearch || isCustomFieldMetadata || isQuickActionDefinition ||
            isRelatedListMetadata || isReportTypeCatalog || isDataSpaceCatalog || isRetrieverCatalog || isPromptMetadata || isIdentityRoute || (isPromptGeneration && promptBody)) ||
          ((isToolingQuery || isTestRecordQuery) && item.method !== "GET") ||
          /[\\#\u0000-\u001f\u007f]/.test(item.path) || item.path.includes("//") ||
          item.path.split("?")[0].split("/").some(part => part === ".." || part === ".") ||
          (item.method === "POST" && !isPromptGeneration && (!/^\/services\/data\/v\d+(?:\.\d+)?\/actions\/(?:standard|custom)\//.test(item.path) ||
            !isActionRoute))) {
        throw authFailure(400, "invalid_api_path", "The requested Salesforce inspection route is invalid.");
      }
    }
    const direct: number[] = [];
    const batched = new Map<string, number[]>();
    requests.forEach((item, index) => {
      const version = batchVersion(item);
      if (version === null) { direct.push(index); return; }
      const group = batched.get(version) ?? [];
      group.push(index);
      batched.set(version, group);
    });
    for (const index of direct) results[index] = await fetchDirect(requests[index]);
    for (const [version, indices] of batched) {
      for (let start = 0; start < indices.length; start += 25) {
        const chunk = indices.slice(start, start + 25);
        // A one-item "batch" saves no round-trip and only adds envelope
        // overhead, so singles keep the exact direct path (byte-identical
        // behavior, trailing-document evidence preserved).
        if (chunk.length < 2) {
          for (const index of chunk) results[index] = await fetchDirect(requests[index]);
          continue;
        }
        const folded = await fetchBatch(version, chunk);
        if (!folded) for (const index of chunk) results[index] = await fetchDirect(requests[index]);
      }
    }
    return results;
  }

  /**
   * Invoke only the standard speech transcription action with an ephemeral,
   * tenant-scoped WAV file. The file is removed in a finally block so this
   * test fixture does not remain in the connected org.
   */
  async invokeSpeechToTextWithSyntheticAudio(ref: Key, input: {
    apiVersion: string;
    route: string;
    arguments: Record<string, unknown>;
    audioBase64: string;
  }, signed?: SignedRpcEnvelope): Promise<{ status: number; body: unknown; cleanupError?: string }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeSpeechToTextWithSyntheticAudio", [ref, input], signed);
    if (!key(ref) || !object(input) || !/^\d+(?:\.\d+)?$/.test(input.apiVersion) ||
        input.route !== `/services/data/v${input.apiVersion}/actions/standard/speechToText` ||
        !object(input.arguments) || Object.hasOwn(input.arguments, "contentDocumentId") ||
        Object.keys(input.arguments).some(name => name !== "transcriptionModel") ||
        typeof input.audioBase64 !== "string" || input.audioBase64.length > 160_000 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.audioBase64)) {
      throw authFailure(400, "invalid_synthetic_audio_test", "The synthetic speech test request is invalid.");
    }
    let audio: Uint8Array;
    try {
      const raw = atob(input.audioBase64);
      audio = Uint8Array.from(raw, char => char.charCodeAt(0));
    } catch {
      throw authFailure(400, "invalid_synthetic_audio_test", "The synthetic speech test audio is invalid.");
    }
    const signature = new TextDecoder().decode(audio.subarray(0, 12));
    if (audio.length < 44 || audio.length > 120_000 ||
        signature.slice(0, 4) !== "RIFF" || signature.slice(8, 12) !== "WAVE") {
      throw authFailure(400, "invalid_synthetic_audio_test", "The synthetic speech test must be a bounded WAV file.");
    }

    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);

    const versionPath = `/services/data/v${input.apiVersion}/sobjects/ContentVersion`;
    const versionResponse = await sfRequest(env, row, versionPath, "POST", JSON.stringify({
      Title: `Action Searcher transient audio probe ${crypto.randomUUID()}`,
      PathOnClient: "action-searcher-probe.wav",
      VersionData: input.audioBase64,
    }), crypto.randomUUID(), true);
    const versionBody = await responseJson(versionResponse);
    if (!versionResponse.ok || !object(versionBody) || typeof versionBody.id !== "string" ||
        !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(versionBody.id)) {
      return { status: versionResponse.status, body: versionBody ?? {
        errorCode: "SYNTHETIC_AUDIO_CREATE_FAILED",
        message: `Salesforce rejected the temporary audio file with HTTP ${versionResponse.status}.`,
      } };
    }

    let contentDocumentId: string | undefined;
    let result: { status: number; body: unknown };
    let cleanupError: string | undefined;
    try {
      const soql = `SELECT ContentDocumentId FROM ContentVersion WHERE Id = '${versionBody.id}' LIMIT 1`;
      const contentResponse = await sfRequest(env, row,
        `/services/data/v${input.apiVersion}/query?q=${encodeURIComponent(soql)}`,
        "GET", undefined, crypto.randomUUID(), true);
      const contentBody = await responseJson(contentResponse);
      const records = object(contentBody) && Array.isArray(contentBody.records) ? contentBody.records : [];
      const contentRecord = records.find(object);
      if (!contentResponse.ok || !contentRecord || typeof contentRecord.ContentDocumentId !== "string" ||
          !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(contentRecord.ContentDocumentId)) {
        result = { status: contentResponse.ok ? 502 : contentResponse.status, body: contentBody ?? {
          errorCode: "SYNTHETIC_AUDIO_DOCUMENT_UNAVAILABLE",
          message: "Salesforce did not return the temporary audio document ID.",
        } };
      } else {
        contentDocumentId = contentRecord.ContentDocumentId;
        const actionArguments = { ...input.arguments, contentDocumentId };
        const response = await sfRequest(env, row, input.route, "POST",
          JSON.stringify({ inputs: [actionArguments] }), crypto.randomUUID(), true);
        result = { status: response.status, body: await responseJson(response) };
      }
    } finally {
      const cleanupPath = contentDocumentId
        ? `/services/data/v${input.apiVersion}/sobjects/ContentDocument/${contentDocumentId}`
        : `${versionPath}/${versionBody.id}`;
      let deleted = false;
      for (let attempt = 0; attempt < 2 && !deleted; attempt++) {
        try {
          const cleanupResponse = await sfRequest(env, row, cleanupPath, "DELETE", undefined, crypto.randomUUID(), true);
          deleted = cleanupResponse.status === 204 || cleanupResponse.status === 404;
          if (!deleted) cleanupError = `Temporary audio fixture cleanup returned HTTP ${cleanupResponse.status}.`;
        } catch {
          cleanupError = "Temporary audio fixture cleanup could not reach Salesforce.";
        }
      }
    }
    return { ...result!, ...(cleanupError ? { cleanupError } : {}) };
  }

  /** Create temporary Commerce context from live describes, run one cart read, and delete it. */
  async invokeCartReadWithSyntheticWebStore(ref: Key, input: {
    apiVersion: string;
    route: string;
    arguments: Record<string, unknown>;
  }, signed?: SignedRpcEnvelope): Promise<{ status: number; body: unknown; cleanupError?: string }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeCartReadWithSyntheticWebStore", [ref, input], signed);
    const routeMatch = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/v(\d+(?:\.\d+)?)\/actions\/standard\/(getCartItems|getCartPromotions)$/i,
    );
    const allowedArguments = new Set(["cartStateOrId", "effectiveAccountId", "currencyIsoCode", "userId", "pageToken"]);
    if (!key(ref) || !object(input) || !/^\d+(?:\.\d+)?$/.test(input.apiVersion) ||
        !routeMatch || routeMatch[1] !== input.apiVersion || !object(input.arguments) ||
        input.arguments.cartStateOrId !== "current" ||
        Object.keys(input.arguments).some(name => !allowedArguments.has(name))) {
      throw authFailure(400, "invalid_synthetic_cart_test", "The synthetic cart test request is invalid.");
    }

    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);

    const apiRoot = `/services/data/v${input.apiVersion}`;
    const describeResponse = await sfRequest(env, row, `${apiRoot}/sobjects/WebStore/describe`,
      "GET", undefined, crypto.randomUUID(), true);
    const describeBody = await responseJson(describeResponse);
    if (!describeResponse.ok || !object(describeBody) || !Array.isArray(describeBody.fields)) {
      return { status: describeResponse.status, body: describeBody ?? {
        errorCode: "WEBSTORE_SCHEMA_UNAVAILABLE",
        message: `Salesforce could not describe WebStore (HTTP ${describeResponse.status}).`,
      } };
    }

    const storeValues: Record<string, unknown> = {};
    let storeTypeValues: string[] = [];
    const referenceCache = new Map<string, string | null>();
    for (const field of describeBody.fields.filter(object)) {
      if (field.name === "Type" && field.type === "picklist" && Array.isArray(field.picklistValues)) {
        storeTypeValues = field.picklistValues.filter(object)
          .filter(value => value.active === true && typeof value.value === "string")
          .map(value => value.value as string);
      }
      if (field.nillable !== false || field.defaultedOnCreate === true || field.calculated === true ||
          field.autoNumber === true) continue;
      // Read-only non-permissionable defaults are assigned by Salesforce during creation.
      // Omit them and let the real create API validate the requested store configuration.
      if (field.createable !== true && field.permissionable === false) continue;
      if (typeof field.name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(field.name) ||
          field.createable !== true) {
        return { status: 422, body: {
          errorCode: "WEBSTORE_REQUIRED_FIELD_UNAVAILABLE",
          message: `The temporary WebStore requires ${String(field.name)} but the integration user cannot create that field. Automatic fixture setup needs its field write permission or the owning Commerce feature entitlement.`,
        } };
      }
      const type = typeof field.type === "string" ? field.type.toLowerCase() : "";
      if (field.name === "Name" && type === "string") {
        storeValues[field.name] = `Action Searcher temporary store probe ${crypto.randomUUID()}`;
      } else if (type === "boolean") {
        storeValues[field.name] = false;
      } else if (type === "combobox") {
        const choices = Array.isArray(field.picklistValues) ? field.picklistValues.filter(object) : [];
        const choice = choices.find(value => value.active === true && typeof value.value === "string");
        storeValues[field.name] = choice ? choice.value : "Action Searcher temporary validation";
      } else if (type === "picklist" || type === "multipicklist") {
        const choices = Array.isArray(field.picklistValues) ? field.picklistValues.filter(object) : [];
        const choice = choices.find(value => value.active === true && typeof value.value === "string");
        if (!choice) return { status: 422, body: {
          errorCode: "WEBSTORE_REQUIRED_VALUE_UNAVAILABLE",
          message: "Salesforce has no active value for a required temporary WebStore field.",
        } };
        storeValues[field.name] = choice.value;
      } else if (type === "reference") {
        const references = Array.isArray(field.referenceTo) ? field.referenceTo : [];
        let id: string | undefined;
        for (const objectName of references) {
          if (typeof objectName !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(objectName)) continue;
          if (!referenceCache.has(objectName)) {
            const soql = `SELECT Id FROM ${objectName} LIMIT 1`;
            const lookup = await sfRequest(env, row, `${apiRoot}/query?q=${encodeURIComponent(soql)}`,
              "GET", undefined, crypto.randomUUID(), true);
            const lookupBody = await responseJson(lookup);
            const records = object(lookupBody) && Array.isArray(lookupBody.records) ? lookupBody.records : [];
            const first = records.find(object);
            referenceCache.set(objectName, typeof first?.Id === "string" &&
              /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(first.Id) ? first.Id : null);
          }
          id = referenceCache.get(objectName) ?? undefined;
          if (id) break;
        }
        if (!id) return { status: 422, body: {
          errorCode: "WEBSTORE_REQUIRED_RECORD_UNAVAILABLE",
          message: "Salesforce has no live record for a required temporary WebStore reference.",
        } };
        storeValues[field.name] = id;
      } else if (type === "email") {
        storeValues[field.name] = "action-searcher@example.invalid";
      } else if (type === "phone") {
        storeValues[field.name] = "+15550100123";
      } else if (type === "url") {
        storeValues[field.name] = "https://example.invalid/action-searcher";
      } else if (["int", "integer", "double", "currency", "percent"].includes(type)) {
        storeValues[field.name] = 1;
      } else if (type === "date") {
        storeValues[field.name] = new Date().toISOString().slice(0, 10);
      } else if (type === "datetime") {
        storeValues[field.name] = new Date().toISOString();
      } else if (type === "time") {
        storeValues[field.name] = `${new Date().toISOString().slice(11, 23)}Z`;
      } else if (type === "base64") {
        storeValues[field.name] = "QWN0aW9uUHJvYmU=";
      } else if (["string", "textarea", "encryptedstring", "phone", "email", "url"].includes(type)) {
        storeValues[field.name] = "Action Searcher temporary validation";
      } else {
        return { status: 422, body: {
          errorCode: "WEBSTORE_REQUIRED_FIELD_UNSUPPORTED",
          message: "Salesforce exposes a required WebStore field type the worker cannot safely synthesize.",
        } };
      }
    }

    const storePath = `${apiRoot}/sobjects/WebStore`;
    const storeCandidates: Array<string | undefined> = storeTypeValues.length ? storeTypeValues : [undefined];
    let lastResult: { status: number; body: unknown } = {
      status: 422,
      body: { errorCode: "SYNTHETIC_WEBSTORE_TYPE_UNAVAILABLE", message: "Salesforce exposes no usable WebStore type." },
    };
    for (const storeType of storeCandidates) {
      const values = { ...storeValues, ...(storeType ? { Type: storeType } : {}) };
      const createResponse = await sfRequest(env, row, storePath, "POST", JSON.stringify(values),
        crypto.randomUUID(), true);
      const createBody = await responseJson(createResponse);
      if (!createResponse.ok || !object(createBody) || typeof createBody.id !== "string" ||
          !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(createBody.id)) {
        const errorDetails = salesforceError(createBody);
        lastResult = { status: createResponse.status, body: {
          errorCode: errorDetails.code ?? "SYNTHETIC_WEBSTORE_CREATE_FAILED",
          message: `Temporary WebStore type ${storeType ?? "default"} creation failed (HTTP ${createResponse.status}): ${errorDetails.message ?? "Salesforce returned no error details."}`,
        } };
        continue;
      }

      const storeId = createBody.id;
      let cartId: string | undefined;
      let accountId: string | undefined;
      let temporaryAccountId: string | undefined;
      let cleanupError: string | undefined;
      let result: { status: number; body: unknown } = { status: 500, body: null };
      try {
        const cartDescribeResponse = await sfRequest(env, row, `${apiRoot}/sobjects/WebCart/describe`,
          "GET", undefined, crypto.randomUUID(), true);
        const cartDescribeBody = await responseJson(cartDescribeResponse);
        if (!cartDescribeResponse.ok || !object(cartDescribeBody) || !Array.isArray(cartDescribeBody.fields)) {
          result = { status: cartDescribeResponse.status, body: {
            errorCode: "WEBCART_SCHEMA_UNAVAILABLE",
            message: `Salesforce could not describe WebCart (HTTP ${cartDescribeResponse.status}).`,
          } };
        } else {
          const cartValues: Record<string, unknown> = {};
          let cartFieldsAvailable = true;
          const accountField = cartDescribeBody.fields.filter(object).find(field =>
            field.name === "AccountId" && field.type === "reference" && field.createable === true &&
            Array.isArray(field.referenceTo) && field.referenceTo.includes("Account"));
          if (accountField) {
            const account = await existingOrSyntheticAccount(env, row, apiRoot, referenceCache);
            if ("failure" in account) {
              result = account.failure;
              cartFieldsAvailable = false;
            } else {
              accountId = account.id;
              temporaryAccountId = account.temporaryId;
            }
          }
          for (const field of cartDescribeBody.fields.filter(object)) {
            if (!cartFieldsAvailable) break;
            if ((field.name === "Status" || field.name === "Type") && field.type === "picklist" &&
                field.createable === true && Array.isArray(field.picklistValues)) {
              const preferred = field.name === "Status" ? "Active" : "Cart";
              const supported = field.picklistValues.filter(object).find(value =>
                value.active === true && typeof value.value === "string" &&
                value.value.toLowerCase() === preferred.toLowerCase());
              if (typeof supported?.value === "string") {
                cartValues[field.name] = supported.value;
                continue;
              }
            }
            if (field.name === "AccountId" && field.type === "reference" && accountId &&
                Array.isArray(field.referenceTo) && field.referenceTo.includes("Account")) {
              cartValues[field.name] = accountId;
              continue;
            }
            if (field.nillable !== false || field.defaultedOnCreate === true || field.calculated === true ||
                field.autoNumber === true) continue;
            if (typeof field.name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(field.name) ||
                field.createable !== true) {
              result = { status: 422, body: {
                errorCode: "WEBCART_REQUIRED_FIELD_UNAVAILABLE",
                message: "The temporary WebCart has a required field the integration user cannot set.",
              } };
              cartFieldsAvailable = false;
              break;
            }
            const type = typeof field.type === "string" ? field.type.toLowerCase() : "";
            if (field.name === "Name" && type === "string") {
              cartValues[field.name] = `Action Searcher temporary cart probe ${crypto.randomUUID()}`;
            } else if (field.name === "WebStoreId" && type === "reference" &&
                Array.isArray(field.referenceTo) && field.referenceTo.includes("WebStore")) {
              cartValues[field.name] = storeId;
            } else if (type === "boolean") {
              cartValues[field.name] = false;
            } else if (type === "combobox") {
              const choices = Array.isArray(field.picklistValues) ? field.picklistValues.filter(object) : [];
              const choice = choices.find(value => value.active === true && typeof value.value === "string");
              cartValues[field.name] = choice ? choice.value : "Action Searcher temporary validation";
            } else if (type === "picklist" || type === "multipicklist") {
              const choices = Array.isArray(field.picklistValues) ? field.picklistValues.filter(object) : [];
              const choice = choices.find(value => value.active === true && typeof value.value === "string");
              if (!choice) {
                result = { status: 422, body: {
                  errorCode: "WEBCART_REQUIRED_VALUE_UNAVAILABLE",
                  message: "Salesforce has no active value for a required temporary WebCart field.",
                } };
                cartFieldsAvailable = false;
                break;
              }
              cartValues[field.name] = choice.value;
            } else if (type === "reference") {
              const references = Array.isArray(field.referenceTo) ? field.referenceTo : [];
              let id: string | undefined;
              for (const objectName of references) {
                if (typeof objectName !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(objectName)) continue;
                if (!referenceCache.has(objectName)) {
                  const soql = `SELECT Id FROM ${objectName} LIMIT 1`;
                  const lookup = await sfRequest(env, row, `${apiRoot}/query?q=${encodeURIComponent(soql)}`,
                    "GET", undefined, crypto.randomUUID(), true);
                  const lookupBody = await responseJson(lookup);
                  const records = object(lookupBody) && Array.isArray(lookupBody.records) ? lookupBody.records : [];
                  const first = records.find(object);
                  referenceCache.set(objectName, typeof first?.Id === "string" &&
                    /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(first.Id) ? first.Id : null);
                }
                id = referenceCache.get(objectName) ?? undefined;
                if (id) break;
              }
              if (!id) {
                result = { status: 422, body: {
                  errorCode: "WEBCART_REQUIRED_RECORD_UNAVAILABLE",
                  message: "Salesforce has no live record for a required temporary WebCart reference.",
                } };
                cartFieldsAvailable = false;
                break;
              }
              cartValues[field.name] = id;
            } else if (type === "email") {
              cartValues[field.name] = "action-searcher@example.invalid";
            } else if (type === "phone") {
              cartValues[field.name] = "+15550100123";
            } else if (type === "url") {
              cartValues[field.name] = "https://example.invalid/action-searcher";
            } else if (["int", "integer", "double", "currency", "percent"].includes(type)) {
              cartValues[field.name] = 1;
            } else if (type === "date") {
              cartValues[field.name] = new Date().toISOString().slice(0, 10);
            } else if (type === "datetime") {
              cartValues[field.name] = new Date().toISOString();
            } else if (type === "time") {
              cartValues[field.name] = `${new Date().toISOString().slice(11, 23)}Z`;
            } else if (type === "base64") {
              cartValues[field.name] = "QWN0aW9uUHJvYmU=";
            } else if (["string", "textarea", "encryptedstring"].includes(type)) {
              cartValues[field.name] = "Action Searcher temporary validation";
            } else {
              result = { status: 422, body: {
                errorCode: "WEBCART_REQUIRED_FIELD_UNSUPPORTED",
                message: "Salesforce exposes a required WebCart field type the worker cannot synthesize.",
              } };
              cartFieldsAvailable = false;
              break;
            }
          }
          if (cartFieldsAvailable) {
            const cartName = typeof cartValues.Name === "string" ? cartValues.Name
              : `Action Searcher temporary cart probe ${crypto.randomUUID()}`;
            const cartType = typeof cartValues.Type === "string" ? cartValues.Type : "Cart";
            const commerceCartCollection = `${apiRoot}/commerce/webstores/${storeId}/carts${accountId
              ? `?effectiveAccountId=${encodeURIComponent(accountId)}` : ""}`;
            const cartResponse = await sfRequest(env, row, commerceCartCollection, "POST",
              JSON.stringify({ name: cartName, type: cartType, ...(accountId ? { effectiveAccountId: accountId } : {}) }), crypto.randomUUID(), true);
            const cartBody = await responseJson(cartResponse);
            const nestedCart = object(cartBody) && object(cartBody.cartSummary) ? cartBody.cartSummary : undefined;
            const createdCartId = object(cartBody) && typeof cartBody.cartId === "string" ? cartBody.cartId
              : object(cartBody) && typeof cartBody.id === "string" ? cartBody.id
                : nestedCart && typeof nestedCart.cartId === "string" ? nestedCart.cartId : undefined;
            if (!cartResponse.ok || !createdCartId ||
                !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(createdCartId)) {
              const errorDetails = salesforceError(cartBody);
              result = { status: cartResponse.status, body: {
                errorCode: errorDetails.code ?? "SYNTHETIC_COMMERCE_CART_CREATE_FAILED",
                message: `Temporary Commerce cart creation failed (HTTP ${cartResponse.status}): ${errorDetails.message ?? "Salesforce returned no cart ID or error details."}`,
              } };
            } else {
              cartId = createdCartId;
              // Read the actual owner assigned by Commerce; a registered integration identity
              // is not proof of cart ownership in every org/auth configuration.
              const cartRead = await sfRequest(env, row, `${apiRoot}/sobjects/WebCart/${cartId}`,
                "GET", undefined, crypto.randomUUID(), true);
              const cartRecord = await responseJson(cartRead);
              const ownerId = object(cartRecord) && typeof cartRecord.OwnerId === "string" &&
                /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(cartRecord.OwnerId) ? cartRecord.OwnerId : null;
              if (!cartRead.ok || !ownerId || !object(cartRecord) || cartRecord.WebStoreId !== storeId) {
                result = { status: cartRead.ok ? 422 : cartRead.status, body: {
                  errorCode: "COMMERCE_CART_OWNERSHIP_UNVERIFIED",
                  message: "Salesforce did not expose the created cart's owning user and matching store. The action will not run with assumed ownership." } };
              } else {
              // Commerce may assign a different effective buyer account than a supplied query hint.
              if (typeof cartRecord.AccountId === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(cartRecord.AccountId)) {
                accountId = cartRecord.AccountId;
              }
              const commerceCartPath = `${apiRoot}/commerce/webstores/${storeId}/carts/${encodeURIComponent(cartId)}${accountId
                ? `?effectiveAccountId=${encodeURIComponent(accountId)}` : ""}`;
              const activate = cartRecord.Status === "Active" ? new Response(null, { status: 204 })
                : await sfRequest(env, row, commerceCartPath, "PUT", undefined, crypto.randomUUID(), true);
              if (!activate.ok) {
                const errorDetails = salesforceError(await responseJson(activate));
                result = { status: activate.status, body: {
                  errorCode: errorDetails.code ?? "SYNTHETIC_COMMERCE_CART_ACTIVATION_FAILED",
                  message: `Temporary Commerce cart activation failed (HTTP ${activate.status}): ${errorDetails.message ?? "Salesforce returned no error details."}`,
                } };
              } else {
                const response = await sfRequest(env, row, input.route, "POST", JSON.stringify({
                  inputs: [{ ...input.arguments, cartStateOrId: cartId, webStoreId: storeId,
                    userId: ownerId,
                    ...(accountId ? { effectiveAccountId: accountId } : {}) }],
                }), crypto.randomUUID(), true);
                result = { status: response.status, body: await responseJson(response) };
                if (response.ok && (result.body === null || Array.isArray(result.body) && result.body.length === 0)) {
                  result.body = { errorCode: "COMMERCE_ACTION_OUTCOME_MISSING",
                    message: "Salesforce returned HTTP 200 without an action outcome for the verified temporary store and active cart. No success can be verified; the worker tries the remaining live store types." };
                }
                if (input.route.endsWith("/getCartPromotions") &&
                    /No Active cart/i.test(salesforceError(result.body).message ?? "")) {
                  // This read action resolves ownership differently across Commerce versions.
                  // Try only context variants for our own cart, never mutate an unrelated cart.
                  for (const state of [cartId, "current", "active"]) {
                    const retry = await sfRequest(env, row, input.route, "POST", JSON.stringify({
                      inputs: [{ ...input.arguments, cartStateOrId: state, webStoreId: storeId, userId: ownerId,
                        ...(accountId ? { effectiveAccountId: accountId } : {}) }],
                    }), crypto.randomUUID(), true);
                    result = { status: retry.status, body: await responseJson(retry) };
                    if (retry.ok && Array.isArray(result.body) && result.body.every(item => object(item) && item.isSuccess === true)) break;
                    if (!/No Active cart/i.test(salesforceError(result.body).message ?? "")) break;
                  }
                }
              }
              }
            }
          }
        }
      } finally {
        for (const [label, cleanupPath] of [
          ...(cartId ? [["Commerce cart", `${apiRoot}/sobjects/WebCart/${cartId}`] as const] : []),
          ["WebStore", `${storePath}/${storeId}`] as const,
          ...(temporaryAccountId ? [["Account", `${apiRoot}/sobjects/Account/${temporaryAccountId}`] as const] : []),
        ]) {
          let deleted = false;
          for (let attempt = 0; attempt < 2 && !deleted; attempt++) {
            try {
              const cleanup = await sfRequest(env, row, cleanupPath, "DELETE", undefined, crypto.randomUUID(), true);
              deleted = cleanup.status === 204 || cleanup.status === 404;
              if (deleted && label === "Commerce cart" && cartId) {
                // Commerce deletion can leave an owned fixture in PendingDelete. Remove that
                // specific record through the sObject API and verify it no longer exists.
                const path = `${apiRoot}/sobjects/WebCart/${cartId}`;
                const read = await sfRequest(env, row, path, "GET", undefined, crypto.randomUUID(), true);
                const record = await responseJson(read);
                if (read.status !== 404 && object(record) && record.Id === cartId && record.Status === "PendingDelete") {
                  const purge = await sfRequest(env, row, path, "DELETE", undefined, crypto.randomUUID(), true);
                  deleted = purge.ok || purge.status === 404;
                } else if (read.status !== 404) deleted = false;
                if (deleted && read.status !== 404) {
                  const verified = await sfRequest(env, row, path, "GET", undefined, crypto.randomUUID(), true);
                  deleted = verified.status === 404;
                }
              }
              if (!deleted) cleanupError = `Temporary ${label} cleanup returned HTTP ${cleanup.status}.`;
            } catch {
              cleanupError = `Temporary ${label} cleanup could not reach Salesforce.`;
            }
          }
        }
      }
      lastResult = result;
      if (cleanupError) return { ...result, cleanupError };
      const outcomes = Array.isArray(result.body) ? result.body.filter(object) : [];
      if (result.status >= 200 && result.status < 300 && outcomes.length > 0 && outcomes.every(outcome =>
        outcome.isSuccess === true && (!Array.isArray(outcome.errors) || outcome.errors.length === 0))) {
        return result;
      }
    }
    return lastResult;
  }

  /** Read graph metadata using an existing graph or a temporary schema-derived draft. */
  async invokeDataGraphMetadataWithSyntheticGraph(ref: Key, input: {
    apiVersion: string;
    route: string;
  }, signed?: SignedRpcEnvelope): Promise<{ status: number; body: unknown; cleanupError?: string; alternative?: { route: string; status: number; success: boolean; errorMessage: string | null } }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeDataGraphMetadataWithSyntheticGraph", [ref, input], signed);
    return this.#invokeDataGraphContext(ref, input);
  }

  async #invokeDataGraphContext(ref: Key, input: { apiVersion: string; route: string },
    preparedRoot?: Record<string, unknown>, ownedRoot = false): Promise<{ status: number; body: unknown; cleanupError?: string; pending?: boolean;
      alternative?: { route: string; status: number; success: boolean; errorMessage: string | null } }> {
    if (!key(ref) || !object(input) || !/^\d+(?:\.\d+)?$/.test(input.apiVersion) ||
        !["cdpGetDataGraphMetadata", "cdpGetDataGraph", "cdpGetDataGraphByLookup"].some(name =>
          input.route === `/services/data/v${input.apiVersion}/actions/standard/${name}`)) {
      throw authFailure(400, "invalid_synthetic_graph_test", "The synthetic data graph test request is invalid.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);

    const apiRoot = `/services/data/v${input.apiVersion}`;
    const graphPath = `${apiRoot}/ssot/data-graphs`;
    const request = async (path: string, method: string, body?: unknown) => {
      const response = await sfRequest(env, row, path, method,
        body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000));
      return { status: response.status, ok: response.ok, body: await responseJson(response) };
    };
    const readData = !input.route.endsWith("/cdpGetDataGraphMetadata");
    if (!readData) {
      const descriptor = await request(input.route, "GET");
      if (!descriptor.ok) return { status: descriptor.status, body: descriptor.body };
      const fields = object(descriptor.body) && Array.isArray(descriptor.body.inputs) ? descriptor.body.inputs.filter(object) : [];
      if (["dataGraphApiName", "dataspaceApiName"].every(name => fields.some(field => field.name === name && field.required === false))) {
        // The live descriptor explicitly permits listing metadata in the connected org default data space.
        // This native read needs no temporary graph when the caller requests the catalog.
        const listed = await request(input.route, "POST", { inputs: [{}] });
        if (listed.ok && Array.isArray(listed.body) && listed.body.length === 1 && object(listed.body[0]) &&
          listed.body[0].isSuccess === true && (!Array.isArray(listed.body[0].errors) || !listed.body[0].errors.length) &&
          object(listed.body[0].outputValues) && typeof listed.body[0].outputValues.dataGraphMetadata === "string") {
          return { status: listed.status, body: listed.body };
        }
      }
    }
    const job = readData ? await env.DB.prepare(`SELECT graph_name, root_schema_json, owned_model_name, created_at
      FROM action_graph_context WHERE team_id=? AND org_id=? AND channel_id=? AND action_route=?`)
      .bind(ref.teamId, ref.orgId, ref.channelId, input.route)
      .first<{ graph_name: string; root_schema_json: string; owned_model_name: string | null; created_at: number }>() : null;
    if (job) {
      const saved: unknown = JSON.parse(job.root_schema_json);
      if (!object(saved) || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(job.graph_name)) {
        throw authFailure(500, "invalid_graph_context", "The saved graph context is invalid.");
      }
      preparedRoot = saved;
      ownedRoot = !!job.owned_model_name;
      if (Date.now() - job.created_at >= 24 * 60 * 60 * 1000) {
        const graphCleanup = await request(`${graphPath}/${job.graph_name}`, "DELETE");
        let clean = graphCleanup.ok || graphCleanup.status === 404;
        if (clean && job.owned_model_name) {
          if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(job.owned_model_name)) {
            throw authFailure(500, "invalid_graph_context", "The saved source context is invalid.");
          }
          const modelCleanup = await request(`${apiRoot}/ssot/data-model-objects/${job.owned_model_name}`, "DELETE");
          clean = modelCleanup.ok || modelCleanup.status === 404;
        }
        if (clean) await env.DB.prepare(`DELETE FROM action_graph_context
          WHERE team_id=? AND org_id=? AND channel_id=? AND action_route=? AND graph_name=?`)
          .bind(ref.teamId, ref.orgId, ref.channelId, input.route, job.graph_name).run();
        return { status: 422, body: { errorCode: "DATA_GRAPH_BUILD_EXPIRED",
          message: "Salesforce did not materialize the graph within 24 hours. Automatic cleanup was attempted; the context must be rebuilt on a later retry." },
          ...(!clean ? { cleanupError: "Expired graph context cleanup failed; its resource names remain tracked." } : {}) };
      }
    }
    const lookup = input.route.endsWith("/cdpGetDataGraphByLookup");
    const invoke = async (name: string, space: string, primaryKey?: string, primaryValue?: string, dmo?: string) => {
      const result = await request(input.route, "POST", {
        inputs: [{ dataGraphApiName: name, dataspaceApiName: space,
          ...(readData ? lookup ? { lookupKey: `[${dmo ? `${dmo}.` : ""}${primaryKey}=${primaryValue}]` }
            : { recordId: primaryValue } : {}) }],
      });
      const redact = (value: unknown, field = "", depth = 0): unknown => {
        if (depth > 12) return null;
        if (typeof value === "string" && ["message", "errorMessage", "error_description"].includes(field)) {
          return [name, space, primaryValue].filter((item): item is string => !!item && item.length >= 4)
            .reduce((text, argument) => text.split(argument).join("[value]"), value);
        }
        if (Array.isArray(value)) return value.map(item => redact(item, field, depth + 1));
        if (object(value)) return Object.fromEntries(Object.entries(value)
          .map(([key, child]) => [key, redact(child, key, depth + 1)]));
        return value;
      };
      return { ...result, body: redact(result.body) };
    };
    const identifier = (value: unknown): value is string => typeof value === "string" &&
      /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value);
    const existing = await request(`${graphPath}/metadata`, "GET");
    if (!existing.ok) return { status: existing.status, body: existing.body };
    if (!object(existing.body) || !Array.isArray(existing.body.dataGraphMetadata)) return { status: 502, body: {
      errorCode: "DATA_GRAPH_SCHEMA_UNAVAILABLE", message: "Salesforce returned an invalid Data Graph metadata response.",
    } };
    const graphs = existing.body.dataGraphMetadata.filter(object);
    const candidates = graphs.filter(item => identifier(item.developerName ?? item.name) &&
      identifier(item.dataspaceName ?? item.dataSpaceName)).slice(0, 8);
    if (!readData) for (const graph of candidates) {
      const result = await invoke(String(graph.developerName ?? graph.name),
        String(graph.dataspaceName ?? graph.dataSpaceName));
      if (!missingGraphDefinition(result.body)) return { status: result.status, body: result.body };
      // A catalog entry without a usable definition cannot ground this native read.
      // Preserve all existing graphs; prepare a separately owned graph if none can be read.
    }

    const metadata = await request(`${apiRoot}/ssot/data-model-objects`, "GET");
    if (!metadata.ok) return { status: metadata.status, body: metadata.body };
    const models = preparedRoot ? [preparedRoot] : object(metadata.body) && Array.isArray(metadata.body.dataModelObject)
      ? metadata.body.dataModelObject.filter(object) : [];
    if (readData && !preparedRoot && models.length >= 50) {
      for (let offset = 50; offset <= 1850; offset += 200) {
        const page = await request(`${apiRoot}/ssot/data-model-objects?limit=200&offset=${offset}`, "GET");
        if (!page.ok) return { status: page.status, body: page.body };
        const items = object(page.body) && Array.isArray(page.body.dataModelObject)
          ? page.body.dataModelObject.filter(object) : [];
        models.push(...items);
        if (items.length < 200) break;
      }
    }
    const roots = models.filter(item => item.isEnabled === true && item.creationType !== "Adg" && identifier(item.name) &&
      identifier(item.dataSpaceName) && Array.isArray(item.fields) &&
      item.fields.some(field => object(field) && field.isPrimaryKey === true && identifier(field.name)));
    let root = roots.find(item => String(item.category).toLowerCase() === "profile") ?? roots[0];
    if (readData && !root && !preparedRoot) return this.#provisionDataGraphSource(ref, input, request);
    if (!root || !Array.isArray(root.fields)) return { status: 422, body: {
      errorCode: "DATA_GRAPH_CONTEXT_MISSING",
      message: "No accessible data graph or enabled primary-key data model object is available for the probe.",
    } };
    let fields = root.fields.filter(object).filter(field => identifier(field.name) &&
      (field.isPrimaryKey === true || field.name === "KQ_Id__c" ||
        String(field.usageTag).toUpperCase() === "KEY_QUALIFIER"));
    if (fields.some(field => typeof field.type !== "string")) return { status: 422, body: {
      errorCode: "DATA_GRAPH_SCHEMA_UNAVAILABLE",
      message: "The live data model key fields do not expose types needed to create a draft graph.",
    } };
    let primaryValue: string | undefined;
    let primaryKey = fields.find(field => field.isPrimaryKey === true)?.name as string;
    let populated: Array<{ candidate: typeof root; keyName: string; value: string }> = [];
    if (readData) {
      // PROFILE-first (canonical graph roots), then catalog order. Collect up
      // to 3 populated roots so an activation refusal falls through to the
      // next root instead of failing the probe on the first catalog entry.
      const ordered = [...roots.slice(0, 24)].sort((a, b) =>
        Number(String((b as Record<string, unknown>).category).toLowerCase() === "profile") -
        Number(String((a as Record<string, unknown>).category).toLowerCase() === "profile"));
      for (const candidate of ordered) {
        if (populated.length >= 3) break;
        const candidateKey = (candidate.fields as unknown[]).find(field => object(field) && field.isPrimaryKey === true) as Record<string, unknown>;
        const keyName = String(candidateKey.name);
        const path = `${apiRoot}/ssot/query-sql?dataspace=${encodeURIComponent(String(candidate.dataSpaceName))}`;
        const schema = await request(path, "POST", { sql: `SELECT * FROM "${candidate.name}" LIMIT 0` });
        const columns = object(schema.body) && Array.isArray(schema.body.metadata) ? schema.body.metadata.filter(object) : [];
        if (!schema.ok || !columns.some(column => column.name === keyName)) continue;
        const sample = await request(path, "POST", { sql: `SELECT "${keyName}" FROM "${candidate.name}" WHERE "${keyName}" IS NOT NULL LIMIT 1` });
        const values = object(sample.body) && Array.isArray(sample.body.data) ? sample.body.data : [];
        const first = values[0];
        const value = Array.isArray(first) ? first[0] : object(first) ? first[keyName] : undefined;
        if (!sample.ok || (typeof value !== "string" && typeof value !== "number") ||
            !/^[A-Za-z0-9_.:@/-]{1,256}$/.test(String(value))) continue;
        populated.push({ candidate, keyName, value: String(value) });
      }
      if (populated.length) {
        root = populated[0].candidate;
        fields = (root.fields as unknown[]).filter(object).filter(field => identifier(field.name) &&
          (field.isPrimaryKey === true || String(field.usageTag).replaceAll("_", "").toUpperCase() === "KEYQUALIFIER"));
        primaryKey = fields.find(field => field.isPrimaryKey === true)?.name as string;
        primaryValue = populated[0].value;
      }
      if (!populated.length && !preparedRoot) return this.#provisionDataGraphSource(ref, input, request);
      if (!populated.length) return { status: 422, body: {
        errorCode: "DATA_GRAPH_SOURCE_MAPPING_REQUIRED",
        message: "Automatically paginated live DMOs and checked physical key schemas and source rows; no populated, mapped primary-key DMO is available. Data 360 source ingestion and primary-key mapping are needed.",
      } };
      /* Recheck the selected physical schema before provisioning. */
      // Identifiers are validated against live metadata; query only the key, never a full customer record.
      const queryPath = `${apiRoot}/ssot/query-sql?dataspace=${encodeURIComponent(String(root.dataSpaceName))}`;
      const schema = await request(queryPath, "POST", { sql: `SELECT * FROM "${root.name}" LIMIT 0` });
      if (!schema.ok) return { status: schema.status, body: schema.body };
      const columns = object(schema.body) && Array.isArray(schema.body.metadata) ? schema.body.metadata.filter(object) : [];
      if (!columns.some(column => column.name === primaryKey)) return { status: 422, body: {
        errorCode: "DATA_GRAPH_SOURCE_MAPPING_REQUIRED",
        message: "Live DMO metadata advertises a primary key absent from its physical query schema. Automatically checked SQL metadata; Data 360 source ingestion and primary-key mapping are needed before this action can run.",
      } };
      const source = await request(queryPath,
        "POST", { sql: `SELECT "${primaryKey}" FROM "${root.name}" WHERE "${primaryKey}" IS NOT NULL LIMIT 1` });
      if (!source.ok) return { status: source.status, body: source.body };
      const rows = object(source.body) && Array.isArray(source.body.rows) ? source.body.rows
        : object(source.body) && Array.isArray(source.body.data) ? source.body.data : [];
      const first = rows[0];
      const value = Array.isArray(first) ? first[0] : object(first) ? first[primaryKey] : undefined;
      if ((typeof value !== "string" && typeof value !== "number") ||
          !/^[A-Za-z0-9_.:@/-]{1,256}$/.test(String(value))) return { status: 422, body: {
        errorCode: "DATA_GRAPH_SOURCE_DATA_REQUIRED",
        message: "Data Graph source has no usable primary key. Automatically attempted live DMO key discovery; a populated, mapped Data 360 source is needed before graph activation and action execution.",
      } };
      primaryValue = String(value);
    }
    let name = job?.graph_name ?? `ActionProbe${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const draftPayload = (draftName: string) => ({
      name: draftName, label: draftName, creationMode: "draft", type: "NONE", dataspaceName: root.dataSpaceName,
      primaryObjectName: root.name,
      sourceObject: {
        devName: "ProbeRoot", name: root.name, label: root.label ?? root.name, jsonPath: "$",
        type: root.creationType === "Standard" ? "standard" : "custom",
        fields: fields.map((field, index) => ({
          devName: `ProbeField${index}`, sourceFieldName: field.name,
          isKeyColumn: field.isPrimaryKey === true, isProjected: true, dataType: field.type,
          usageTag: field.name === "KQ_Id__c" || String(field.usageTag).replaceAll("_", "").toUpperCase() === "KEYQUALIFIER"
            ? "KEY_QUALIFIER" : "NONE",
        })),
        relatedObjects: [],
      },
    });
    // Phase 1 (fresh read probes only): create+activate against each populated
    // root in PROFILE-first order until one activates. Refused drafts are
    // deleted immediately so fallthrough leaves no residue.
    let draftReady = false;
    let lastRefusal: { status: number; body: unknown } | null = null;
    if (readData && !job) {
      for (const [index, attempt] of populated.entries()) {
        root = attempt.candidate;
        fields = (root.fields as unknown[]).filter(object).filter(field => identifier(field.name) &&
          (field.isPrimaryKey === true || String(field.usageTag).replaceAll("_", "").toUpperCase() === "KEYQUALIFIER"));
        primaryKey = attempt.keyName;
        primaryValue = attempt.value;
        name = `${name.replace(/R\d+$/, "")}R${index}`;
        const draftPath = `${graphPath}/${name}`;
        const draftCreate = await request(graphPath, "POST", draftPayload(name));
        if (!draftCreate.ok) {
          lastRefusal = { status: draftCreate.status, body: draftCreate.body };
          continue;
        }
        const draftActivation = await request(`${draftPath}/actions/activate`, "POST", {
          fullRefreshConfig: { schedule: { frequency: 1, timeGranularity: "Day" } },
        });
        if (!draftActivation.ok || !object(draftActivation.body) || draftActivation.body.success !== true) {
          lastRefusal = { status: draftActivation.ok ? 422 : draftActivation.status, body: draftActivation.body };
          const swept = await request(draftPath, "DELETE");
          if (!swept.ok && swept.status !== 404) return { status: lastRefusal.status, body: lastRefusal.body,
            cleanupError: `Refused Data Graph draft ${name} could not be deleted; its resource name remains tracked.` };
          continue;
        }
        draftReady = true;
        break;
      }
      if (!draftReady) return { status: lastRefusal?.status ?? 422, body: lastRefusal?.body ?? {
        errorCode: "DATA_GRAPH_CREATE_PAYLOAD_ERROR",
        message: "Salesforce refused every populated graph root at create or activate time.",
      } };
    }
    const temporaryPath = `${graphPath}/${name}`;
    let created = false;
    let cleanupError: string | undefined;
    let pending = false;
    let result: { status: number; body: unknown; alternative?: { route: string; status: number; success: boolean; errorMessage: string | null } };
    try {
      created = true;
      const create = (job || draftReady) ? { ok: true, status: 200, body: null } : await request(graphPath, "POST", draftPayload(name));
      created = create.ok || create.status >= 500;
      if (!create.ok) {
        result = { status: create.status, body: create.body };
      } else {
        if (readData) {
          const activation = (job || draftReady) ? { ok: true, status: 200, body: { success: true } } : await request(`${temporaryPath}/actions/activate`, "POST", {
            fullRefreshConfig: { schedule: { frequency: 1, timeGranularity: "Day" } },
          });
          if (!activation.ok || !object(activation.body) || activation.body.success !== true) {
            result = { status: activation.ok ? 422 : activation.status, body: activation.body };
          }
          else {
            if (!job) await env.DB.prepare(`INSERT INTO action_graph_context
              (team_id,org_id,channel_id,action_route,graph_name,root_schema_json,owned_model_name,created_at)
              VALUES (?,?,?,?,?,?,?,?)`).bind(ref.teamId, ref.orgId, ref.channelId, input.route, name,
                JSON.stringify({ name: root.name, label: root.label, category: root.category,
                  creationType: root.creationType, dataSpaceName: root.dataSpaceName, isEnabled: true, fields }),
                ownedRoot ? String(root.name) : null, Date.now()).run();
            // Bound readiness checks. Never treat activation acceptance as an action success.
            result = { status: 409, body: { errorCode: "DATA_GRAPH_BUILD_PENDING",
              message: "Automatically created and activated a schema-derived graph; Salesforce materialization is not ready for action execution." } };
            let materialized = false;
            for (let attempt = 0; attempt < 8; attempt++) {
              const readiness = await request(`${apiRoot}/query?q=${encodeURIComponent(
                `SELECT LastRunStatus,RecordCount FROM DataGraph WHERE DataGraphApiName='${name}' LIMIT 1`)}`, "GET");
              if (!readiness.ok) {
                pending = false;
                result = { status: readiness.status, body: readiness.body };
                break;
              }
              const records = object(readiness.body) && Array.isArray(readiness.body.records) ? readiness.body.records : [];
              const state = records.length && object(records[0]) ? String(records[0].LastRunStatus ?? "") : "";
              if (/^(success|succeeded|completed|active)$/i.test(state)) { materialized = true; break; }
              if (/fail|error|cancel/i.test(state)) {
                pending = false;
                result = { status: 422, body: { errorCode: "DATA_GRAPH_BUILD_FAILED",
                  message: `Salesforce Data Graph materialization ended with status ${state}. Automatic cleanup will run before rebuilding context.` } };
                break;
              }
              pending = true;
              if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 5000));
            }
            if (materialized) {
              pending = false;
              const action = await invoke(name, String(root.dataSpaceName), primaryKey, primaryValue, String(root.name));
              result = { status: action.status, body: action.body };
              pending = /DaoEntity.*not found|materializ/i.test(salesforceError(result.body).message ?? "");
            }
            if (pending) result = { status: 202, body: {
              errorCode: "DATA_GRAPH_BUILD_PENDING",
              message: "Automatically created and activated a graph with a real source key. Salesforce materialization is pending; the scheduler will reuse this graph and retry the action, then clean up the temporary context.",
            } };
            if (!pending && /unknown column|json_blob/i.test(salesforceError(result.body).message ?? "")) {
              const liveRoute = `${graphPath}/data/${name}${lookup ? "" : `/${encodeURIComponent(primaryValue!)}`}?dataspace=${encodeURIComponent(String(root.dataSpaceName))}&live=true${lookup
                ? `&lookupKeys=${encodeURIComponent(`[${root.name}.${primaryKey}=${primaryValue}]`)}` : ""}`;
              const live = await request(liveRoute, "GET");
              const containsKey = (value: unknown, depth = 0): boolean => depth < 8 && (
                (typeof value === "string" || typeof value === "number") ? String(value) === primaryValue
                : Array.isArray(value) ? value.some(item => containsKey(item, depth + 1))
                  : object(value) ? Object.values(value).some(item => containsKey(item, depth + 1)) : false);
              const success = live.ok && !salesforceError(live.body).code && containsKey(live.body);
              let errorMessage = success ? null : salesforceError(live.body).message ?? "Salesforce returned no matching graph record.";
              if (errorMessage) for (const value of [name, String(root.dataSpaceName), primaryValue!].filter(value => value.length >= 4)) {
                errorMessage = errorMessage.split(value).join("[value]");
              }
              result.alternative = { route: `${graphPath}/data/{graph}${lookup ? "" : "/{recordId}"}?live=true`,
                status: live.status, success, errorMessage };
            }
          }
        } else {
          const action = await readOwnedGraphMetadata({ invoke: () => invoke(name, String(root.dataSpaceName)),
            activate: () => request(temporaryPath + "/actions/activate", "POST", {
              fullRefreshConfig: { schedule: { frequency: 1, timeGranularity: "Day" } } }),
            wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) });
          result = { status: action.status, body: action.body };
        }
      }
    } finally {
      if (created && !pending) {
        let deleted = false;
        for (let attempt = 0; attempt < 2 && !deleted; attempt++) {
          try {
            const cleanup = await request(temporaryPath, "DELETE");
            deleted = cleanup.ok || cleanup.status === 404 || (cleanup.status === 400 &&
              /data graph not found/i.test(salesforceError(cleanup.body).message ?? ""));
            if (!deleted) cleanupError = `Temporary Data Graph cleanup returned HTTP ${cleanup.status}.`;
          } catch {
            cleanupError = "Temporary Data Graph cleanup could not reach Salesforce.";
          }
        }
        if (deleted) cleanupError = undefined;
        if (deleted && readData) {
          if (job?.owned_model_name) {
            const cleanup = await request(`${apiRoot}/ssot/data-model-objects/${job.owned_model_name}`, "DELETE");
            if (!cleanup.ok && cleanup.status !== 404) cleanupError = `Temporary source cleanup returned HTTP ${cleanup.status}.`;
          }
          if (!cleanupError) await env.DB.prepare(`DELETE FROM action_graph_context
            WHERE team_id=? AND org_id=? AND channel_id=? AND action_route=? AND graph_name=?`)
            .bind(ref.teamId, ref.orgId, ref.channelId, input.route, name).run();
        }
      }
    }
    return { ...result, ...(pending ? { pending: true } : {}), ...(cleanupError ? { cleanupError } : {}) };
  }

  /** Tenant-authorized preparation endpoints for Data Graph read actions. */
  async invokeDataGraphWithContext(ref: Key, input: { apiVersion: string }, signed?: SignedRpcEnvelope) {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeDataGraphWithContext", [ref, input], signed);
    return this.invokeDataGraphMetadataWithSyntheticGraph(ref, { ...input,
      route: `/services/data/v${input.apiVersion}/actions/standard/cdpGetDataGraph` });
  }

  async invokeDataGraphByLookupWithContext(ref: Key, input: { apiVersion: string }, signed?: SignedRpcEnvelope) {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeDataGraphByLookupWithContext", [ref, input], signed);
    return this.invokeDataGraphMetadataWithSyntheticGraph(ref, { ...input,
      route: `/services/data/v${input.apiVersion}/actions/standard/cdpGetDataGraphByLookup` });
  }

  async #provisionDataGraphSource(ref: Key, input: { apiVersion: string; route: string },
    request: (path: string, method: string, body?: unknown) => Promise<{ status: number; ok: boolean; body: unknown }>) {
    const root = `/services/data/v${input.apiVersion}/ssot`;
    const catalog = await request(`${root}/data-lake-objects`, "GET");
    if (!catalog.ok) return { status: catalog.status, body: catalog.body };
    const objects = object(catalog.body) && Array.isArray(catalog.body.dataLakeObjects)
      ? catalog.body.dataLakeObjects.filter(object) : [];
    const safe = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value);
    let source: Record<string, unknown> | undefined;
    let keyField: Record<string, unknown> | undefined;
    let space: string | undefined;
    for (const candidate of objects.slice(0, 12)) {
      const field = Array.isArray(candidate.fields) ? candidate.fields.filter(object)
        .find(field => field.isPrimaryKey === true && safe(field.name) && typeof field.dataType === "string") : undefined;
      const spaces = Array.isArray(candidate.dataSpaceInfo) ? candidate.dataSpaceInfo.filter(object) : [];
      const candidateSpace = spaces.find(item => safe(item.name))?.name;
      if (!safe(candidate.name) || !field || !safe(candidateSpace)) continue;
      const sample = await request(`${root}/query-sql?dataspace=${encodeURIComponent(candidateSpace)}`, "POST", {
        sql: `SELECT "${field.name}" FROM "${candidate.name}" WHERE "${field.name}" IS NOT NULL LIMIT 1`,
      });
      if (sample.ok && object(sample.body) && Number(sample.body.returnedRows) > 0) {
        source = candidate; keyField = field; space = candidateSpace; break;
      }
    }
    if (!source || !keyField || !space) return { status: 422, body: {
      errorCode: "DATA_GRAPH_SOURCE_DATA_REQUIRED",
      message: "Automatically inspected DMO and DLO keys; no populated source is accessible. A connected Data 360 ingestion source is needed before temporary DMO mapping and graph activation can run.",
    } };
    const name = `ActionProbe${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    let modelName: string | undefined;
    let mappingName: string | undefined;
    let cleanupError: string | undefined;
    let result: { status: number; body: unknown; cleanupError?: string; pending?: boolean } = { status: 422, body: {
      errorCode: "DATA_GRAPH_SOURCE_MAPPING_PENDING", message: "Automatic DMO mapping has not materialized yet.",
    } };
    try {
      result = await (async () => {
      const create = await request(`${root}/data-model-objects`, "POST", {
        name, label: name, category: "Other", dataSpaceName: space,
        fields: [{ name: "ProbeKey", label: "Probe key", dataType: keyField.dataType, isPrimaryKey: true }],
      });
      if (!create.ok || !object(create.body) || !safe(create.body.name)) return { status: create.status, body: create.body };
      modelName = create.body.name;
      const fields = Array.isArray(create.body.fields) ? create.body.fields.filter(object) : [];
      const primary = fields.find(field => field.isPrimaryKey === true && safe(field.name));
      if (!primary) return { status: 502, body: { errorCode: "DATA_GRAPH_SOURCE_SCHEMA_INVALID",
        message: "Created DMO did not expose a primary key; automatic setup cannot continue." } };
      const mapping = await request(`${root}/data-model-object-mappings`, "POST", {
        sourceEntityDeveloperName: source.name, targetEntityDeveloperName: modelName,
        fieldMapping: [{ sourceFieldDeveloperName: keyField.name, targetFieldDeveloperName: primary.name }],
      });
      if (!mapping.ok || !object(mapping.body) || !safe(mapping.body.developerName)) {
        return { status: mapping.status, body: mapping.body };
      }
      mappingName = mapping.body.developerName;
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await request(`${root}/data-model-objects/${modelName}`, "GET");
        const sample = await request(`${root}/query-sql?dataspace=${encodeURIComponent(space)}`, "POST", {
          sql: `SELECT "${primary.name}" FROM "${modelName}" WHERE "${primary.name}" IS NOT NULL LIMIT 1`,
        });
        if (current.ok && object(current.body) && sample.ok && object(sample.body) && Number(sample.body.returnedRows) > 0) {
          result = await this.#invokeDataGraphContext(ref, input, { ...current.body, isEnabled: true }, true);
          break;
        }
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 2000));
      }
      return result;
      })();
    } finally {
      // Deleting the only DLO mapping independently is rejected by Salesforce. Delete our DMO first;
      // Salesforce removes its owned mapping with it, then independently check the mapping is gone.
      for (const path of [modelName ? `${root}/data-model-objects/${modelName}` : null]) {
        if (!path || result.pending) continue;
        try {
          const cleanup = await request(path, "DELETE");
          if (!cleanup.ok && cleanup.status !== 404) cleanupError = `Temporary Data Graph source cleanup returned HTTP ${cleanup.status}.`;
        } catch { cleanupError = "Temporary Data Graph source cleanup could not reach Salesforce."; }
      }
      if (mappingName && !result.pending) {
        try {
          const check = await request(`${root}/data-model-object-mappings/${mappingName}`, "GET");
          if (check.ok) cleanupError = "Temporary Data Graph mapping still exists after DMO cleanup.";
        } catch { cleanupError = "Temporary Data Graph mapping cleanup could not be verified."; }
      }
    }
    return { ...result, ...(cleanupError ? { cleanupError } : {}) };
  }

  /** Infer a typed prompt fixture through the real Salesforce preview validator. */
  async prepareTypedPromptContext(ref: Key, input: { apiVersion: string; route: string;
    arguments: Record<string, unknown> }, signed?: SignedRpcEnvelope): Promise<{ status: number; body: unknown;
      arguments?: Record<string, unknown>; schemas?: Record<string, unknown>; executionRoute?: string }> {
    await verifySignedRpcCall(this.env as AuthEnv, "prepareTypedPromptContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/v(\d+(?:\.\d+)?)\/actions\/custom\/generatePromptResponse\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    if (!key(ref) || !object(input) || !match || match[1] !== input.apiVersion || !object(input.arguments) ||
        JSON.stringify(input.arguments).length > 32_000) {
      throw authFailure(400, "invalid_prompt_context", "A discovered prompt route and bounded input arguments are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const templatePath = `/services/data/v${input.apiVersion}/einstein/prompt-templates/${match[2]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await sfRequest(env, row, path, method,
        body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true);
      return { status: response.status, ok: response.ok, body: await responseJson(response) };
    };
    const metadata = await request(templatePath);
    if (!metadata.ok) return { status: metadata.status, body: metadata.body };
    const relationships = object(metadata.body) && object(metadata.body.childRelationships)
      ? metadata.body.childRelationships : {};
    const versions = Array.isArray(relationships.GenAiPromptTemplateVersions)
      ? relationships.GenAiPromptTemplateVersions.filter(object) : [];
    const version = versions.find(item => object(item.fields) && object(item.fields.Status) &&
      item.fields.Status.value === "Published");
    const inputs = version && object(version.childRelationships) &&
      Array.isArray(version.childRelationships.GenAiPromptTemplateInputs)
      ? version.childRelationships.GenAiPromptTemplateInputs.filter(object) : [];
    const typed: Array<{ name: string; definition: string; value: Record<string, unknown> }> = [];
    const args: Record<string, unknown> = {};
    for (const item of inputs) {
      if (!object(item.fields)) continue;
      const name = object(item.fields.ReferenceName) ? item.fields.ReferenceName.value : undefined;
      const definition = object(item.fields.Definition) ? item.fields.Definition.value : undefined;
      if (typeof name !== "string" || !/^Input:[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name) ||
          typeof definition !== "string") continue;
      if (definition.startsWith("lightningtype://")) {
        const value = {};
        typed.push({ name, definition, value }); args[name] = { value };
      } else if (Object.hasOwn(input.arguments, name)) args[name] = input.arguments[name];
    }
    // Error paths are relative to one typed document. Ambiguous multi-document repair is rejected.
    if (typed.length !== 1) return { status: 422, body: { errorCode: "PROMPT_CONTEXT_SCHEMA_UNAVAILABLE",
      message: "The live template must expose exactly one typed document for validation-based context discovery." } };
    const executionRoute = `${templatePath}/generations`;
    for (let attempt = 0; attempt < 8; attempt++) {
      const preview = await request(executionRoute, "POST", { isPreview: true,
        inputParams: { valueMap: args }, additionalConfig: { applicationName: "PromptBuilderPreview" } });
      if (preview.ok && object(preview.body) && typeof preview.body.prompt === "string" && preview.body.prompt.length) {
        return { status: preview.status, body: null, arguments: args, executionRoute,
          schemas: { [typed[0].name]: { definition: typed[0].definition,
            source: "salesforce_live_validation", schema: inferredContextSchema(typed[0].value) } } };
      }
      const error = salesforceError(preview.body);
      if (preview.status !== 400 || error.code !== "INVALID_INPUT" || !error.message ||
          !repairPromptContext(typed[0].value, error.message)) {
        return { status: preview.status, body: preview.body };
      }
    }
    return { status: 422, body: { errorCode: "PROMPT_CONTEXT_VALIDATION_EXHAUSTED",
      message: "Salesforce rejected the synthetic typed context after the bounded discovery attempts." } };
  }

  /** Build disposable lookup records using the active Flow's own input/filter definitions. */
  async describeFlowCreationContext(ref: Key, input: { route: string }, signed?: SignedRpcEnvelope): Promise<{ status: number; body: unknown; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "describeFlowCreationContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(/^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    if (!key(ref) || !match) throw authFailure(400, "invalid_flow_creation_context", "A discovered Flow route is required.");
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string) => {
      const response = await sfRequest(env, row, path, "GET", undefined, crypto.randomUUID(), true, AbortSignal.timeout(60_000));
      return { status: response.status, ok: response.ok, body: await responseJson(response) };
    };
    const descriptor = await request(input.route);
    if (!descriptor.ok) return descriptor;
    const local = match[2].includes("__") ? match[2].slice(match[2].indexOf("__") + 2) : match[2];
    const definition = await request(`${root}/tooling/query?q=${encodeURIComponent(`SELECT DeveloperName,NamespacePrefix,ActiveVersionId FROM FlowDefinition WHERE DeveloperName IN ('${match[2]}','${local}')`)}`);
    if (!definition.ok) return definition;
    const definitions = object(definition.body) && Array.isArray(definition.body.records) ? definition.body.records.filter(object)
      .filter(item => (item.NamespacePrefix ? `${item.NamespacePrefix}__${item.DeveloperName}` : item.DeveloperName) === match[2]) : [];
    const versionId = definitions.length === 1 ? definitions[0].ActiveVersionId : null;
    if (typeof versionId !== "string" || !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(versionId)) {
      const contract = await describePackagedFlowContract({ root, route: input.route, descriptor: descriptor.body, request });
      return contract.status !== 422 ? contract : { status: 422, body: { errorCode: "FLOW_CREATION_METADATA_UNAVAILABLE", message: "The active Flow metadata is not exposed and its descriptor does not declare a complete typed record-creation contract." } };
    }
    const retrieved = await request(`${root}/tooling/query?q=${encodeURIComponent(`SELECT Metadata FROM Flow WHERE Id='${versionId}'`)}`);
    if (!retrieved.ok) return retrieved;
    const metadata = object(retrieved.body) && Array.isArray(retrieved.body.records) ? retrieved.body.records.filter(object)[0]?.Metadata : null;
    if (isQueryOnlyFlowMetadata(metadata)) return { status: 422,
      body: { errorCode: "FLOW_CREATION_CHAIN_UNRESOLVED", message: "The active Flow is query-only and requires owned record inputs, rather than a creation lifecycle." },
      contextSchema: { source: "salesforce_active_query_only_flow_metadata", readOnlyMetadataVerified: true, activeVersionId: versionId, requiredReadFields: flowReadFields(metadata) } };
    const recipes = flowCreationRecipes(metadata);
    if (!recipes.length || !object(metadata) || !Array.isArray(metadata.variables)) return { status: 422, body: {
      errorCode: "FLOW_CREATION_CHAIN_UNRESOLVED", message: "The live Flow needs additional dependency handling beyond resolved record creation assignments." } };
    const variables = metadata.variables.filter(object).filter(item => item.isInput === true);
    const targets: Array<{ objectName: string; fields: unknown; bindings: unknown[]; fixtureAccessReady: boolean }> = [];
    const fixtures: Array<{ inputName: string; objectName: string; markerField?: string; collection: boolean; fixtureAccessReady: boolean }> = [];
    for (const recipe of recipes) {
      const schema = await request(`${root}/sobjects/${recipe.objectName}/describe`);
      if (!schema.ok) return schema;
      const fields = object(schema.body) && Array.isArray(schema.body.fields) ? schema.body.fields.filter(object) : [];
      const bindings: unknown[] = [];
      for (const assignment of recipe.fields) {
        const field = fields.find(item => item.name === assignment.field);
        if (!field) return { status: 422, body: { errorCode: "FLOW_CREATION_FIELD_UNAVAILABLE", message: "A Flow creation field is absent from the live object schema." } };
        if (assignment.inputName && field.type === "reference") {
          const references = Array.isArray(field.referenceTo) ? field.referenceTo.filter(value => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value)) : [];
          const variable = variables.find(item => item.name === assignment.inputName);
          const objectName = references.includes(variable?.objectType) ? String(variable?.objectType) : references.length === 1 ? String(references[0]) : null;
          if (!objectName || assignment.inputField && assignment.inputField !== "Id") return { status: 422, body: {
            errorCode: "FLOW_CREATION_REFERENCE_UNRESOLVED", message: "The live Flow reference requires an unambiguous disposable object context." } };
          if (!fixtures.some(item => item.inputName === assignment.inputName)) {
            const parentSchema = await request(`${root}/sobjects/${objectName}/describe`);
            if (!parentSchema.ok) return parentSchema;
            const parentFields = object(parentSchema.body) && Array.isArray(parentSchema.body.fields) ? parentSchema.body.fields.filter(object) : [];
            const markers = parentFields.filter(item => !isCompoundParent(parentFields, item) && item.calculated !== true && item.autoNumber !== true && item.filterable === true && ["string", "combobox"].includes(String(item.type)) && typeof item.length === "number" && item.length >= 48);
            const writableMarkers = markers.filter(item => item.createable === true);
            const preferredMarkers = writableMarkers.length ? writableMarkers : markers;
            const marker = preferredMarkers.find(isNameMarkerField) ?? preferredMarkers.find(item => item.nillable === false) ?? preferredMarkers[0];
            fixtures.push({ inputName: assignment.inputName, objectName, fixtureAccessReady: object(parentSchema.body) && parentSchema.body.createable === true && parentSchema.body.deletable === true && (!marker || marker.createable === true), ...(typeof marker?.name === "string" ? { markerField: marker.name } : {}), collection: assignment.collection === true });
          }
        }
        bindings.push({ ...assignment, type: field.type });
      }
      targets.push({ objectName: recipe.objectName, fixtureAccessReady: object(schema.body) && schema.body.deletable === true && schema.body.queryable === true, fields: fields.filter(field => recipe.fields.some(item => item.field === field.name)).map(field => ({ name: field.name, type: field.type })), bindings });
    }
    if (targets.some(target => !target.bindings.some(binding => object(binding) && binding.type === "reference" && fixtures.some(item => item.inputName === binding.inputName)))) return { status: 422, body: {
      errorCode: "FLOW_CREATION_OWNERSHIP_UNRESOLVED", message: "Every creation target must reference a disposable owned context before execution." } };
    const anchor = fixtures.find(item => item.markerField);
    const anchoredTarget = anchor && targets.find(target => target.bindings.some(binding => object(binding) && binding.inputName === anchor.inputName && binding.type === "reference"));
    const reference = anchoredTarget?.bindings.find(binding => object(binding) && binding.inputName === anchor?.inputName && binding.type === "reference");
    if (!anchor || !anchoredTarget || !object(reference)) return { status: 422, body: { errorCode: "FLOW_CREATION_OWNERSHIP_UNRESOLVED", message: "No queryable synthetic parent ownership anchor was discovered." } };
    const contextSchema = { source: "salesforce_live_flow_creation", fixtures, targets,
      inputVariables: variables.map(item => ({ name: item.name, dataType: item.dataType })),
      targetObject: anchoredTarget.objectName, parentContextObject: anchor.objectName, markerField: anchor.markerField,
      referenceField: reference.field, anchorInput: anchor.inputName,
      automaticSteps: ["Retrieve active Flow creation metadata", "Resolve scalar and collection assignments", "Describe target and reference object schemas", "Create disposable referenced records", "Invoke with owned context", "Query and verify created children", "Delete children and referenced fixtures and verify cleanup"] };
    return { status: 200, body: { discovered: true }, contextSchema };
  }

  async invokeFlowCreationWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeFlowCreationWithContext", [ref, input], signed);
    if (input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) throw authFailure(400, "invalid_verification_window", "A bounded verification window is required.");
    const described = await this.describeFlowCreationContext(ref, input);
    if (described.status !== 200 || !object(described.contextSchema)) return described;
    const plan = described.contextSchema;
    if ([...(Array.isArray(plan.targets) ? plan.targets : []), ...(Array.isArray(plan.fixtures) ? plan.fixtures : [])].some(item => !object(item) || item.fixtureAccessReady !== true)) {
      return { status: 403, body: { errorCode: "FLOW_CREATION_FIXTURE_PERMISSIONS_REQUIRED", message: "Live Flow targets or references lack the create/read/delete or marker access needed for verification. Run dynamic fixture permission setup and retry." }, contextSchema: plan };
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = input.route.split("/actions/")[0];
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000), fixtureCreateHeaders(method, path));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "FLOW_CREATION_UPSTREAM_UNAVAILABLE", message: "Salesforce execution or readback failed; owned cleanup will still run." } }; }
    };
    if (plan.source === "salesforce_live_flow_scalar_creation_contract") return invokeFlowScalarCreationContract({ root, route: input.route, plan, verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
    if (plan.source === "salesforce_live_flow_record_contract" || plan.source === "salesforce_live_flow_update_contract") return (plan.source === "salesforce_live_flow_update_contract" ? invokeFlowUpdateContract : invokeFlowRecordContract)({ root, route: input.route, plan, verificationWindowMs: input.verificationWindowMs, userId: row.integration_user_id, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
    return invokeOwnedFlowCreation({ root, route: input.route, plan, verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => {
        const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result;
      } });
  }

  /** Owned lifecycle for single-recordCreate invocable flows (e.g. Create_Booking). */
  async invokeRemainderBookingFlow(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeRemainderBookingFlow", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(/^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    if (!key(ref) || !match || match[2] !== "Create_Booking" ||
      (input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000))) {
      throw authFailure(400, "invalid_remainder_booking_context", "A discovered remainder booking Flow route and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000), fixtureCreateHeaders(method, path));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "REMAINDER_BOOKING_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    };
    return invokeRemainderBookingFlow({ root, route: input.route, verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
  }

  /** Invoke a spec'd managed Flow with a live platform sObject and verify the Finished outcome. */
  async invokeFlowLiveSObjectWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeFlowLiveSObjectWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(/^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    if (!key(ref) || !match || FLOW_LIVE_SOBJECT_SPECS[match[2]] === undefined ||
      (input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000))) {
      throw authFailure(400, "invalid_flow_sobject_context", "A discovered spec'd Flow route and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000), fixtureCreateHeaders(method, path));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "FLOW_SOBJECT_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; the native call was not verified." } }; }
    };
    const result = await invokeFlowLiveSObject({ root, route: input.route, actionName: match[2], request });
    return { status: result.status, body: result.body, contextSchema: result.contextSchema };
  }

  /**
   * Denial-driven fixture permission-set self-provisioning: applies the
   * auto-appliable object-crud grants in-worker through the execution
   * credential, so current and future orgs heal without the workstation
   * setup script. Attempt-driven: Tooling denials surface as
   * capabilityDenied and the caller keeps its honest setup verdict.
   */
  async selfProvisionFixtureGrants(ref: Key, input: { apiVersion: string; objects: string[] }, signed?: SignedRpcEnvelope):
    Promise<{ granted: string[]; failed: Array<{ object: string; status: number }>; assigned: boolean; capabilityDenied: boolean }> {
    await verifySignedRpcCall(this.env as AuthEnv, "selfProvisionFixtureGrants", [ref, input], signed);
    if (!key(ref) || !object(input) || !/^\d+(?:\.\d+)?$/.test(input.apiVersion) ||
      !Array.isArray(input.objects) || !input.objects.length || input.objects.length > 12 ||
      input.objects.some(name => typeof name !== "string" || name.length > 128)) {
      throw authFailure(400, "invalid_provision_request", "A bounded API version and object list are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/v${input.apiVersion}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "PROVISION_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed during fixture provisioning." } }; }
    };
    return provisionFixtureGrants({ root, userId: row.integration_user_id, objects: input.objects, request });
  }

  async invokeRecordActionWithContext(ref: Key, input: { route: string; objectApiName: string; verificationWindowMs?: number; attendeePayloadFields?: string[]; invitationPrefixField?: string; fixtureIdInput?: string; contextArgs?: Record<string, unknown> }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeRecordActionWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(/^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/standard\/(createCart|deleteCart|addCartItem|updateCartItem|createInvRsvForCart|deleteInvRsvForCart|saveAppointmentInvitationDetails|saveServiceAppointmentAttendees|cancelAppointment|createWaitlist|contactRequestAction|createCustomField|invocableApplyLeadAssignmentRules|createRecord|updateRecord|chatterPost|publishKnowledgeArticles|assignKnowledgeArticles|archiveKnowledgeArticles|deleteKnowledgeArticles|createDraftFromOnlineKnowledgeArticle|restoreKnowledgeArticleVersion|getArticleSmartLinkUrl|submitKnowledgeArticleForTranslation|activateSessionPermSet|deactivateSessionPermSet|addWorkPlans|addWorkSteps|deleteWorkPlans|choosePricebook|skillsBasedRouting|routeWork|runCampaign|contentWorkspaceEnableFolders|updateVisualization|changeOrderSummaryPreview|changeOrderSummarySubmit|registerGuestBuyer|createSearchBoostBuryRule|authorizePayment|generateWorkPlans|holdFulfillmentOrderCapacity|confirmHeldFulfillmentOrderCapacity|releaseHeldFulfillmentOrderCapacity|getFulfillmentOrderCapacityValues|createServiceReport|generateWorkOrders|getRecord|getRelatedList)$/);
    if (input?.invitationPrefixField !== undefined && (typeof input.invitationPrefixField !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(input.invitationPrefixField))) throw authFailure(400, "invalid_invitation_schema", "A discovered invitation prefix field is required.");
    if (input?.attendeePayloadFields !== undefined && (!Array.isArray(input.attendeePayloadFields) || input.attendeePayloadFields.length > 20 || input.attendeePayloadFields.some(name => typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name)))) throw authFailure(400, "invalid_attendee_schema", "A bounded live attendee schema is required.");
    if (!key(ref) || !match || typeof input.objectApiName !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(input.objectApiName) ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_record_action_context", "A discovered record action, object API name and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`, target = input.objectApiName, update = match[2] === "updateRecord";
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000), fixtureCreateHeaders(method, path));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "RECORD_ACTION_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    };
    if (['createCart','deleteCart'].includes(match[2])) {
      if(target!=='WebCart') throw authFailure(400,'invalid_cart_context','The discovered native cart lifecycle requires WebCart context.');
      return invokeCartMutation({root,route:input.route,verificationWindowMs:input.verificationWindowMs,request,
        build:async(name,marker,values)=>{const result=await synthesizeRecordValues(env,row,root,name,marker,values);return 'failure' in result?{failure:{...result.failure,ok:false}}:result;}});
    }
    if (CART_ITEM_MUTATION_ACTIONS.includes(match[2])) {
      if(target!=='WebCart') throw authFailure(400,'invalid_cart_context','The discovered native cart item lifecycle requires WebCart context.');
      return invokeCartItemMutation({root,route:input.route,verificationWindowMs:input.verificationWindowMs,request,
        build:async(name,marker,values)=>{const result=await synthesizeRecordValues(env,row,root,name,marker,values);return 'failure' in result?{failure:{...result.failure,ok:false}}:result;}});
    }
    if ((INVENTORY_RESERVATION_ACTIONS as readonly string[]).includes(match[2]) || CART_INVENTORY_RESERVATION_ACTIONS.includes(match[2])) {
      if(target!=='WebCart') throw authFailure(400,'invalid_inventory_context','The discovered native inventory reservation lifecycle requires WebCart context.');
      return invokeInventoryReservation({root,route:input.route,verificationWindowMs:input.verificationWindowMs,request,
        build:async(name,marker,values,schema)=>{const result=await synthesizeRecordValues(env,row,root,name,marker,values,new Map(),schema);return 'failure' in result?{failure:{...result.failure,ok:false}}:result;}});
    }
    if ((GUEST_BUYER_ACTIONS as readonly string[]).includes(match[2])) {
      if(target!=='WebStore') throw authFailure(400,'invalid_guest_buyer_context','The discovered native guest-buyer lifecycle requires WebStore context.');
      return invokeGuestBuyerRegistration({root,route:input.route,verificationWindowMs:input.verificationWindowMs,request,
        build:async(name,marker,values)=>{const result=await synthesizeRecordValues(env,row,root,name,marker,values);return 'failure' in result?{failure:{...result.failure,ok:false}}:result;}});
    }
    if ((SEARCH_RULE_ACTIONS as readonly string[]).includes(match[2])) {
      if(target!=='WebStore') throw authFailure(400,'invalid_search_rule_context','The discovered native search-rule lifecycle requires WebStore context.');
      return invokeSearchBoostBuryRuleWithContext({root,route:input.route,verificationWindowMs:input.verificationWindowMs,request,
        build:async(name,marker,values)=>{const result=await synthesizeRecordValues(env,row,root,name,marker,values);return 'failure' in result?{failure:{...result.failure,ok:false}}:result;}});
    }
    if ((PAYMENT_AUTH_ACTIONS as readonly string[]).includes(match[2])) {
      return invokePaymentAuthorizationWithContext({root,route:input.route,verificationWindowMs:input.verificationWindowMs,request,
        build:async(name,marker,values)=>{const result=await synthesizeRecordValues(env,row,root,name,marker,values);return 'failure' in result?{failure:{...result.failure,ok:false}}:result;}});
    }
    if ((FULFILLMENT_CAPACITY_ACTIONS as readonly string[]).includes(match[2])) {
      return invokeFulfillmentCapacityWithContext({root,route:input.route,verificationWindowMs:input.verificationWindowMs,request,
        build:async(name,marker,values)=>{const result=await synthesizeRecordValues(env,row,root,name,marker,values);return 'failure' in result?{failure:{...result.failure,ok:false}}:result;}});
    }
    if ((SERVICE_REPORT_ACTIONS as readonly string[]).includes(match[2])) {
      return invokeServiceReportWithContext({root,route:input.route,verificationWindowMs:input.verificationWindowMs,request,
        build:async(name,marker,values)=>{const result=await synthesizeRecordValues(env,row,root,name,marker,values);return 'failure' in result?{failure:{...result.failure,ok:false}}:result;}});
    }
    if ((WORK_ORDERS_ACTIONS as readonly string[]).includes(match[2])) {
      return invokeWorkOrdersWithContext({root,route:input.route,verificationWindowMs:input.verificationWindowMs,request,
        build:async(name,marker,values)=>{const result=await synthesizeRecordValues(env,row,root,name,marker,values);return 'failure' in result?{failure:{...result.failure,ok:false}}:result;}});
    }
    if (match[2] === 'contactRequestAction') return invokeContactRequestContext({root,route:input.route,userId:row.integration_user_id,verificationWindowMs:input.verificationWindowMs,request});
    if ((ORDER_SUMMARY_ACTIONS as readonly string[]).includes(match[2])) return invokeOrderSummaryPreviewWithContext({ root, route: input.route, verificationWindowMs: input.verificationWindowMs, request });
    if (match[2] === 'saveAppointmentInvitationDetails') return invokeAppointmentInvitation({ root, route: input.route, userId: row.integration_user_id, verificationWindowMs: input.verificationWindowMs, invitationPrefixField: input.invitationPrefixField, connectedOrigin: async () => (await token(env, row)).instanceUrl, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return 'failure' in result ? { failure: { ...result.failure, ok: false } } : result; } });
    if (['cancelAppointment','saveServiceAppointmentAttendees'].includes(match[2])) return invokeAppointmentCancellation({ root, route: input.route, verificationWindowMs: input.verificationWindowMs, attendeePayloadFields: input.attendeePayloadFields, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return 'failure' in result ? { failure: { ...result.failure, ok: false } } : result; } });
    if (match[2] === 'createWaitlist') return invokeWaitlistContext({ root, route: input.route, userId: row.integration_user_id,
      verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return 'failure' in result ? { failure: { ...result.failure, ok: false } } : result; } });
    if (match[2] === 'createCustomField') return invokeCustomFieldActionContext({ root, route: input.route, target, verificationWindowMs: input.verificationWindowMs, request,
      remove: async fullName => {
        if (!new RegExp('^' + target + '\\.(?:[A-Za-z][A-Za-z0-9_]*__)?AS_field_[a-f0-9]{24}__c$').test(fullName)) return { status: 400, ok: false, missing: false };
        for (let attempt = 0; attempt < 2; attempt++) {
          const auth = await token(env, row);
          const body = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata"><s:Header><m:SessionHeader><m:sessionId>${xmlText(auth.accessToken)}</m:sessionId></m:SessionHeader></s:Header><s:Body><m:deleteMetadata><m:type>CustomField</m:type><m:fullNames>${xmlText(fullName)}</m:fullNames></m:deleteMetadata></s:Body></s:Envelope>`;
          try {
            const response = await fetch(auth.instanceUrl + '/services/Soap/m/' + match[1].slice(1), { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: 'deleteMetadata' }, body, signal: AbortSignal.timeout(60_000) });
            const text = await response.text();
            if (attempt === 0 && (response.status === 401 || /INVALID_SESSION_ID/.test(text))) { tokenCache.delete(cacheKey(row)); continue; }
            const ok = response.ok && /<(?:\w+:)?success>\s*true\s*<\/(?:\w+:)?success>/.test(text);
            const missing = response.ok && /<(?:\w+:)?statusCode>\s*(?:NOT_FOUND|INVALID_CROSS_REFERENCE_KEY)\s*<\/(?:\w+:)?statusCode>/.test(text) && text.includes(fullName);
            return { status: response.status, ok, missing };
          } catch { return { status: 502, ok: false, missing: false }; }
        }
        return { status: 401, ok: false, missing: false };
      } });
    if (match[2] === 'invocableApplyLeadAssignmentRules') return invokeLeadAssignmentContext({ root, route: input.route, verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return 'failure' in result ? { failure: { ...result.failure, ok: false } } : result; } });
    if (["skillsBasedRouting", "routeWork"].includes(match[2])) return invokeRoutingContext({ root, route: input.route, target, verificationWindowMs: input.verificationWindowMs, userId: row.integration_user_id, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
    if (match[2] === "choosePricebook") return invokePricebookContext({ root, route: input.route, target, verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
    if (WORK_PLAN_CONTEXT_ACTIONS.includes(match[2])) return invokeWorkPlanContext({ root, route: input.route, verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
    if (["activateSessionPermSet", "deactivateSessionPermSet"].includes(match[2])) return invokeSessionPermissionContext({ root, route: input.route, userId: row.integration_user_id, verificationWindowMs: input.verificationWindowMs, request });
    if (Object.hasOwn(SINGLE_FIXTURE_ACTION_SPECS, match[2])) {
      const spec = SINGLE_FIXTURE_ACTION_SPECS[match[2]];
      if (target !== spec.object || input.fixtureIdInput !== spec.idInput) {
        throw authFailure(400, "invalid_single_fixture_spec", "The fixture object and identity input must match the discovered action spec.");
      }
      return invokeSingleFixtureAction({ root, route: input.route, target, idInput: spec.idInput, markerField: spec.markerField,
        ownerId: row.integration_user_id, verificationWindowMs: input.verificationWindowMs, request,
        build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
          return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
    }
    if (Object.hasOwn(FIXTURE_READ_ACTION_SPECS, match[2])) {
      const spec = FIXTURE_READ_ACTION_SPECS[match[2]];
      if (input.fixtureIdInput !== spec.idInput || !object(input.contextArgs) ||
          Object.keys(input.contextArgs).length > 20 ||
          Object.keys(input.contextArgs).some(key => typeof key !== "string" || key.length > 128)) {
        throw authFailure(400, "invalid_fixture_read_spec", "The identity input and bounded read arguments must match the discovered action spec.");
      }
      return invokeFixtureBackedRead({ root, route: input.route, target, idInput: spec.idInput,
        verifyIdentityInResponse: spec.verifyIdentityInResponse, args: input.contextArgs,
        verificationWindowMs: input.verificationWindowMs, request,
        build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
          return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
    }
    if (!["createRecord", "updateRecord", "chatterPost"].includes(match[2])) return invokeKnowledgeContext({ root, route: input.route, target, userId: row.integration_user_id, verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
    const descriptor = await request(input.route);
    if (!descriptor.ok) return descriptor;
    if (match[2] === "chatterPost") {
      if (!object(descriptor.body) || !Array.isArray(descriptor.body.inputs) || !["text", "subjectNameOrId"].every(name => object(descriptor.body) && Array.isArray(descriptor.body.inputs) && descriptor.body.inputs.some(f => object(f) && f.name === name)))
        return { status: 422, body: { errorCode: "CHATTER_ACTION_SCHEMA_MISMATCH", message: "The live Chatter action does not expose its required inputs." } };
      const child = await request(`${root}/sobjects/FeedItem/describe`);
      if (!child.ok || !object(child.body) || child.body.queryable !== true || child.body.deletable !== true || !Array.isArray(child.body.fields))
        return { status: 403, body: { errorCode: "CHATTER_FIXTURE_PERMISSIONS_REQUIRED", message: "Live feed-item read/delete access is required to verify and clean the Chatter post." } };
      const fields = child.body.fields.filter(object);
      if (!fields.some(f => f.name === "Body" && f.createable === true)) return { status: 403, body: { errorCode: "CHATTER_FIXTURE_PERMISSIONS_REQUIRED", message: "Writable feed-item body access is required." } };
      return invokeReferenceQuickAction({ root, route: input.route, target: "FeedItem", parent: target, parentField: "ParentId", fields,
        inputs: descriptor.body.inputs.filter(object), integrationUserId: row.integration_user_id, verificationWindowMs: input.verificationWindowMs,
        contextInputName: "subjectNameOrId", markerInputName: "text", markerTargetField: "Body", outputRecordField: "feedItemId", source: "salesforce_live_chatter_action", request,
        build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
          return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
    }
    if (!object(descriptor.body) || !Array.isArray(descriptor.body.inputs) ||
      !["objectApiName", "recordData", ...(update ? ["recordId"] : [])].every(name => descriptor.body && object(descriptor.body) &&
        Array.isArray(descriptor.body.inputs) && descriptor.body.inputs.some(field => object(field) && field.name === name))) {
      return { status: 422, body: { errorCode: "RECORD_ACTION_SCHEMA_MISMATCH", message: "The live record action does not declare the required request fields." } };
    }
    const schema = await request(`${root}/sobjects/${target}/describe`);
    if (!schema.ok) return schema;
    if (!object(schema.body) || schema.body.createable !== true || schema.body.deletable !== true || schema.body.queryable !== true || !Array.isArray(schema.body.fields)) {
      return { status: 403, body: { errorCode: "RECORD_ACTION_FIXTURE_PERMISSIONS_REQUIRED", message: `Automatic ${target} context requires live create, read and delete access.` } };
    }
    const fields = schema.body.fields.filter(object);
    const candidates = fields.filter(field => typeof field.name === "string" && field.createable === true && field.filterable === true &&
      (!update || field.updateable === true) && ["string", "combobox"].includes(String(field.type)) && typeof field.length === "number" && field.length >= 48);
    const markerField = candidates.find(isNameMarkerField) ?? candidates.find(field => field.nillable === false) ?? candidates[0];
    if (!markerField || typeof markerField.name !== "string") return { status: 422, body: { errorCode: "RECORD_ACTION_MARKER_UNAVAILABLE", message: "The live object has no writable and queryable ownership marker." } };
    const marker = `AS probe ${crypto.randomUUID()}`;
    const built = await synthesizeRecordValues(env, row, root, target, marker, { [markerField.name]: marker });
    if ("failure" in built) return built.failure;
    return invokeOwnedRecordAction({ root, route: input.route, target, update, markerField: markerField.name,
      marker, markerLength: Number(markerField.length), values: built.values,
      verificationWindowMs: input.verificationWindowMs, request });
  }

  async invokeApprovalActionWithContext(ref: Key, input: { route: string; verificationWindowMs?: number; reassignUserId?: string }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeApprovalActionWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/standard\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    const action = match ? approvalActionName(input.route) : null;
    if (!key(ref) || !match || !action ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000) ||
      input.reassignUserId !== undefined && !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(input.reassignUserId)) {
      throw authFailure(400, "invalid_approval_action_context", "A discovered standard approval action and bounded verification window are required.");
    }
    if (![...APPROVAL_ADVANCED_ACTIONS, APPROVAL_SUBMIT_ACTION].includes(action)) {
      throw authFailure(400, "invalid_approval_action_context", "A discovered standard approval action and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "APPROVAL_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    };
    return invokeApprovalActionWithContext({ root, route: input.route, verificationWindowMs: input.verificationWindowMs,
      reassignUserId: input.reassignUserId ?? row.integration_user_id, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
  }

  async invokeProcSimpleApprovalWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeProcSimpleApprovalWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    const action = match ? procSimpleApprovalActionName(input.route) : null;
    if (!key(ref) || !match || !action ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_proc_simple_approval_context", "A discovered simple-approval flow route and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "APPROVAL_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    };
    return invokeProcSimpleApprovalWithContext({ root, route: input.route, verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
  }

  async invokeNotificationWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeNotificationWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/sendNotification\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    const action = match ? notificationActionName(input.route) : null;
    if (!key(ref) || !match || !action ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_notification_action_context", "A discovered custom notification action and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000), fixtureCreateHeaders(method, path));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "NOTIFICATION_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    };
    return invokeNotificationWithContext({ root, route: input.route, recipientUserId: row.integration_user_id,
      verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
  }

  /** Invoke a notification-flow email consumer over an owned alert-object fixture. */
  async invokeNotificationFlowWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeNotificationFlowWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    const action = match ? notificationFlowActionName(input.route) : null;
    if (!key(ref) || !match || !action ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_notification_flow_context", "A discovered notification-flow consumer route and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "NOTIFICATION_FLOW_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    };
    // Self-email is read live: the recipient invariant (record-field mail to
    // example.invalid, creator mail to self) is asserted, never assumed.
    const self = await request(`${root}/sobjects/User/${row.integration_user_id}`);
    const selfEmail = object(self.body) ? self.body.Email : null;
    if (!self.ok || typeof selfEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(selfEmail)) {
      return { status: 422, body: { errorCode: "NOTIFICATION_FLOW_SELF_INVALID", message: "The live integration user's email could not be read; the recipient invariant cannot be proven." } };
    }
    return invokeNotificationFlowWithContext({ root, route: input.route, selfUserId: row.integration_user_id, selfEmail,
      verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
  }

  async invokeEmailAlertWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeEmailAlertWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/emailAlert\/([A-Za-z][A-Za-z0-9_]{0,127})\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    const parts = match ? emailAlertRouteParts(input.route) : null;
    if (!key(ref) || !match || !parts ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_email_alert_action_context", "A discovered custom emailAlert action and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown, extraHeaders?: Record<string, string>) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000), extraHeaders ?? fixtureCreateHeaders(method, path));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "EMAIL_ALERT_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    };
    return invokeEmailAlertWithContext({ root, route: input.route, selfUserId: row.integration_user_id,
      verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
  }

  /** Invoke a side-effect-free invocable Apex relay over owned Ended-session fixtures. */
  async invokeApexRelayWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeApexRelayWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/apex\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    const action = match ? apexRelayActionName(input.route) : null;
    if (!key(ref) || !match || !action ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_apex_relay_context", "A discovered invocable apex relay route and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "APEX_RELAY_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    };
    return invokeApexRelayWithContext({ root, route: input.route, ownerUserId: row.integration_user_id,
      verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
  }

  /** Invoke a generic sObject-id invocable Apex over an owned marked fixture. */
  async invokeApexExecWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeApexExecWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/apex\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    const action = match ? apexExecActionName(input.route) : null;
    if (!key(ref) || !match || !action ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_apex_exec_context", "A discovered invocable apex route and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "APEX_EXEC_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    };
    return invokeApexExecWithContext({ root, route: input.route, ownerUserId: row.integration_user_id,
      verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
  }

  /** Invoke an apex SOBJECT-record action with an owned fixture chain. */
  async invokeApexSObjectRecordWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeApexSObjectRecordWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/apex\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    if (!key(ref) || !match || !Object.hasOwn(APEX_SOBJECT_RECORD_SPECS, match[2]) ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_apex_sobject_record_context", "A discovered apex record action route and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "APEX_SOBJECT_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    };
    return invokeApexSObjectRecord({ root, route: input.route, actionName: match[2],
      verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
  }

  /** Invoke a dual-asset standard action with two owned assets. */
  async invokeAssetReplaceWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeAssetReplaceWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/standard\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    if (!key(ref) || !match || !Object.hasOwn(ASSET_REPLACE_SPECS, match[2]) ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_asset_replace_context", "A discovered asset replace action route and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "ASSET_REPLACE_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    };
    return invokeAssetReplace({ root, route: input.route, actionName: match[2],
      verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
  }

  /** Evaluate a decision-table action with a fully populated descriptor-built payload. */
  async invokeDecisionTableWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeDecisionTableWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/decisionTableAction\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    const action = match ? decisionTableActionName(input.route) : null;
    if (!key(ref) || !match || !action ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_decision_table_context", "A discovered decision-table action route and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "DECISION_TABLE_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; no owned rows exist for this read-only evaluation." } }; }
    };
    return invokeDecisionTableWithContext({ root, route: input.route,
      verificationWindowMs: input.verificationWindowMs, request });
  }

  async invokeApexCsvWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeApexCsvWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/apex\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    const action = match ? apexCsvActionName(input.route) : null;
    if (!key(ref) || !match || !action ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_apex_csv_context", "A discovered invocable apex route and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "APEX_CSV_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    };
    return invokeApexCsvWithContext({ root, route: input.route, ownerUserId: row.integration_user_id,
      verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
  }

  async invokeApexOverlapWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeApexOverlapWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/apex\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    const action = match ? apexOverlapActionName(input.route) : null;
    if (!key(ref) || !match || !action ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_apex_overlap_context", "A discovered invocable apex route and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "APEX_OVERLAP_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    };
    return invokeApexOverlapWithContext({ root, route: input.route, ownerUserId: row.integration_user_id,
      verificationWindowMs: input.verificationWindowMs, request });
  }

  async invokeResearchWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeResearchWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/standard\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    const action = match ? researchActionName(input.route) : null;
    if (!key(ref) || !match || !action ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_research_action_context", "A discovered standard research action and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "RESEARCH_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    };
    return invokeResearchWithOwnedContext({ root, route: input.route,
      verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
  }

  async invokeSkippedStandardWithContext(ref: Key, input: { route: string; family: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeSkippedStandardWithContext", [ref, input], signed);
    const info = typeof input?.route === "string" ? skippedStandardRouteInfo(input.route) : null;
    const family = skippedStandardFamilySlug(input?.family);
    if (!key(ref) || !info || !family ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_skipped_standard_context", "A discovered skipped-standard route, executable family, and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${info.apiVersion}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000), fixtureCreateHeaders(method, path));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "SKIPPED_STANDARD_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    };
    return invokeSkippedStandardWithOwnedContext({ root, route: input.route, family,
      ownerUserId: row.integration_user_id, verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
  }

  async invokeAgentCustomerWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeAgentCustomerWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{1,127})$/);
    if (!key(ref) || !match ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_agent_customer_context", "A discovered custom agent-flow route and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "FLOW_AGENT_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    };
    return invokeAgentFlowWithProducerContext({ root, route: input.route,
      verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => { const result = await synthesizeRecordValues(env, row, root, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
  }

  async invokeCommerceLifecycleWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeCommerceLifecycleWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/(?:standard|custom\/apex)\/([A-Za-z][A-Za-z0-9_.]{0,127})$/);
    const action = match ? commerceLifecycleActionName(input.route) : null;
    if (!key(ref) || !match || !action ||
      input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_commerce_action_context", "A discovered standard or cart-draft apex commerce action and bounded verification window are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const rawRequest = cacheLifecycleSchema(root, async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "COMMERCE_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned context cleanup will still run." } }; }
    });
    const request = async (path: string, method = "GET", body?: unknown) => {
      const summary = method === "DELETE" ? path.match(/^\/services\/data\/v\d+(?:\.\d+)?\/sobjects\/OrderSummary\/([A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)$/) : null;
      return summary ? deleteOwnedOrderSummary(root, summary[1], rawRequest) : rawRequest(path, method, body);
    };
    if (commerceLifecycleKind(action) === "cart") {
      const missing = await provisionCommerceFixtureAccess(root, rawRequest);
      if (missing.length) return { status: 422, body: { errorCode: "COMMERCE_FIXTURE_ACCESS_REQUIRED", message: "Owned cart setup requires: " + missing.join(", ") } };
    }
    if (["order", "order-submit", "fulfillment", "return"].includes(commerceLifecycleKind(action) ?? "")) {
      const missing = await provisionOwnedOrderAccess(root, request);
      if (missing.length) return { status: 422, body: { errorCode: "COMMERCE_OWNED_ORDER_ACCESS_REQUIRED", message: "Owned order setup requires: " + missing.join(", ") } };
    }
    return invokeCommerceLifecycleWithContext({ root, route: input.route,
      verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => {
        const described = await request(root + "/sobjects/" + name + "/describe");
        if (!described.ok) return { failure: described };
        const result = await synthesizeRecordValues(env, row, root, name, marker, values, new Map(), described.body);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result; } });
  }

  async invokeQuickActionWithContext(ref: Key, input: { route: string; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeQuickActionWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/quickAction\/([A-Za-z][A-Za-z0-9_]{0,127})\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    if (!key(ref) || !match) throw authFailure(400, "invalid_quick_action_context", "A discovered Quick Action route is required.");
    if (input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
      throw authFailure(400, "invalid_verification_window", "The independent verification window must be between zero and 15000 milliseconds.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${match[1]}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body),
          crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch {
        return { status: 502, ok: false, body: { errorCode: "QUICK_ACTION_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; owned contexts remain eligible for cleanup." } };
      }
    };
    const global = match[2] === "Global";
    const definition = await request(global ? `${root}/quickActions/${match[3]}/describe`
      : `${root}/sobjects/${match[2]}/quickActions/${match[3]}/describe`);
    if (!definition.ok) return quickActionRouteTerminal(definition, "describe") ?? definition;
    const ownedChildCreation = !global && object(definition.body) && ["Create", "LogACall"].includes(String(definition.body.type)) &&
      definition.body.contextSobjectType === match[2] && typeof definition.body.targetParentField === "string" &&
      /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(definition.body.targetParentField);
    const targetValid = object(definition.body) && typeof definition.body.targetSobjectType === "string" &&
      /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(definition.body.targetSobjectType);
    // Context-fixture creation: a non-global Create/LogACall with no declared
    // parent field where the target does not reference the context object at
    // all (e.g. FeedItem -> Task). The action is addressed at an owned context
    // record while the target carries its own marker.
    let contextFixtureCreation = false;
    if (!global && object(definition.body) && ["Create", "LogACall"].includes(String(definition.body.type)) &&
      !ownedChildCreation && targetValid) {
      const probe = await request(`${root}/sobjects/${definition.body.targetSobjectType}/describe`);
      if (probe.ok && object(probe.body) && Array.isArray(probe.body.fields)) {
        contextFixtureCreation = !probe.body.fields.filter(object).some(field =>
          field.type === "reference" && Array.isArray(field.referenceTo) && field.referenceTo.includes(match[2]));
      }
    }
    if (!object(definition.body) || !(global && ["Create", "LogACall"].includes(String(definition.body.type)) || !global && definition.body.type === "Update" && definition.body.targetSobjectType === match[2] || ownedChildCreation || contextFixtureCreation) ||
      !targetValid) {
      return { status: 422, body: { errorCode: "QUICK_ACTION_FIXTURE_TYPE_UNSUPPORTED", message: "The live action needs a context lifecycle beyond global creation, owned updates, creation with a declared parent reference, or context-fixture creation." } };
    }
    const target = definition.body.targetSobjectType as string;
    const descriptor = await request(input.route);
    if (!descriptor.ok) return quickActionRouteTerminal(descriptor, "describe") ?? descriptor;
    if (!object(descriptor.body) || descriptor.body.targetEntityName !== target || !Array.isArray(descriptor.body.inputs)) {
      return { status: 422, body: { errorCode: "QUICK_ACTION_TARGET_MISMATCH", message: "The action descriptor and live definition disagree." } };
    }
    const allowed = new Set(descriptor.body.inputs.filter(object).map(field => String(field.name)));
    const schema = await request(`${root}/sobjects/${target}/describe`);
    if (!schema.ok || !object(schema.body) || schema.body.queryable !== true || schema.body.deletable !== true) {
      return { status: 403, body: { errorCode: "QUICK_ACTION_FIXTURE_PERMISSIONS_REQUIRED",
        message: `Automatic ${target} context requires read and delete access for mutation verification and cleanup.`,
        setupRequirement: `${target} read and delete access for the execution user.` } };
    }
    const fields = schema.ok && object(schema.body) && Array.isArray(schema.body.fields) ? schema.body.fields.filter(object) : [];
    // Required target references resolve to live foreign keys (rows are never
    // written); without this, owned Update targets such as MessagingSession
    // cannot be created. No query runs when no required reference exists.
    const liveReferenceCache = await seedLiveReferenceCache(request, root, fields);
    const candidates = fields.filter(field => typeof field.name === "string" && (!global || allowed.has(field.name)) &&
      field.createable === true && field.filterable === true && typeof field.length === "number" && field.length >= 48 && ["string", "textarea", "combobox"].includes(String(field.type)));
    let markerField = candidates.find(isNameMarkerField) ??
      candidates.find(field => field.nillable === false) ?? candidates.find(field => ["Subject", "Title"].includes(String(field.name)));
    if (!markerField && !ownedChildCreation) {
      // Targets such as group/messaging objects expose no 48-char Name marker.
      // Fall back to a relaxed writable + filterable text field (>= 24 chars)
      // so ownership stays provable without inventing schema.
      const relaxedPool = fields.filter(field => typeof field.name === "string" && (!global || allowed.has(field.name)));
      const relaxed = selectAlternativeMarkerField(relaxedPool as TargetField[]);
      if (relaxed) markerField = { name: relaxed.name, length: relaxed.length };
    }
    if (!markerField && ownedChildCreation) return invokeReferenceQuickAction({ root, route: input.route,
      target, parent: match[2], parentField: String(definition.body.targetParentField), fields,
      inputs: descriptor.body.inputs.filter(object), integrationUserId: row.integration_user_id,
      verificationWindowMs: input.verificationWindowMs, request,
      build: async (name, marker, values) => {
        const result = await synthesizeRecordValues(env, row, root, name, marker, values, liveReferenceCache);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result;
      } });
    if (!markerField || typeof markerField.name !== "string") return { status: 422, body: {
      errorCode: "QUICK_ACTION_MARKER_UNAVAILABLE", message: "The action exposes no writable record marker for independent verification." } };
    // 36-char marker fields are UUID keys by convention (MessagingSession
    // SessionKey is trigger-validated as one); a bare UUID stays a unique
    // ownership marker while satisfying the format.
    const markerLength = typeof markerField.length === "number" ? markerField.length : 80;
    const marker = markerLength === 36 ? crypto.randomUUID() : `AS probe ${crypto.randomUUID()}`.slice(0, markerLength);
    let parentPlan: { objectName: string; field: string; markerField: string; marker: string; values: Record<string, unknown> } | undefined;
    if (ownedChildCreation) {
      const parentFieldName = String(definition.body.targetParentField);
      const parentField = fields.find(field => field.name === parentFieldName);
      if (!parentField || parentField.type !== "reference" || !Array.isArray(parentField.referenceTo) || !parentField.referenceTo.includes(match[2])) {
        return { status: 422, body: { errorCode: "QUICK_ACTION_PARENT_SCHEMA_MISMATCH", message: "The live parent field does not reference the discovered context object." } };
      }
      const parentSchema = target === match[2] ? schema : await request(root + "/sobjects/" + match[2] + "/describe");
      if (!parentSchema.ok || !object(parentSchema.body) || parentSchema.body.queryable !== true || parentSchema.body.deletable !== true || !Array.isArray(parentSchema.body.fields)) {
        return { status: 403, body: { errorCode: "QUICK_ACTION_PARENT_PERMISSIONS_REQUIRED", message: "Automatic parent context requires live read, create and delete access.",
          setupRequirement: `${match[2]} read, create and delete access for the execution user.` } };
      }
      const parentFields = parentSchema.body.fields.filter(object).filter(field => typeof field.name === "string" && field.createable === true && field.filterable === true && typeof field.length === "number" && field.length >= 48 &&
        ["string", "textarea", "combobox"].includes(String(field.type)));
      const parentMarkerField = parentFields.find(isNameMarkerField) ??
        parentFields.find(field => field.nillable === false) ?? parentFields.find(field => ["Subject", "Title"].includes(String(field.name)));
      if (!parentMarkerField || typeof parentMarkerField.name !== "string") return { status: 422, body: { errorCode: "QUICK_ACTION_PARENT_MARKER_UNAVAILABLE", message: "The live context has no writable, filterable ownership marker with enough space for a unique identity." } };
      const parentMarker = "AS context " + crypto.randomUUID();
      // Required parent references (Case.BusinessHoursId, FeedItem.ParentId)
      // seed from live lookups, mirroring the target seeding above; borrowed
      // rows are never written, and unresolved fields fail honest through the
      // builder as before. The unique parent marker stays authoritative.
      const parentRefSeed = await seedRequiredReferenceValues(request, root,
        object(parentSchema.body) && Array.isArray(parentSchema.body.fields) ? parentSchema.body.fields : []);
      const parentBuilt = await synthesizeRecordValues(env, row, root, match[2], parentMarker,
        { ...parentRefSeed.overrides, [parentMarkerField.name]: parentMarker });
      if ("failure" in parentBuilt) return parentBuilt.failure;
      parentPlan = { objectName: match[2], field: parentFieldName, markerField: parentMarkerField.name, marker: parentMarker, values: parentBuilt.values };
    }
    let contextFixture: { objectName: string; values: Record<string, unknown>; parentField?: string; markerField?: string; marker?: string } | undefined;
    if (contextFixtureCreation) {
      // The context record needs its own owned creation. Visible parents
      // (a Chatter post renders on its parent) stay owned: prefer an owned
      // Account when the context requires a parent reference to one.
      const contextObject = match[2];
      const contextSchema = await request(`${root}/sobjects/${contextObject}/describe`);
      if (!contextSchema.ok || !object(contextSchema.body) || contextSchema.body.createable !== true ||
        contextSchema.body.queryable !== true || contextSchema.body.deletable !== true || !Array.isArray(contextSchema.body.fields)) {
        return { status: 403, body: { errorCode: "QUICK_ACTION_CONTEXT_FIXTURE_UNAVAILABLE",
          message: `Automatic ${contextObject} context requires live create, read and delete access.`,
          setupRequirement: `${contextObject} create, read and delete access for the execution user.` } };
      }
      const contextFields = contextSchema.body.fields.filter(object);
      const requiredRefs = contextFields.filter(field => typeof field.name === "string" && field.type === "reference" &&
        field.createable === true && field.nillable === false && field.defaultedOnCreate !== true &&
        field.calculated !== true && field.autoNumber !== true && Array.isArray(field.referenceTo));
      const linkField = requiredRefs.find(field => (field.referenceTo as unknown[]).includes("Account"));
      if (requiredRefs.length > 0 && !linkField) {
        return { status: 422, body: { errorCode: "QUICK_ACTION_CONTEXT_FIXTURE_UNAVAILABLE",
          message: `The live ${contextObject} context needs an owned parent no supported fixture supplies.` } };
      }
      if (linkField && typeof linkField.name === "string") {
        const accountSchema = await request(`${root}/sobjects/Account/describe`);
        const accountFields = accountSchema.ok && object(accountSchema.body) && accountSchema.body.createable === true &&
          accountSchema.body.queryable === true && accountSchema.body.deletable === true && Array.isArray(accountSchema.body.fields)
          ? accountSchema.body.fields.filter(object).filter(field => typeof field.name === "string" && field.createable === true &&
            field.filterable === true && typeof field.length === "number" && field.length >= 48 &&
            ["string", "textarea", "combobox"].includes(String(field.type))) : [];
        const accountMarkerField = accountFields.find(isNameMarkerField) ??
          accountFields.find(field => field.nillable === false);
        if (!accountMarkerField || typeof accountMarkerField.name !== "string") {
          return { status: 422, body: { errorCode: "QUICK_ACTION_PARENT_MARKER_UNAVAILABLE",
            message: "The live context parent has no writable, filterable ownership marker with enough space for a unique identity." } };
        }
        const accountMarker = "AS context " + crypto.randomUUID();
        const accountBuilt = await synthesizeRecordValues(env, row, root, "Account", accountMarker, { [accountMarkerField.name]: accountMarker });
        if ("failure" in accountBuilt) return accountBuilt.failure;
        parentPlan = { objectName: "Account", field: linkField.name, markerField: accountMarkerField.name, marker: accountMarker, values: accountBuilt.values as Record<string, unknown> };
        const fixtureMarker = "AS fixture " + crypto.randomUUID();
        // Bodies and notes are trigger-required on some context objects
        // (FeedItem posts); seed the first createable text field so the
        // fixture is a complete record, never a bare parent link.
        const textCandidates = contextFields.filter(field => typeof field.name === "string" && field.createable === true &&
          ["string", "textarea"].includes(String(field.type)) && (typeof field.length !== "number" || field.length >= 24));
        const textField = textCandidates.find(field => ["Body", "Description", "TextBody", "Note"].includes(String(field.name))) ?? textCandidates[0];
        const fixtureOverrides: Record<string, unknown> = { [linkField.name]: "OWNED_PARENT_PENDING" };
        if (textField && typeof textField.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(textField.name)) {
          fixtureOverrides[textField.name] = fixtureMarker.slice(0, typeof textField.length === "number" ? textField.length : 80);
        }
        // Gap-filled only: the owned-parent placeholder and trigger-required
        // text stay authoritative over borrowed live ids.
        const fixtureRefSeed = await seedRequiredReferenceValues(request, root, contextFields);
        const fixtureBuilt = await synthesizeRecordValues(env, row, root, contextObject, fixtureMarker, { ...fixtureRefSeed.overrides, ...fixtureOverrides });
        if ("failure" in fixtureBuilt) return fixtureBuilt.failure;
        contextFixture = { objectName: contextObject, values: fixtureBuilt.values as Record<string, unknown>, parentField: linkField.name };
      } else {
        const markerCandidates = contextFields.filter(field => typeof field.name === "string" && field.createable === true &&
          field.filterable === true && typeof field.length === "number" && field.length >= 24 &&
          ["string", "textarea", "combobox"].includes(String(field.type)));
        const fixtureMarkerField = markerCandidates.find(isNameMarkerField) ??
          markerCandidates.find(field => field.nillable === false) ?? markerCandidates[0];
        if (!fixtureMarkerField || typeof fixtureMarkerField.name !== "string") {
          return { status: 422, body: { errorCode: "QUICK_ACTION_CONTEXT_FIXTURE_UNAVAILABLE",
            message: `The live ${contextObject} context has no writable marker for independent verification.` } };
        }
        const fixtureMarker = "AS fixture " + crypto.randomUUID();
        const fixtureRefSeed = await seedRequiredReferenceValues(request, root, contextFields);
        const fixtureBuilt = await synthesizeRecordValues(env, row, root, contextObject, fixtureMarker, { ...fixtureRefSeed.overrides, [fixtureMarkerField.name]: fixtureMarker });
        if ("failure" in fixtureBuilt) return fixtureBuilt.failure;
        contextFixture = { objectName: contextObject, values: fixtureBuilt.values as Record<string, unknown>,
          markerField: fixtureMarkerField.name, marker: fixtureMarker };
      }
    }
    // Active/waiting/new Messaging Sessions can be neither ended nor deleted
    // via API; Ended ones accept update actions and delete cleanly (verified
    // live). Create the owned session already ended so cleanup is provable.
    const targetOverrides = target === "MessagingSession" ? { Status: "Ended" } : {};
    return invokeOwnedQuickAction({ root, route: input.route, target, markerField: markerField.name, marker,
      global, fields, inputs: descriptor.body.inputs.filter(object), integrationUserId: row.integration_user_id,
      buildTarget: overrides => synthesizeRecordValues(env, row, root, target, marker, { ...targetOverrides, ...overrides }, liveReferenceCache),
      ...(parentPlan ? { parent: parentPlan } : {}), ...(contextFixture ? { contextFixture } : {}),
      verificationWindowMs: input.verificationWindowMs, request });
  }

  async invokeFlowWithContext(ref: Key, input: { apiVersion: string; route: string; arguments: Record<string, unknown>; argumentsSynthetic?: boolean }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeFlowWithContext", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/v(\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    if (!key(ref) || !object(input) || !match || match[1] !== input.apiVersion || !object(input.arguments)) {
      throw authFailure(400, "invalid_flow_context", "A discovered Flow route and arguments are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const apiRoot = `/services/data/v${input.apiVersion}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body),
        crypto.randomUUID(), true, AbortSignal.timeout(60_000), fixtureCreateHeaders(method, path));
      return { status: response.status, ok: response.ok, body: await responseJson(response) };
    };
    const described = await request(input.route);
    if (!described.ok) return described;
    const descriptor = object(described.body) ? described.body : Array.isArray(described.body) ? described.body.find(object) : null;
    const inputs = descriptor && Array.isArray(descriptor.inputs) ? descriptor.inputs.filter(object) : [];
    const outputs = descriptor && Array.isArray(descriptor.outputs) ? descriptor.outputs.filter(object) : [];
    const allowed = new Set(inputs.map(field => field.name));
    if (Object.keys(input.arguments).some(name => !allowed.has(name))) {
      throw authFailure(400, "invalid_flow_arguments", "Arguments must match the live Flow schema.");
    }
    // A verification producer returns null outputs for identities matching no record. Create a
    // disposable owned Contact carrying the probe identity first, then invoke and clean up.
    const producerField = verificationProducerInput(inputs, outputs);
    if (producerField) {
      const contactSchema = await request(`${apiRoot}/sobjects/Contact/describe`);
      const emailField = object(contactSchema.body) && Array.isArray(contactSchema.body.fields)
        ? contactSchema.body.fields.filter(object).find(field => field.name === "Email") : null;
      if (!emailField || emailField.createable !== true) return { status: 403, body: {
        errorCode: "VERIFICATION_FIXTURE_PERMISSION_REQUIRED",
        message: "Automatic verification context needs create/delete Contact access and Email write access. Run setup:context-permissions for the connected org." } };
      const supplied = input.arguments[producerField];
      const email = typeof supplied === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplied)
        ? supplied : `action-probe-${crypto.randomUUID()}@example.invalid`;
      const built = await synthesizeRecordValues(env, row, apiRoot, "Contact", "Action Searcher temporary verification probe", { Email: email });
      if ("failure" in built) return built.failure;
      const created = await request(`${apiRoot}/sobjects/Contact`, "POST", built.values);
      const id = object(created.body) ? created.body.id : null;
      if (!created.ok || typeof id !== "string" || !/^003[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id)) return created;
      let cleanupError: string | undefined;
      let producerSweep: unknown = null;
      let result: { status: number; body: unknown };
      try {
        const verified = await request(`${apiRoot}/sobjects/Contact/${id}`);
        if (!verified.ok || !object(verified.body) || verified.body.Id !== id || verified.body.Email !== email) result = {
          status: 422, body: { errorCode: "VERIFICATION_FIXTURE_UNVERIFIED", message: "The disposable verification Contact failed independent readback." } };
        else {
          const challenge = await request(input.route, "POST", { inputs: [{ [producerField]: email }] });
          const challengeResult = Array.isArray(challenge.body) ? challenge.body.find(object) : null;
          const values = challengeResult && object(challengeResult.outputValues) ? challengeResult.outputValues : null;
          result = !challenge.ok || challengeResult?.isSuccess !== true || !values ||
            (PRODUCER_REQUIRED_OUTPUTS as readonly string[]).some(name => typeof values[name] !== "string" || !values[name]) ? {
            status: challenge.ok ? 422 : challenge.status, body: { errorCode: "VERIFICATION_CHALLENGE_CONTEXT_UNAVAILABLE",
              message: salesforceError(challenge.body).message ?? "Salesforce did not supply a usable code and authentication context for the owned verification identity." } }
            : challenge;
        }
      } finally {
        const residueSweep = await sweepFlowCommunicationResidue(request, apiRoot, { contactIds: [id], emails: [email] });
        if (residueSweep.queried && !residueSweep.verified) cleanupError = "Temporary verification communication residue cleanup could not be verified.";
        producerSweep = residueSweep;
        const deleted = await request(`${apiRoot}/sobjects/Contact/${id}`, "DELETE");
        const gone = await request(`${apiRoot}/sobjects/Contact/${id}`);
        if ((!deleted.ok && deleted.status !== 404) || gone.status !== 404) cleanupError = "Temporary verification Contact cleanup could not be verified.";
      }
      return { ...result, contextSchema: { source: "salesforce_live_verification_producer", producerInput: producerField, residueSweep: producerSweep,
        requiredOutputs: [...PRODUCER_REQUIRED_OUTPUTS],
        requirement: "If Salesforce masks the returned code, a tenant-owned test delivery channel must supply the real code. Generated authentication keys and codes are never persisted." },
        ...(cleanupError ? { cleanupError } : {}) };
    }
    const fullName = match[2];
    const recordInputs = inputs.filter(field => field.type === "SOBJECT" && typeof field.name === "string" &&
      (typeof field.maxOccurs !== "number" || field.maxOccurs <= 1));
    if (recordInputs.length > 0 && recordInputs.length <= 3) {
      // Bounded existence check: the full /sobjects/ catalog (6.3MB on
      // large SDO orgs) fails under load and the loop break below then
      // mislabels the transient as schema truth. A failed catalog call is
      // passed through honestly instead.
      const catalogSoql = flowRecordCatalogSoql(flowRecordCatalogCandidates(recordInputs));
      const catalog = catalogSoql ? await request(`${apiRoot}/query?q=${encodeURIComponent(catalogSoql)}`) : null;
      const qualified = catalog !== null && catalog.ok && object(catalog.body) && Array.isArray(catalog.body.records)
        ? catalog.body.records.filter(object).map(entry => entry.QualifiedApiName)
          .filter((name): name is string => typeof name === "string") : null;
      const fixtures: Array<{ objectName: string; id: string }> = [];
      const fixtureEmails: string[] = [];
      const args = { ...input.arguments };
      const mappings: Array<{ inputName: string; objectName: string }> = [];
      const defaultOutcome: { status: number; body: unknown } = { status: 422, body: {
        errorCode: "FLOW_RECORD_CONTEXT_UNAVAILABLE", message: "The live Flow schema does not resolve its record inputs to createable objects." } };
      let result: { status: number; body: unknown } = defaultOutcome;
      let cleanupError: string | undefined;
      let residueSweep: ResidueSweep | null = null;
      let omittedProbe = false;
      // Live-input safety gate: borrowed FK ids ride the owned fixture
      // into the native interview, and caller scalar args pass through
      // verbatim, so a custom flow that is not provably read-only must
      // receive neither. Borrowing stays allowed ONLY for provably
      // read-only shapes; anything else mints owned parents or refuses
      // honest, and identity-shaped caller scalars are refused before
      // anything is created. (Record inputs are overwritten with owned
      // fixtures below, so only non-record caller args are scanned.)
      const metadataProof = outputs.some(field => field.type === "SOBJECT")
        ? await this.describeFlowCreationContext(ref, { route: input.route }) : null;
      const queryOnlyMetadataVerified = metadataProof && object(metadataProof.contextSchema) && metadataProof.contextSchema.readOnlyMetadataVerified === true;
      if (queryOnlyMetadataVerified && metadataProof && object(metadataProof.contextSchema)) {
        const grant = await provisionFlowReadFields(apiRoot, metadataProof.contextSchema.requiredReadFields, request);
        if (grant.missing.length) return { status: 403, body: { errorCode: "FLOW_UPSTREAM_ACCESS_REQUIRED",
          message: "The query-only Flow requires field read access: " + grant.missing.join(", ") + ". Grant these fields through the fixture permission set and retry." }, contextSchema: metadataProof.contextSchema };
      }
      const readOnlyEvident = queryOnlyMetadataVerified || isReadOnlyEvident(descriptor, input.route);
      // Searcher-attested synthesis (neutral/well-formed fillers, nothing
      // live) skips the foreign-identity scan: unguessable values match no
      // row, so they cannot smuggle a live identity into the interview.
      if (!readOnlyEvident && input.argumentsSynthetic !== true) {
        const recordNames = new Set(recordInputs.map(field => String(field.name)));
        let foreignIdentity = false;
        const scan = (value: unknown): void => {
          if (foreignIdentity) return;
          if (typeof value === "string") {
            if (/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(value)) foreignIdentity = true;
          } else if (Array.isArray(value)) value.forEach(scan);
          else if (object(value)) Object.values(value).forEach(scan);
        };
        for (const [name, value] of Object.entries(input.arguments)) {
          // recordId never reaches the interview verbatim (it is rebound
          // to the owned fixture id below, or dropped), so scanning it
          // would refuse probes for a value that is never passed.
          if (!recordNames.has(name) && name.toLowerCase() !== "recordid") scan(value);
        }
        if (foreignIdentity) return { status: 422, body: {
          errorCode: "FLOW_RECORD_LIVE_INPUT_REFUSED",
          message: "The live Flow is not provably read-only, so identity-shaped inputs cannot be passed to it; only owned fixtures may supply its context." },
          contextSchema: { source: "salesforce_live_flow_record_inputs", mappings: [],
            readOnlyEvident: false, ownedReferencesOnly: true,
            automaticSteps: ["Resolve record inputs against the live sObject catalog", "Describe required writable fields", "Create and read back disposable records", "Invoke with real record IDs", "Sweep communication residue", "Delete and verify fixtures"] } };
      }
      try {
        // No valid candidate names keeps the schema-truth default below; a
        // failed catalog call passes through so transients never masquerade
        // as unresolvable record inputs.
        const catalogFailed = catalog !== null && (!catalog.ok || qualified === null);
        if (catalogFailed && catalog !== null) result = { status: catalog.status, body: catalog.body };
        const missedInputs: string[] = [];
        for (const field of catalogFailed ? [] : recordInputs) {
          const objectName = resolveFlowRecordTarget(qualified, field);
          if (objectName === null) { missedInputs.push(String(field.name)); break; }
          const schema = await request(`${apiRoot}/sobjects/${objectName}/describe`);
          if (schema.ok) {
            const blocked = flowRecordFixtureBlocker(objectName, schema.body);
            if (blocked) { result = { status: 422, body: { errorCode: "FLOW_RECORD_FIXTURE_PERMISSIONS_REQUIRED", message: blocked } }; break; }
          }
          const fields = schema.ok && object(schema.body) && Array.isArray(schema.body.fields) ? schema.body.fields.filter(object) : [];
          const marker = fields.find(item => ["Subject", "Name"].includes(String(item.name)) && item.createable === true && item.autoNumber !== true);
          const name = `Action Searcher temporary flow probe ${crypto.randomUUID()}`;
          const description = fields.find(item => item.name === "Description" && item.createable === true &&
            ["string", "textarea"].includes(String(item.type)));
          // Required fixture references seed from live lookups (borrowed FK
          // ids; borrowed rows are never written) ONLY when the flow is
          // provably read-only: a mutating (or unknown) custom flow is
          // arbitrary tenant logic, so live customer identities must never
          // ride its inputs. Otherwise every field is treated as rowless:
          // single-target references with a mintable target
          // (RebateProgramPayoutPeriod on a programless org) mint an owned
          // parent with its own marker, tracked in fixtures ahead of the
          // child so ordered cleanup deletes the child first. Unresolved
          // fields fail honest through the builder with the same code as
          // before.
          const refSeed = await seedRequiredReferenceValues(request, apiRoot, fields, { allowLiveBorrow: readOnlyEvident });
          const parentOverrides: Record<string, unknown> = {};
          let parentFailed = false;
          for (const plan of refSeed.mintPlans) {
            const parentName = `Action Searcher temporary flow parent ${crypto.randomUUID()}`;
            const parentMarker = plan.fields.find(item => ["Subject", "Name"].includes(String(item.name)) &&
              item.createable === true && item.autoNumber !== true);
            if (!parentMarker || typeof parentMarker.name !== "string") {
              result = { status: 422, body: { errorCode: "FLOW_RECORD_PARENT_MARKER_UNAVAILABLE",
                message: `The live ${plan.objectName} parent has no writable ownership marker.` } };
              parentFailed = true; break;
            }
            const parentSeeds = await seedRequiredReferenceValues(request, apiRoot, plan.fields, { allowLiveBorrow: readOnlyEvident });
            const parentBuilt = await synthesizeRecordValues(env, row, apiRoot, plan.objectName, parentName,
              { [parentMarker.name]: parentName, ...parentSeeds.overrides });
            if ("failure" in parentBuilt) { result = parentBuilt.failure; parentFailed = true; break; }
            const parentCreated = await request(`${apiRoot}/sobjects/${plan.objectName}`, "POST", parentBuilt.values);
            const parentId = object(parentCreated.body) ? parentCreated.body.id : null;
            if (!parentCreated.ok || typeof parentId !== "string" || !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(parentId)) {
              result = parentCreated; parentFailed = true; break;
            }
            fixtures.push({ objectName: plan.objectName, id: parentId });
            const parentVerified = await request(`${apiRoot}/sobjects/${plan.objectName}/${parentId}`);
            if (!parentVerified.ok || !object(parentVerified.body) || parentVerified.body.Id !== parentId ||
              parentVerified.body[parentMarker.name] !== parentName) {
              result = { status: 422, body: { errorCode: "FLOW_RECORD_PARENT_UNVERIFIED",
                message: "The owned Flow parent record failed readback verification." } };
              parentFailed = true; break;
            }
            parentOverrides[plan.field] = parentId;
          }
          if (parentFailed) break;
          const built = await synthesizeRecordValues(env, row, apiRoot, objectName, name,
            { ...(marker ? { [String(marker.name)]: name } : {}), ...(description ? {
              Description: "Disposable action validation record. Inspect the equipment and record the work performed. This fixture is deleted after validation." } : {}),
              ...refSeed.overrides, ...parentOverrides });
          if ("failure" in built) { result = built.failure; break; }
          // People-record flows fault on fixtures without a routable identity; complete a
          // createable Email with an undeliverable probe address (never a real recipient).
          const priorEmail = (built.values as Record<string, unknown>).Email;
          const completed = eventSlotCompletion(objectName, fields,
            personIdentityCompletion(fields, built.values as Record<string, unknown>));
          if ((priorEmail == null || priorEmail === "") && typeof completed.Email === "string" && completed.Email.length) fixtureEmails.push(completed.Email);
          let created = await request(`${apiRoot}/sobjects/${objectName}`, "POST", completed);
          let id = object(created.body) ? created.body.id : null;
          const minted = () => created.ok && typeof id === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(id);
          // Trigger-null-tolerant enrichment (same mechanism as the
          // owned-substrate chain): a fixture insert that faults inside a
          // managed BeforeInsert trigger retries once with nillable
          // references populated from owned mints. Enrichment parents join
          // fixtures, so ordered cleanup deletes them even when the retry
          // fails; anything unplannable keeps the original fault honestly.
          if (!minted() && isTriggerNullInsertFault(created.status, created.body)) {
            const retried = await (async (): Promise<{ created: typeof created; id: unknown } | null> => {
              const describes = new Map<string, unknown>();
              const describeTarget = async (target: string) => {
                if (!describes.has(target)) {
                  const schema = await request(`${apiRoot}/sobjects/${target}/describe`).catch(() => null);
                  describes.set(target, schema && schema.ok && object(schema.body) ? schema.body : null);
                }
                const body = describes.get(target);
                return body && typeof body === "object" ? body as { name?: unknown; createable?: unknown; queryable?: unknown; deletable?: unknown; fields?: unknown } : undefined;
              };
              const candidates = await planTriggerNullEnrichment({
                objectName,
                fields,
                plannedObjectNames: fixtures.map((fixture) => fixture.objectName),
                boundFields: [...Object.keys(refSeed.overrides), ...Object.keys(parentOverrides)],
                describe: describeTarget,
              });
              if (candidates.length === 0) return null;
              const enrichmentOverrides: Record<string, unknown> = {};
              // Best-effort per candidate: setup-flavored targets (WorkType,
              // ServiceTerritory) describe as mintable but reject the probe
              // insert, and one unmintable target must not void the parents
              // that did mint. Skipped candidates stay null on the retry;
              // the retry outcome still decides honestly.
              for (const candidate of candidates) {
                const reused = fixtures.find((fixture) => fixture.objectName === candidate.target)?.id;
                if (reused !== undefined) {
                  if (!/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(reused)) continue;
                  enrichmentOverrides[candidate.field] = reused;
                  continue;
                }
                const targetBody = await describeTarget(candidate.target);
                const targetFields = targetBody && Array.isArray(targetBody.fields) ? targetBody.fields.filter(object) : [];
                const parentName = `Action Searcher temporary flow parent ${crypto.randomUUID()}`;
                const parentMarker = targetFields.find((item) => ["Subject", "Name"].includes(String(item.name)) &&
                  item.createable === true && item.autoNumber !== true);
                if (!parentMarker || typeof parentMarker.name !== "string") continue;
                const parentSeeds = await seedRequiredReferenceValues(request, apiRoot, targetFields, { allowLiveBorrow: readOnlyEvident });
                const parentBuilt = await synthesizeRecordValues(env, row, apiRoot, candidate.target, parentName,
                  { [parentMarker.name]: parentName, ...parentSeeds.overrides });
                if ("failure" in parentBuilt) continue;
                const parentCreated = await request(`${apiRoot}/sobjects/${candidate.target}`, "POST", parentBuilt.values);
                const parentId = object(parentCreated.body) ? parentCreated.body.id : null;
                if (!parentCreated.ok || typeof parentId !== "string" || !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(parentId)) continue;
                fixtures.push({ objectName: candidate.target, id: parentId });
                const parentVerified = await request(`${apiRoot}/sobjects/${candidate.target}/${parentId}`);
                if (!parentVerified.ok || !object(parentVerified.body) || parentVerified.body.Id !== parentId ||
                  parentVerified.body[parentMarker.name] !== parentName) continue;
                enrichmentOverrides[candidate.field] = parentId;
              }
              if (Object.keys(enrichmentOverrides).length === 0) return null;
              const rebuilt = await synthesizeRecordValues(env, row, apiRoot, objectName, name,
                { ...(marker ? { [String(marker.name)]: name } : {}), ...(description ? {
                  Description: "Disposable action validation record. Inspect the equipment and record the work performed. This fixture is deleted after validation." } : {}),
                  ...refSeed.overrides, ...parentOverrides, ...enrichmentOverrides });
              if ("failure" in rebuilt) return null;
              const recompleted = eventSlotCompletion(objectName, fields,
                personIdentityCompletion(fields, rebuilt.values as Record<string, unknown>));
              const retryEmail = (recompleted as Record<string, unknown>).Email;
              if ((priorEmail == null || priorEmail === "") && typeof retryEmail === "string" && retryEmail.length &&
                !fixtureEmails.includes(retryEmail)) fixtureEmails.push(retryEmail);
              const retry = await request(`${apiRoot}/sobjects/${objectName}`, "POST", recompleted);
              return { created: retry, id: object(retry.body) ? retry.body.id : null };
            })();
            if (retried) {
              created = retried.created;
              id = retried.id;
            }
          }
          if (!created.ok || typeof id !== "string" || !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(id)) { result = created; break; }
          fixtures.push({ objectName, id });
          const verified = await request(`${apiRoot}/sobjects/${objectName}/${id}`);
          if (!verified.ok || !object(verified.body) || verified.body.Id !== id ||
            marker && verified.body[String(marker.name)] !== name) {
            result = { status: 422, body: { errorCode: "FLOW_RECORD_FIXTURE_UNVERIFIED", message: "The disposable Flow record failed readback verification." } }; break;
          }
          // Flow record variables do not automatically hydrate fields from an Id.
          // Pass the fields read from our own disposable record — but sparse:
          // system/audit/autonumber/formula fields poison the flow's Update
          // Records elements (opaque UNKNOWN_EXCEPTION), so only Id plus
          // updateable fields ride the input.
          const keepable = new Set(fields.filter(item => item.updateable === true).map(item => String(item.name)));
          keepable.add("Id");
          const sparse: Record<string, unknown> = { attributes: { type: objectName } };
          for (const [key, value] of Object.entries(verified.body)) {
            if (keepable.has(key)) sparse[key] = value;
          }
          args[String(field.name)] = sparse;
          mappings.push({ inputName: String(field.name), objectName });
        }
        // The conventional recordId scalar rides the single mapped fixture:
        // a synthetic there faults Id-filtered Gets, and a caller-supplied
        // value must never reach the interview verbatim. With zero or
        // several mappings the key is dropped (the flow faults honestly on
        // a missing input rather than running on a foreign identity).
        const recordIdKey = Object.keys(args).find(key => key.toLowerCase() === "recordid" &&
          !mappings.some(entry => entry.inputName === key));
        if (recordIdKey !== undefined) {
          const bound = mappings.length === 1
            ? fixtures.filter(entry => entry.objectName === mappings[0].objectName).at(-1)?.id
            : undefined;
          if (typeof bound === "string") args[recordIdKey] = bound;
          else delete args[recordIdKey];
        }
        if (mappings.length === recordInputs.length) {
          result = await request(input.route, "POST", { inputs: [args] });
          const single = Array.isArray(result.body) && result.body.length === 1 && object(result.body[0]) ? result.body[0] : null;
          const opaque = single !== null && Array.isArray(single.errors) && single.errors.some((entry) => object(entry) &&
            entry.statusCode === "UNKNOWN_EXCEPTION" && typeof entry.message === "string" &&
            /error occurred when executing a flow interview/i.test(entry.message));
          if (opaque && Object.values(args).some((value) => typeof value === "string")) {
            // Vendors that split a scalar and index past its parts fault on
            // unstructured text; one structured retry reuses the bound
            // fixtures and only a native success adopts (fixtures sweep
            // either way, so a failed retry keeps the original fault).
            const structured: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(args)) structured[key] = commaStructuredProbeValue(value);
            const retried = await request(input.route, "POST", { inputs: [structured] });
            if (retried.ok && Array.isArray(retried.body) && retried.body.every((item) => object(item) && item.isSuccess === true)) result = retried;
          }
        } else if (result === defaultOutcome && missedInputs.length > 0) {
          // Tried candidates missed the live catalog: the declared object is
          // absent from the org schema, which is exact terminal evidence
          // (not the createable-objects default). Read-only-evident flows
          // get one omitted-input attempt first: with no record to bind,
          // the flow takes its null path and the real outcome decides.
          const missed = recordInputs.find(field => String(field.name) === missedInputs[0]);
          const declared = missed && typeof missed.sObjectType === "string" ? missed.sObjectType : null;
          const absent: { status: number; body: unknown } = { status: 422, body: {
            errorCode: "FLOW_RECORD_TARGET_ABSENT",
            message: `Record input '${missedInputs[0]}'${declared ? ` declares '${declared}', absent` : " resolves to no object, missing"} from the live org schema; the flow cannot run without it.` } };
          if (descriptor && readOnlyEvident && inputs.every(field => field.required !== true)) {
            const omitted = { ...args };
            for (const field of recordInputs) delete omitted[String(field.name)];
            const probe = await request(input.route, "POST", { inputs: [omitted] });
            const single = probe.status === 200 && Array.isArray(probe.body) && probe.body.length === 1 && object(probe.body[0])
              ? probe.body[0] as Record<string, unknown> : null;
            const probeOutputs = single && object((single as Record<string, unknown>).outputValues)
              ? (single as Record<string, unknown>).outputValues as Record<string, unknown> : {};
            const probeErrors = single && Array.isArray((single as Record<string, unknown>).errors)
              ? (single as Record<string, unknown>).errors as unknown[] : [];
            const probeFault = [probeOutputs.errorMessage, (single as Record<string, unknown> | null)?.errorMessage]
              .find((entry): entry is string => typeof entry === "string" && entry.length > 0);
            const failureSnippet = Object.entries(probeOutputs)
              .filter(([name]) => name !== "Flow__InterviewGuid" && name !== "Flow__InterviewStatus")
              .map(([, value]) => flowOutputFailureSnippet(value)).find((snippet): snippet is string => snippet !== null);
            const finished = probeOutputs.Flow__InterviewStatus === undefined || probeOutputs.Flow__InterviewStatus === null ||
              probeOutputs.Flow__InterviewStatus === "Finished";
            if (single && (single as Record<string, unknown>).isSuccess === true && probeErrors.length === 0 &&
              !probeFault && !failureSnippet && finished) {
              omittedProbe = true;
              result = probe;
            } else {
              result = probe.status !== 200 ? probe : absent;
            }
          } else {
            result = absent;
          }
        }
      } finally {
        // Email-sending flows log Task/EmailMessage residue that outlives the fixture; sweep
        // exact fixture-owned values before deleting so nothing probe-owned survives.
        residueSweep = await sweepFlowCommunicationResidue(request, apiRoot, { contactIds: fixtures.filter(fixture => fixture.objectName === "Contact" || fixture.objectName === "Lead").map(fixture => fixture.id), emails: fixtureEmails });
        if (residueSweep.queried && !residueSweep.verified) cleanupError = "Temporary Flow communication residue cleanup could not be verified.";
        for (const fixture of fixtures.reverse()) {
          const path = `${apiRoot}/sobjects/${fixture.objectName}/${fixture.id}`;
          const before = await request(path);
          if (before.ok && object(before.body) && before.body.CreatedById === row.integration_user_id &&
              typeof before.body.OwnerId === "string" && before.body.OwnerId !== row.integration_user_id) {
            await request(path, "PATCH", { OwnerId: row.integration_user_id });
          }
          const deleted = await request(path, "DELETE");
          const verified = await request(path);
          if ((!deleted.ok && deleted.status !== 404) || verified.status !== 404) cleanupError = "Temporary Flow record cleanup could not be verified.";
        }
      }
      return { ...result, contextSchema: { source: "salesforce_live_flow_record_inputs", mappings, residueSweep, ownedRecords: fixtures.map(fixture => ({ objectName: fixture.objectName, id: fixture.id })),
        ...(omittedProbe ? { readOnlyOmittedProbe: true } : {}),
        ...(readOnlyEvident ? {} : { ownedReferencesOnly: true }),
        automaticSteps: ["Resolve record inputs against the live sObject catalog", "Describe required writable fields", "Create and read back disposable records", "Invoke with real record IDs", "Sweep communication residue", "Delete and verify fixtures"] },
        ...(cleanupError ? { cleanupError } : {}) };
    }
    // A verifier requires a real challenge. The producer masks its returned code
    // ("xxxxxx") and delivers the real one out of band, so the chain runs the
    // producer against a disposable receivable inbox and passes the delivered
    // code with the producer's customer context (never persisted, never logged).
    if (["customerCode", "customerId", "customerType", "authenticationKey"].every(name => allowed.has(name))) {
      return invokeFlowVerificationCodeChain({ root: apiRoot, route: input.route, request, inbox: verificationInbox(env),
        build: async (values) => synthesizeRecordValues(env, row, apiRoot, "Contact", "Action Searcher temporary verification probe", values) });
    }
    const localName = fullName.includes("__") ? fullName.slice(fullName.indexOf("__") + 2) : fullName;
    const query = `SELECT Id,DeveloperName,NamespacePrefix,ActiveVersionId FROM FlowDefinition WHERE DeveloperName IN ('${fullName}','${localName}')`;
    const definition = await request(`${apiRoot}/tooling/query?q=${encodeURIComponent(query)}`);
    if (!definition.ok) return definition;
    const definitions = object(definition.body) && Array.isArray(definition.body.records) ? definition.body.records.filter(object)
      .filter(item => (item.NamespacePrefix ? `${item.NamespacePrefix}__${item.DeveloperName}` : item.DeveloperName) === fullName) : [];
    const versionId = definitions.length === 1 ? definitions[0].ActiveVersionId : null;
    if (typeof versionId !== "string" || !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(versionId)) return {
      status: 422, body: { errorCode: "FLOW_DEFINITION_UNAVAILABLE",
        message: "The active Flow definition is not exposed to this integration user. Automatic lookup-context discovery requires readable Flow metadata." } };
    const retrieved = await request(`${apiRoot}/tooling/query?q=${encodeURIComponent(`SELECT Metadata FROM Flow WHERE Id='${versionId}'`)}`);
    if (!retrieved.ok) return retrieved;
    const records = object(retrieved.body) && Array.isArray(retrieved.body.records) ? retrieved.body.records.filter(object) : [];
    const metadata = records[0]?.Metadata;
    const bindings = flowLookupBindings(metadata).filter(binding => allowed.has(binding.inputName));
    const contextSchema = { source: "salesforce_active_flow_metadata", lookupBindings: bindings };
    if (!bindings.length) return { status: 422, body: { errorCode: "FLOW_CONTEXT_RECIPE_UNAVAILABLE",
      message: "The live Flow does not expose a direct input-to-record lookup recipe. Its required upstream context cannot be inferred from optional inputs alone." }, contextSchema };
    if (object(metadata) && ["recordCreates", "recordUpdates", "recordDeletes", "actionCalls", "subflows"].some(name =>
      Array.isArray(metadata[name]) && metadata[name].length > 0)) return { status: 422,
      body: { errorCode: "FLOW_CONTEXT_RECIPE_REQUIRES_CHAIN",
        message: "This Flow calls upstream actions or mutates records. Lookup-only context is insufficient; its dependency chain must be prepared before testing." }, contextSchema };
    const arguments_ = { ...input.arguments };
    const fixtures: Array<{ objectName: string; id: string }> = [];
    let cleanupError: string | undefined;
    let result: { status: number; body: unknown } = { status: 422, body: { errorCode: "FLOW_CONTEXT_UNAVAILABLE",
      message: "The Flow lookup context could not be created from the accessible schema." } };
    try {
      for (const objectName of [...new Set(bindings.map(binding => binding.objectName))].slice(0, 3)) {
        const schema = await request(`${apiRoot}/sobjects/${objectName}/describe`);
        if (!schema.ok) { result = schema; break; }
        const blocked = flowRecordFixtureBlocker(objectName, schema.body);
        if (blocked) { result = { status: 422, body: { errorCode: "FLOW_RECORD_FIXTURE_PERMISSIONS_REQUIRED", message: blocked } }; break; }
        const fields = object(schema.body) && Array.isArray(schema.body.fields) ? schema.body.fields.filter(object) : [];
        const overrides: Record<string, unknown> = {};
        const nonce = crypto.randomUUID().replaceAll("-", "");
        for (const binding of bindings.filter(item => item.objectName === objectName)) {
          const field = fields.find(field => field.name === binding.fieldName);
          const value = field && flowFixtureValue(field, nonce);
          if (value !== undefined) { overrides[binding.fieldName] = value; arguments_[binding.inputName] = value; }
        }
        // Id-filtered lookups bind the created fixture id itself (no
        // synthesized value can stand in for an object id); other inputs
        // without overrides still skip.
        const idBoundInputs = lookupIdBindings(bindings, objectName);
        if (!Object.keys(overrides).length && idBoundInputs.length === 0) continue;
        const values = await synthesizeRecordValues(env, row, apiRoot, objectName,
          "Action Searcher temporary flow context", overrides);
        if ("failure" in values) { result = values.failure; break; }
        const created = await request(`${apiRoot}/sobjects/${objectName}`, "POST", values.values);
        const id = object(created.body) ? created.body.id : null;
        if (!created.ok || typeof id !== "string" || !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(id)) { result = created; break; }
        fixtures.push({ objectName, id });
        const verified = await request(`${apiRoot}/sobjects/${objectName}/${id}`);
        if (!verified.ok || !object(verified.body) || verified.body.Id !== id ||
          Object.entries(overrides).some(([field, value]) => verified.body && object(verified.body) && verified.body[field] !== value)) {
          result = { status: 422, body: { errorCode: "FLOW_CONTEXT_VERIFICATION_FAILED",
            message: "The created lookup context did not match Salesforce's independent record read." } }; break;
        }
        for (const inputName of idBoundInputs) arguments_[inputName] = id;
        const action = await request(input.route, "POST", { inputs: [arguments_] });
        result = action;
        if (action.ok && Array.isArray(action.body) && action.body.every(item => object(item) && item.isSuccess === true)) break;
      }
    } finally {
      for (const fixture of fixtures.reverse()) {
        const deleted = await request(`${apiRoot}/sobjects/${fixture.objectName}/${fixture.id}`, "DELETE");
        if (!deleted.ok && deleted.status !== 404) cleanupError = `Temporary ${fixture.objectName} cleanup returned HTTP ${deleted.status}.`;
      }
    }
    return { status: result.status, body: result.body, contextSchema, ...(cleanupError ? { cleanupError } : {}) };
  }

  /** Run the verified-contact consumer chain for a metadata-hidden Flow action. */
  async invokeFlowContactChain(ref: Key, input: { apiVersion: string; route: string }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeFlowContactChain", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/v(\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    if (!key(ref) || !object(input) || !match || match[1] !== input.apiVersion) {
      throw authFailure(400, "invalid_flow_contact_chain", "A discovered Flow route and API version are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const apiRoot = `/services/data/v${input.apiVersion}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body),
        crypto.randomUUID(), true, AbortSignal.timeout(60_000));
      return { status: response.status, ok: response.ok, body: await responseJson(response) };
    };
    return invokeFlowContactChain({ root: apiRoot, route: input.route, request,
      build: async (values) => synthesizeRecordValues(env, row, apiRoot, "Contact", "Action Searcher temporary contact-chain probe", values) });
  }

  /** Run the verification-code consumer chain for a metadata-hidden Flow action. */
  async invokeFlowVerificationCodeChain(ref: Key, input: { apiVersion: string; route: string }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeFlowVerificationCodeChain", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/v(\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    if (!key(ref) || !object(input) || !match || match[1] !== input.apiVersion) {
      throw authFailure(400, "invalid_flow_verification_code_chain", "A discovered Flow route and API version are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const apiRoot = `/services/data/v${input.apiVersion}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body),
        crypto.randomUUID(), true, AbortSignal.timeout(60_000));
      return { status: response.status, ok: response.ok, body: await responseJson(response) };
    };
    return invokeFlowVerificationCodeChain({ root: apiRoot, route: input.route, request, inbox: verificationInbox(env),
      build: async (values) => synthesizeRecordValues(env, row, apiRoot, "Contact", "Action Searcher temporary verification-chain probe", values) });
  }

  /** Run the output-linked verification chain for a refused custom Flow action. */
  async invokeFlowVerifyLinkedChain(ref: Key, input: { apiVersion: string; route: string }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeFlowVerifyLinkedChain", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/v(\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    if (!key(ref) || !object(input) || !match || match[1] !== input.apiVersion) {
      throw authFailure(400, "invalid_flow_verify_linked_chain", "A discovered Flow route and API version are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const apiRoot = `/services/data/v${input.apiVersion}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body),
        crypto.randomUUID(), true, AbortSignal.timeout(60_000));
      return { status: response.status, ok: response.ok, body: await responseJson(response) };
    };
    return invokeFlowVerifyLinkedChain({ root: apiRoot, route: input.route, request,
      build: async (values) => synthesizeRecordValues(env, row, apiRoot, "Contact", "Action Searcher temporary verify-linked probe", values) });
  }

  /** Run the owned-substrate chain for a refused custom Flow action. */
  async invokeFlowOwnedSubstrateChain(ref: Key, input: { apiVersion: string; route: string; plan: OwnedSubstratePlan; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeFlowOwnedSubstrateChain", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/v(\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    if (!key(ref) || !object(input) || !match || match[1] !== input.apiVersion || !object(input.plan)) {
      throw authFailure(400, "invalid_flow_owned_substrate", "A discovered Flow route, API version, and substrate plan are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const apiRoot = `/services/data/v${input.apiVersion}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body),
        crypto.randomUUID(), true, AbortSignal.timeout(60_000), fixtureCreateHeaders(method, path));
      return { status: response.status, ok: response.ok, body: await responseJson(response) };
    };
    if (!row.integration_user_id || !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(row.integration_user_id)) {
      throw authFailure(400, "invalid_flow_owned_substrate", "A live integration user identity is required; none is ever guessed.");
    }
    return invokeOwnedSubstrate({ root: apiRoot, route: input.route, plan: input.plan,
      integrationUserId: row.integration_user_id,
      ...(typeof input.verificationWindowMs === "number" ? { verificationWindowMs: input.verificationWindowMs } : {}),
      request,
      build: async (name, marker, values) => {
        const result = await synthesizeRecordValues(env, row, apiRoot, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result;
      } });
  }

  /** Apply a planned managed-flow-fault repair and re-probe (searcher repair-consumer entry). */
  async invokeFlowFaultRepair(ref: Key, input: { apiVersion: string; route: string; fault: { code: string; requirement?: string; retryable?: boolean; objectName?: string; fieldName?: string; actionElement?: string; providerName?: string; invocableName?: string; inputName?: string }; priorArgs?: Record<string, unknown>; gating?: { lastAttemptAt?: number | null; repeatCount?: number | null; builderVersion?: number | null }; verificationWindowMs?: number }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeFlowFaultRepair", [ref, input], signed);
    const match = typeof input?.route === "string" && input.route.match(
      /^\/services\/data\/v(\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
    if (!key(ref) || !object(input) || !match || match[1] !== input.apiVersion || !object(input.fault) ||
      typeof (input.fault as Record<string, unknown>).code !== "string") {
      throw authFailure(400, "invalid_flow_fault_repair", "A discovered Flow route, API version, and classified fault are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const apiRoot = `/services/data/v${input.apiVersion}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body),
        crypto.randomUUID(), true, AbortSignal.timeout(60_000));
      return { status: response.status, ok: response.ok, body: await responseJson(response) };
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: input.fault as ManagedFlowFault, root: apiRoot, route: input.route, request,
      build: async (name, marker, values) => {
        const result = await synthesizeRecordValues(env, row, apiRoot, name, marker, values);
        return "failure" in result ? { failure: { ...result.failure, ok: false } } : result;
      },
      ...(object(input.priorArgs) ? { priorArgs: input.priorArgs } : {}),
      ...(object(input.gating) ? { gating: input.gating } : {}),
      ...(typeof input.verificationWindowMs === "number" ? { verificationWindowMs: input.verificationWindowMs } : {}),
    });
    if (!outcome) {
      throw authFailure(400, "invalid_flow_fault_repair", "The fault code is not a classified managed-flow fault with a repair consumer.");
    }
    return { status: 200, body: outcome };
  }

  /** Discover Data Cloud publish substrate, invoke natively, and verify the lifecycle state. */
  async invokeCdpPublishWithContext(ref: Key, input: { actionName: string; apiVersion: string; descriptorInputs: Array<{ name: string; type?: string; required?: boolean }> }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeCdpPublishWithContext", [ref, input], signed);
    const actions = ["cdpPublishSegment", "cdpPublishCalculatedInsight", "cdpSendToActivation"];
    if (!key(ref) || !object(input) || !actions.includes(input.actionName) ||
      !/^v\d+(?:\.\d+)?$/.test(input.apiVersion ?? "") || !Array.isArray(input.descriptorInputs)) {
      throw authFailure(400, "invalid_cdp_publish", "A discovered CDP publish action, API version, and descriptor inputs are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${input.apiVersion}`;
    const route = `${root}/actions/standard/${input.actionName}`;
    const request: CdpPubTransport = async (path, method, body) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body),
          crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "CDP_PUB_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; discovery treats this as absent substrate." } }; }
    };
    const specs: Record<string, { soqls: string[]; valueFields: string[] }> = {
      cdpPublishSegment: { soqls: ["SELECT Id FROM MarketSegment WHERE SegmentStatus='ACTIVE' LIMIT 1"], valueFields: ["Id"] },
      cdpPublishCalculatedInsight: { soqls: ["SELECT Id, Name, CalculatedInsightStatus FROM MktCalculatedInsight LIMIT 1"], valueFields: ["Name"] },
      cdpSendToActivation: { soqls: ["SELECT Id, Name FROM MarketSegmentActivation LIMIT 1", "SELECT Id, MasterLabel FROM ActivationTarget LIMIT 1"], valueFields: ["Name", "MasterLabel"] },
    };
    const spec = specs[input.actionName];
    const discover = async (): Promise<CdpPubDiscovery> => {
      const evidence: string[] = [];
      for (const soql of spec.soqls) {
        const res = await request(`${root}/query?q=${encodeURIComponent(soql)}`, "GET");
        const rows = object(res.body) && Array.isArray(res.body.records) ? res.body.records.filter(object) : [];
        evidence.push(`${soql} -> ${rows.length}`);
        const first = rows[0] as Record<string, unknown> | undefined;
        const value = first ? spec.valueFields.map(field => first[field]).find(candidate => typeof candidate === "string" && candidate.length > 0) : undefined;
        const rowId = first && typeof first.Id === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(first.Id) ? first.Id : undefined;
        if (typeof value === "string" && rowId) return { found: true, value, rowId, soql };
      }
      return { found: false, evidence };
    };
    const verify = async (discovery: { rowId: string; soql: string }): Promise<{ verified: boolean }> => {
      const present = (value: unknown): boolean => (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value));
      const soql = input.actionName === "cdpPublishSegment"
        ? `SELECT Id, PublishStatus, LastPublishStatusDateTime FROM MarketSegment WHERE Id='${discovery.rowId}'`
        : input.actionName === "cdpPublishCalculatedInsight"
          ? `SELECT Id, CalculatedInsightStatus, LastRunStatus, LastRunStatusDateTime FROM MktCalculatedInsight WHERE Id='${discovery.rowId}'`
          : discovery.soql.includes("ActivationTarget")
            ? `SELECT Id, MasterLabel, TargetStatus, LastTargetStatusDateTime FROM ActivationTarget WHERE Id='${discovery.rowId}'`
            : `SELECT Id, Name, ActivationStatus, LastActivationStatusDateTime, LastPublishStatus FROM MarketSegmentActivation WHERE Id='${discovery.rowId}'`;
      const res = await request(`${root}/query?q=${encodeURIComponent(soql)}`, "GET");
      const found = object(res.body) && Array.isArray(res.body.records) ? res.body.records.filter(object)[0] : undefined;
      if (!found || found.Id !== discovery.rowId) return { verified: false };
      return { verified: ["PublishStatus", "LastPublishStatusDateTime", "CalculatedInsightStatus", "LastRunStatus",
        "LastRunStatusDateTime", "ActivationStatus", "LastActivationStatusDateTime", "LastPublishStatus",
        "TargetStatus", "LastTargetStatusDateTime"].some(field => present(found[field])) };
    };
    const result = await runCdpPublishLifecycle({ root, route, actionName: input.actionName,
      descriptorInputs: input.descriptorInputs, discover, request, verify });
    return { status: result.status, body: result.body, contextSchema: result.contextSchema,
      ...(result.cleanupError ? { cleanupError: result.cleanupError } : {}) };
  }

  /** Refresh ONLY owned ActSetup probe data streams, invoking natively and verifying the lifecycle state. */
  async invokeCdpRefreshWithContext(ref: Key, input: { actionName: string; apiVersion: string; descriptorInputs: Array<{ name: string; type?: string; required?: boolean }> }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string; contextSchema?: unknown }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeCdpRefreshWithContext", [ref, input], signed);
    if (!key(ref) || !object(input) || input.actionName !== "cdpRefreshDataStream" ||
      !/^v\d+(?:\.\d+)?$/.test(input.apiVersion ?? "") || !Array.isArray(input.descriptorInputs)) {
      throw authFailure(400, "invalid_cdp_refresh", "The discovered CDP refresh action, API version, and descriptor inputs are required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const root = `/services/data/${input.apiVersion}`;
    const route = `${root}/actions/standard/${input.actionName}`;
    const request: CdpPubTransport = async (path, method, body) => {
      try {
        const response = await sfRequest(env, row, path, method, body === undefined ? undefined : JSON.stringify(body),
          crypto.randomUUID(), true, AbortSignal.timeout(60_000));
        return { status: response.status, ok: response.ok, body: await responseJson(response) };
      } catch { return { status: 502, ok: false, body: { errorCode: "CDP_PUB_UPSTREAM_UNAVAILABLE", message: "Salesforce request failed; discovery treats this as absent substrate." } }; }
    };
    const soql = "SELECT Id, Name, ImportRunStatus FROM DataStream WHERE Name LIKE 'ActSetup%' AND DataStreamStatus='ACTIVE' LIMIT 1";
    const discover = async (): Promise<CdpPubDiscovery> => {
      const res = await request(`${root}/query?q=${encodeURIComponent(soql)}`, "GET");
      const rows = object(res.body) && Array.isArray(res.body.records) ? res.body.records.filter(object) : [];
      const first = rows[0] as Record<string, unknown> | undefined;
      const value = first && typeof first.Id === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(first.Id) ? first.Id : undefined;
      if (typeof value === "string") return { found: true, value, rowId: value, soql };
      return { found: false, evidence: [`${soql} -> ${rows.length}`] };
    };
    const verify = async (discovery: { rowId: string; soql: string }): Promise<{ verified: boolean }> => {
      void discovery.soql;
      const res = await request(`${root}/query?q=${encodeURIComponent(
        `SELECT Id, ImportRunStatus, LastDataChangeStatusDateTime FROM DataStream WHERE Id='${discovery.rowId}'`)}`, "GET");
      const found = object(res.body) && Array.isArray(res.body.records) ? res.body.records.filter(object)[0] : undefined;
      if (!found || found.Id !== discovery.rowId) return { verified: false };
      const present = (value: unknown): boolean => (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value));
      return { verified: present(found.ImportRunStatus) || present(found.LastDataChangeStatusDateTime) };
    };
    const result = await runCdpPublishLifecycle({ root, route, actionName: input.actionName,
      descriptorInputs: input.descriptorInputs, discover, request, verify });
    return { status: result.status, body: result.body, contextSchema: result.contextSchema,
      ...(result.cleanupError ? { cleanupError: result.cleanupError } : {}) };
  }

  /** Ground summaries in a searchable UI API record, creating a disposable record if needed. */
  async invokeRecordSummaryWithContext(ref: Key, input: { apiVersion: string; route: string }, signed?: SignedRpcEnvelope):
    Promise<{ status: number; body: unknown; cleanupError?: string }> {
    await verifySignedRpcCall(this.env as AuthEnv, "invokeRecordSummaryWithContext", [ref, input], signed);
    if (!key(ref) || !object(input) || !/^\d+(?:\.\d+)?$/.test(input.apiVersion) ||
        input.route !== `/services/data/v${input.apiVersion}/actions/standard/summarizeRecord`) {
      throw authFailure(400, "invalid_summary_probe", "A discovered record summary route is required.");
    }
    const env = this.env as AuthEnv;
    const row = await credentialForEntrypoint(env, ref);
    const apiRoot = `/services/data/v${input.apiVersion}`;
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await sfRequest(env, row, path, method,
        body === undefined ? undefined : JSON.stringify(body), crypto.randomUUID(), true);
      return { status: response.status, ok: response.ok, body: await responseJson(response) };
    };
    const catalog = await request(`${apiRoot}/sobjects/`);
    if (!catalog.ok) return { status: catalog.status, body: catalog.body };
    const objects = object(catalog.body) && Array.isArray(catalog.body.sobjects)
      ? catalog.body.sobjects.filter(object).filter(item => typeof item.name === "string" &&
        /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(item.name) && item.queryable === true &&
        item.searchable === true && item.layoutable === true)
        .sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(0, 32) : [];
    const usable: Array<{ name: string; createable: boolean }> = [];
    const succeeded = (body: unknown) => Array.isArray(body) && body.length > 0 && body.every(item =>
      object(item) && item.isSuccess === true && (!Array.isArray(item.errors) || item.errors.length === 0));
    let result: { status: number; body: unknown } = { status: 422, body: {
      errorCode: "SUMMARY_CONTEXT_MISSING", message: "No searchable object with an accessible UI API layout is available.",
    } };
    for (const item of objects) {
      const name = String(item.name);
      const layout = await request(`${apiRoot}/ui-api/layout/${name}`);
      if (!layout.ok || !object(layout.body) || typeof layout.body.id !== "string") continue;
      usable.push({ name, createable: item.createable === true });
      const sample = await request(`${apiRoot}/query?q=${encodeURIComponent(`SELECT Id FROM ${name} LIMIT 1`)}`);
      if (!sample.ok) continue;
      const records = object(sample.body) && Array.isArray(sample.body.records) ? sample.body.records.filter(object) : [];
      const id = records[0]?.Id;
      if (typeof id !== "string" || !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(id)) continue;
      const action = await request(input.route, "POST", { inputs: [{ recordId: id }] });
      result = { status: action.status, body: action.body };
      // Preserve authorization failures; another record must not mask a missing user permission.
      if ((action.ok && succeeded(action.body)) || /permission|access|authoriz/i.test(salesforceError(action.body).message ??
        JSON.stringify(action.body))) return result;
    }
    for (const candidate of usable.filter(item => item.createable)) {
      const built = await synthesizeRecordValues(env, row, apiRoot, candidate.name,
        "Action Searcher temporary summary probe");
      if ("failure" in built) { result = built.failure; continue; }
      const path = `${apiRoot}/sobjects/${candidate.name}`;
      const create = await request(path, "POST", built.values);
      if (!create.ok || !object(create.body) || typeof create.body.id !== "string" ||
          !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(create.body.id)) {
        result = { status: create.status, body: create.body }; continue;
      }
      const id = create.body.id;
      let cleanupError: string | undefined;
      try {
        const action = await request(input.route, "POST", { inputs: [{ recordId: id }] });
        result = { status: action.status, body: action.body };
      } finally {
        let deleted = false;
        for (let attempt = 0; attempt < 2 && !deleted; attempt++) {
          try {
            const cleanup = await request(`${path}/${id}`, "DELETE");
            deleted = cleanup.ok || cleanup.status === 404;
            if (!deleted) cleanupError = `Temporary summary record cleanup returned HTTP ${cleanup.status}.`;
          } catch { cleanupError = "Temporary summary record cleanup could not reach Salesforce."; }
        }
        if (deleted) cleanupError = undefined;
      }
      // Never create another fixture after a cleanup failure.
      if (cleanupError) return { ...result, cleanupError };
      if (result.status >= 200 && result.status < 300 && succeeded(result.body)) return result;
    }
    return result;
  }

  async getCallableToolUrlsForChannel(
    channelId: string,
    options?: { teamId?: string; orgId?: string; apiVersion?: string }, signed?: SignedRpcEnvelope,
  ): Promise<string[]> {
    await verifySignedRpcCall(this.env as AuthEnv, "getCallableToolUrlsForChannel", [channelId, options], signed);
    if (!validSalesforceChannelId(channelId) || (!!options?.teamId !== !!options?.orgId)) {
      throw authFailure(400, "invalid_request", "A valid channel and complete tenant scope are required.");
    }
    const env = this.env as AuthEnv;
    const row = options?.teamId && options.orgId
      ? await credentialForEntrypoint(env, { teamId: options.teamId, orgId: options.orgId, channelId })
      : await resolveCredentialForChannel(env, channelId);
    if (!row) throw authFailure(404, "channel_not_found", "The Salesforce channel is unavailable.");
    const auth = await token(env, row);
    return getCallableToolUrlsForChannel(channelId, {
      env,
      conn: { instanceUrl: auth.instanceUrl, accessToken: auth.accessToken },
      teamId: row.team_id,
      orgId: row.org_id,
      apiVersion: options?.apiVersion,
    });
  }

  async getTokenForChannel(
    channelId: string,
    options?: { teamId?: string; orgId?: string }, signed?: SignedRpcEnvelope
  ): Promise<Token & { orgId: string; teamId: string }> {
    await verifySignedRpcCall(this.env as AuthEnv, "getTokenForChannel", [channelId, options], signed);
    if (!validSalesforceChannelId(channelId) || (!!options?.teamId !== !!options?.orgId)) {
      throw authFailure(400, "invalid_request", "A valid channel and complete tenant scope are required.");
    }
    const row = options?.teamId && options.orgId
      ? await credentialForEntrypoint(this.env as AuthEnv, { teamId: options.teamId, orgId: options.orgId, channelId })
      : await resolveCredentialForChannel(this.env as AuthEnv, channelId);
    if (!row) throw authFailure(404, "channel_not_found", `No Salesforce credentials found for channel '${channelId}'.`);
    const auth = await token(this.env, row);
    return {
      accessToken: auth.accessToken,
      instanceUrl: auth.instanceUrl,
      expiresAt: auth.expiresAt,
      orgId: row.org_id,
      teamId: row.team_id,
    };
  }

  /** Returns the active ECAs attached to one connected channel without exposing secrets. */
  async listExecutionUsersForChannel(channelId: string, signed?: SignedRpcEnvelope): Promise<ExecutionUserReference[]> {
    const org = await verifySignedRpcCall(this.env as AuthEnv, "listExecutionUsersForChannel", [channelId], signed);
    const refs = await activeChannelExecutionUsers(this.env as AuthEnv, channelId);
    if (org && refs.some(r => r.orgId !== org)) throw authFailure(401, "rpc_unauthorized", "Channel is not bound to the calling org.");
    return refs;
  }

  /** Mints a token for one ECA after rechecking the exact active tenant grant. */
  async getTokenForExecutionUser(
    channelId: string,
    integrationUserId: string,
    scope: Key, signed?: SignedRpcEnvelope,
  ): Promise<Token & Key & { integrationUserId: string }> {
    await verifySignedRpcCall(this.env as AuthEnv, "getTokenForExecutionUser", [channelId, integrationUserId, scope], signed);
    const env = this.env as AuthEnv;
    if (!validSalesforceChannelId(channelId) || !validSalesforceUserId(integrationUserId) ||
        !key(scope as unknown as Record<string, unknown>) || !sameSalesforceId(scope.channelId, channelId)) {
      throw authFailure(400, "invalid_request", "A valid channel, execution user, and tenant scope are required.");
    }
    const row = await activeExecutionCredential(env, scope, integrationUserId);
    if (!row) throw authFailure(404, "execution_user_not_found", "The execution user is not connected to this active channel.");
    const auth = await token(env, row);
    return {
      accessToken: auth.accessToken,
      instanceUrl: auth.instanceUrl,
      expiresAt: auth.expiresAt,
      teamId: row.team_id,
      orgId: row.org_id,
      channelId: row.channel_id,
      integrationUserId: row.integration_user_id,
    };
  }

  async #cacheCredential(options: any): Promise<Credential> {
    const scope=requireScope(options);
    return credentialForEntrypoint(this.env as AuthEnv, scope);
  }

  async getUserData(userId: string, channelId?: string, options?: any, signed?: SignedRpcEnvelope): Promise<any> {
    await verifySignedRpcCall(this.env as AuthEnv, "getUserData", [userId, channelId, options], signed);
    const cacheRow = await this.#cacheCredential(options);
    if (typeof channelId !== "undefined" && channelId !== cacheRow.channel_id) throw new SecurityError(403,"conflicting_tenant_scope");
    const cacheStore = new UserDataCacheStore(this.env.DB, {teamId:cacheRow.team_id,orgId:cacheRow.org_id,channelId:cacheRow.channel_id});
    const row = await cacheStore.get(userId);
    if (!row) return null;
    try {
      return JSON.parse(row.data);
    } catch {
      return row.data;
    }
  }

  async getUserETag(userId: string, options?: any, signed?: SignedRpcEnvelope): Promise<string | null> {
    await verifySignedRpcCall(this.env as AuthEnv, "getUserETag", [userId, options], signed);
    const cacheRow = await this.#cacheCredential(options);
    const cacheStore = new UserDataCacheStore(this.env.DB, {teamId:cacheRow.team_id,orgId:cacheRow.org_id,channelId:cacheRow.channel_id});
    return await cacheStore.getUserETag(userId);
  }

  async saveUserData(
    userId: string,
    channelId: string | undefined,
    data: any,
    ttlSeconds?: number,
    options?: any, signed?: SignedRpcEnvelope
  ): Promise<{ ok: boolean }> {
    await verifySignedRpcCall(this.env as AuthEnv, "saveUserData", [userId, channelId, data, ttlSeconds, options], signed);
    const cacheRow = await this.#cacheCredential(options);
    const cacheStore = new UserDataCacheStore(this.env.DB, {teamId:cacheRow.team_id,orgId:cacheRow.org_id,channelId:cacheRow.channel_id});
    await cacheStore.put({
      userId,
      channelId,
      orgId: cacheRow.org_id,
      teamId: cacheRow.team_id,
      data,
      ttlSeconds,
    });
    await purgeEdgeCache(this.ctx, scopedTags(requireScope(options),[`sf-user-${userId}`]));
    return { ok: true };
  }

  async getUserData360(userId: string, channelId?: string, options?: any, signed?: SignedRpcEnvelope): Promise<any> {
    await verifySignedRpcCall(this.env as AuthEnv, "getUserData360", [userId, channelId, options], signed);
    const cacheRow = await this.#cacheCredential(options);
    const cacheStore = new UserDataCacheStore(this.env.DB, {teamId:cacheRow.team_id,orgId:cacheRow.org_id,channelId:cacheRow.channel_id});
    const cached = await cacheStore.get(userId);
    if (cached) {
      try {
        return JSON.parse(cached.data);
      } catch {
        return cached.data;
      }
    }

    const cred = cacheRow;
    if (!cred) {
      throw authFailure(404, "channel_not_found", `No Salesforce credentials found for channel '${channelId || "default"}'.`);
    }

    const requestId = crypto.randomUUID();
    const userData = await querySalesforceUserData(this.env, cred, userId, requestId);
    if (!userData) {
      throw authFailure(404, "user_not_found", `User '${userId}' not found in Salesforce.`);
    }

    await cacheStore.put({
      userId,
      channelId: cred.channel_id,
      orgId: cred.org_id,
      teamId: cred.team_id,
      data: userData,
      ttlSeconds: 300,
    });

    return userData;
  }

  async getMessagingSessionData360(sessionId: string, channelId?: string, options?: any, signed?: SignedRpcEnvelope): Promise<any> {
    await verifySignedRpcCall(this.env as AuthEnv, "getMessagingSessionData360", [sessionId, channelId, options], signed);
    const cacheRow = await this.#cacheCredential(options);
    const cacheStore = new UserDataCacheStore(this.env.DB, {teamId:cacheRow.team_id,orgId:cacheRow.org_id,channelId:cacheRow.channel_id});
    const cached = await cacheStore.get(sessionId);
    if (cached) {
      try {
        return JSON.parse(cached.data);
      } catch {
        return cached.data;
      }
    }

    const cred = cacheRow;
    if (!cred) {
      throw authFailure(404, "channel_not_found", `No Salesforce credentials found for channel '${channelId || "default"}'.`);
    }

    const requestId = crypto.randomUUID();
    const sessionData = await querySalesforceMessagingSession(this.env, cred, sessionId, requestId);
    if (!sessionData) {
      throw authFailure(404, "session_not_found", `MessagingSession '${sessionId}' not found.`);
    }

    await cacheStore.put({
      userId: sessionId,
      channelId: cred.channel_id,
      orgId: cred.org_id,
      teamId: cred.team_id,
      data: sessionData,
      ttlSeconds: 300,
    });

    return sessionData;
  }

  async purgeCache(tags: string[] | string, options?: any, signed?: SignedRpcEnvelope): Promise<boolean> {
    await verifySignedRpcCall(this.env as AuthEnv, "purgeCache", [tags, options], signed);
    const tagList = Array.isArray(tags) ? tags : [tags];
    scopedTags(requireScope(options),tagList);
    const cacheRow = await this.#cacheCredential(options);
    const cacheStore = new UserDataCacheStore(this.env.DB, {teamId:cacheRow.team_id,orgId:cacheRow.org_id,channelId:cacheRow.channel_id});
    for (const tag of tagList) {
      if (tag.startsWith("sf-user-")) {
        await cacheStore.delete(tag.slice("sf-user-".length));
      } else if (tag.startsWith("sf-session-")) {
        await cacheStore.delete(tag.slice("sf-session-".length));
      }
    }
    return purgeEdgeCache(this.ctx, scopedTags(requireScope(options),tagList));
  }

  async getUserConversationHistory(
    userId: string,
    options?: { channelId?: string; teamId?: string; orgId?: string; currentSessionId?: string; limit?: number }, signed?: SignedRpcEnvelope
  ): Promise<UserConversationHistory> {
    await verifySignedRpcCall(this.env as AuthEnv, "getUserConversationHistory", [userId, options], signed);
    const cred = await this.#cacheCredential(options);
    if (!cred) {
      throw authFailure(404, "channel_not_found", `No Salesforce credentials found for channel '${options?.channelId || "default"}'.`);
    }
    const requestId = crypto.randomUUID();
    return querySalesforceUserConversations(this.env, cred, userId, options, requestId);
  }
}

export default {
  async fetch(request: Request, env: AuthEnv, ctx?: any): Promise<Response> {
    const incomingRequestId = request.headers.get("x-request-id");
    const requestId = incomingRequestId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(incomingRequestId)
      ? incomingRequestId.toLowerCase()
      : crypto.randomUUID();
    // F15 piggyback: daily retention claim + waitUntil purge, never blocking.
    void maybeRunRetention(env.DB, ctx);
    try { return await handle(request, env, requestId, ctx); }
    catch (cause) {
      const safe = cause instanceof SecurityError ? {status:cause.status,code:cause.code,message:cause.code,retryable:false} : cause instanceof AuthFailure ? cause.failure : {
        status: 500,
        code: "internal_error",
        message: "The Salesforce auth service encountered an internal error. Retry and share the request ID with support.",
        retryable: true,
      };
      console.error(JSON.stringify({ requestId, error: safe.code, status: safe.status }));
      return failure(requestId, safe);
    }
  },
  // F15 dormant-ready cron entry: the account is at the Workers Free cron
  // limit, so the live trigger is the fetch piggyback above; if cron capacity
  // ever frees up, re-adding triggers.crons activates this unchanged.
  async scheduled(controller: ScheduledController, env: AuthEnv): Promise<void> {
    const summary = await purgeRetention(env.DB);
    console.log(JSON.stringify({ msg: "f15_retention_purge", cron: controller.cron, ...summary }));
  },
} satisfies ExportedHandler<AuthEnv>;
