import { test, expect } from 'bun:test';
import {
  apexRelayActionName,
  apexRelayAccepted,
  apexRelayInputSetValid,
  apexRelayMessageKey,
  invokeApexRelayWithContext,
} from './apex-relay-context';

const ROOT = '/services/data/v67.0';
const ROUTE = `${ROOT}/actions/custom/apex/MCPOmniChannelMessageDispatcher`;
const OWNER = '005000000000001AAA';
const CHANNEL_ID = '0Mj000000000001AAA';
const END_USER_ID = '0oR000000000001AAA';
const SESSION_ID = '0Mw000000000001AAA';

const RELAY_INPUTS = [
  { name: 'messageChoice', type: 'STRING', required: true,
    description: 'Predefined system message key (Greeting, System Maintenance Notice, Queue Delay Warning) or custom payload' },
  { name: 'recordId', type: 'ID', required: true },
  { name: 'serviceChannel', type: 'STRING', required: false },
  { name: 'simulateFailure', type: 'BOOLEAN', required: false },
];
// The external-callout twin: must never match the relay contract.
const TWIN_INPUTS = [
  { name: 'content', type: 'STRING', required: true },
  { name: 'sender', type: 'STRING', required: false },
  { name: 'userId', type: 'STRING', required: true },
];

test('relay routes classify by live route shape only', () => {
  expect(apexRelayActionName(ROUTE)).toBe('MCPOmniChannelMessageDispatcher');
  expect(apexRelayActionName(`${ROOT}/actions/custom/apex/FutureRelayTwin`)).toBe('FutureRelayTwin');
  expect(apexRelayActionName(`${ROOT}/actions/custom/flow/SomeFlow`)).toBeNull();
  expect(apexRelayActionName(`${ROOT}/actions/standard/submit`)).toBeNull();
  expect(apexRelayActionName('not a route')).toBeNull();
});

test('relay input set matches the contract exactly and rejects the callout twin', () => {
  expect(apexRelayInputSetValid(RELAY_INPUTS)).toBe(true);
  expect(apexRelayInputSetValid(TWIN_INPUTS)).toBe(false);
  expect(apexRelayInputSetValid([{ name: 'recordId', required: true }, { name: 'messageChoice', required: false }])).toBe(false);
  expect(apexRelayInputSetValid([{ name: 'recordId', required: true }, { name: 'messageChoice', required: true },
    { name: 'extra', required: false }])).toBe(false);
  expect(apexRelayInputSetValid([])).toBe(false);
  expect(apexRelayInputSetValid(null)).toBe(false);
});

test('message key resolves from the live description, never custom content', () => {
  expect(apexRelayMessageKey(RELAY_INPUTS)).toBe('Greeting');
  expect(apexRelayMessageKey([{ name: 'messageChoice', required: true }])).toBe('Greeting');
  expect(apexRelayMessageKey([])).toBe('Greeting');
});

test('relay acceptance requires the success envelope plus the recordId echo', () => {
  const ok = [{ isSuccess: true, errors: null, outputValues: { success: true, recordId: SESSION_ID } }];
  expect(apexRelayAccepted(200, ok, SESSION_ID)).toBe(true);
  expect(apexRelayAccepted(200, [{ isSuccess: true, errors: [], outputValues: { success: true, recordId: '0Mw000000000002AAA' } }], SESSION_ID)).toBe(false);
  expect(apexRelayAccepted(200, [{ isSuccess: true, errors: [], outputValues: { success: false, recordId: SESSION_ID } }], SESSION_ID)).toBe(false);
  expect(apexRelayAccepted(200, [{ isSuccess: false, errors: [] }], SESSION_ID)).toBe(false);
  expect(apexRelayAccepted(400, ok, SESSION_ID)).toBe(false);
  expect(apexRelayAccepted(200, [], SESSION_ID)).toBe(false);
});

type HarnessOptions = { inputs?: any[]; sessionChanged?: boolean; deleteStuck?: boolean };
function harness(options: HarnessOptions = {}) {
  let endUser: any = null;
  let session: any = null;
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  const inputs = options.inputs ?? RELAY_INPUTS;
  const result = (body: any, status = 200) => ({ body, status, ok: status < 400 });
  const request = async (path: string, method = 'GET', body?: any) => {
    calls.push({ path, method, body });
    if (method === 'GET' && path === ROUTE) return result({ inputs });
    if (path === `${ROOT}/sobjects/MessagingEndUser/describe`) {
      return result({ createable: true, deletable: true, queryable: true, fields: [{ name: 'Name' },
        { name: 'MessageType', picklistValues: [{ active: true, value: 'Text' }, { active: true, value: 'WhatsApp' }] }] });
    }
    if (path === `${ROOT}/sobjects/MessagingSession/describe`) {
      return result({ createable: true, deletable: true, queryable: true, fields: [{ name: 'Status' },
        { name: 'Origin', picklistValues: [{ active: true, value: 'AgentInitiated' }] }] });
    }
    if (path === `${ROOT}/sobjects/MessagingEndUser` && method === 'POST') {
      endUser = { ...body, Id: END_USER_ID };
      return result({ id: END_USER_ID }, 201);
    }
    if (path === `${ROOT}/sobjects/MessagingSession` && method === 'POST') {
      session = { ...body, Id: SESSION_ID };
      return result({ id: SESSION_ID }, 201);
    }
    if (path === `${ROOT}/sobjects/MessagingEndUser/${END_USER_ID}`) {
      if (method === 'DELETE') {
        if (!options.deleteStuck) endUser = null;
        return result(null, 204);
      }
      return endUser ? result(endUser) : result([], 404);
    }
    if (path === `${ROOT}/sobjects/MessagingSession/${SESSION_ID}`) {
      if (method === 'DELETE') {
        if (!options.deleteStuck) session = null;
        return result(null, 204);
      }
      return session ? result(session) : result([], 404);
    }
    if (path.startsWith(`${ROOT}/query?q=`)) {
      const soql = decodeURIComponent(path.slice(`${ROOT}/query?q=`.length));
      if (soql.includes('FROM MessagingChannel')) {
        return result({ records: [{ Id: CHANNEL_ID, MessageType: 'Text' }] });
      }
      if (soql.includes('FROM MessagingSession')) {
        return result({ records: session ? [{ ...session, Status: options.sessionChanged ? 'Active' : session.Status }] : [] });
      }
      return result({ records: endUser ? [endUser] : [] });
    }
    if (method === 'POST' && path === ROUTE) {
      return result([{ isSuccess: true, errors: null,
        outputValues: { success: true, dispatchedMessage: 'Hello!', recordId: body?.inputs?.[0]?.recordId } }]);
    }
    throw new Error(`unexpected call ${method} ${path}`);
  };
  const build = async (_name: string, _marker: string, values: any) => ({ values });
  return { request, build, calls };
}

test('owned lifecycle invokes with the predefined key and verifies session-unchanged plus cleanup', async () => {
  const h = harness();
  const outcome = await invokeApexRelayWithContext({ root: ROOT, route: ROUTE, ownerUserId: OWNER,
    request: h.request, build: h.build });
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema?.verified).toBe(true);
  expect(outcome.contextSchema?.sessionId).toBe(SESSION_ID);
  expect(outcome.contextSchema?.sessionUnchanged).toBe(true);
  expect(outcome.contextSchema?.messageKey).toBe('Greeting');
  expect(outcome.cleanupError).toBeUndefined();
  const posts = h.calls.filter((c) => c.path === ROUTE && c.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0].body).toEqual({ inputs: [{ recordId: SESSION_ID, messageChoice: 'Greeting' }] });
  expect(h.calls.some((c) => c.path === `${ROOT}/sobjects/MessagingSession/${SESSION_ID}` && c.method === 'DELETE')).toBe(true);
  expect(h.calls.some((c) => c.path === `${ROOT}/sobjects/MessagingEndUser/${END_USER_ID}` && c.method === 'DELETE')).toBe(true);
});

test('twin input set refuses without posting', async () => {
  const h = harness({ inputs: TWIN_INPUTS });
  const outcome = await invokeApexRelayWithContext({ root: ROOT, route: ROUTE, ownerUserId: OWNER,
    request: h.request, build: h.build });
  expect(outcome.status).toBe(422);
  expect((outcome.body as any).errorCode).toBe('APEX_RELAY_ACTION_SCHEMA_MISMATCH');
  expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
});

test('changed session withholds verification but still cleans up', async () => {
  const h = harness({ sessionChanged: true });
  const outcome = await invokeApexRelayWithContext({ root: ROOT, route: ROUTE, ownerUserId: OWNER,
    request: h.request, build: h.build });
  expect(outcome.contextSchema?.verified).toBe(false);
  expect(outcome.contextSchema?.sessionUnchanged).toBe(false);
  expect(outcome.cleanupError).toBeUndefined();
});

test('stuck deletes stay explicit after native success', async () => {
  const h = harness({ deleteStuck: true });
  const outcome = await invokeApexRelayWithContext({ root: ROOT, route: ROUTE, ownerUserId: OWNER,
    request: h.request, build: h.build });
  expect(outcome.contextSchema?.verified).toBe(false);
  expect(outcome.cleanupError).toContain('cleanup');
});
