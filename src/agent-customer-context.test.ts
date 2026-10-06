import { describe, expect, test } from 'bun:test';
import {
  AGENT_SETUP_REPROBE_CODES, agentCustomerShape, agentFlowNamespace, agentProducerCandidates,
  agentProducerIdentity, agentProducerListQuery, invokeAgentFlowWithProducerContext,
  isAgentCustomerSetupReprobe,
} from './agent-customer-context';

type Result = { status: number; ok: boolean; body: any };

const ROOT = '/services/data/v67.0';
const ROUTE = `${ROOT}/actions/custom/flow/FldSvcAiAgents__AgentFlow`;
const PRODUCER_ROUTE = `${ROOT}/actions/custom/flow/FldSvcAiAgents__SendVerificationCode`;
const CONTACT_ID = '003xx0000001AbCEAU';

const ok = (body: unknown, status = 200): Result => ({ status, ok: status >= 200 && status < 300, body });
const notFound = (): Result => ({ status: 404, ok: false, body: [{ errorCode: 'NOT_FOUND', message: 'No such record' }] });
const producerDescriptor = () => ({
  inputs: [{ name: 'email', type: 'STRING' }],
  outputs: [{ name: 'verificationCode' }, { name: 'authenticationKey' }, { name: 'customerId' }, { name: 'customerType' }],
});
const agentDescriptor = (inputs: Array<Record<string, unknown>> = [
  { name: 'customerId', type: 'STRING' }, { name: 'conversationId', type: 'STRING', required: false },
]) => ({ inputs, outputs: [{ name: 'outcome' }] });
const contactDescribe = () => ({
  name: 'Contact', createable: true, queryable: true, deletable: true,
  fields: [
    { name: 'LastName', type: 'string', createable: true },
    { name: 'Email', type: 'email', createable: true },
  ],
});
const producerAccepted = () => [{ isSuccess: true, errors: null, outputValues: [
  { name: 'customerId', value: 'CUST-1' }, { name: 'customerType', value: 'Person' },
] }];
const agentAccepted = () => [{ isSuccess: true, errors: null, outputValues: { outcome: 'booked' } }];

describe('agent re-probe routing', () => {
  test('matches custom flows with proven agent setup codes only', () => {
    for (const code of AGENT_SETUP_REPROBE_CODES) {
      expect(isAgentCustomerSetupReprobe('custom/flow', code)).toBe(true);
    }
    expect(isAgentCustomerSetupReprobe('custom/flow', 'FLOW_ACTION_ELEMENT_UNRESOLVED')).toBe(false);
    expect(isAgentCustomerSetupReprobe('standard', 'FLOW_AGENT_CONTEXT_REQUIRED')).toBe(false);
    expect(isAgentCustomerSetupReprobe('custom/flow', null)).toBe(false);
    expect(isAgentCustomerSetupReprobe('custom/flow', undefined)).toBe(false);
  });
  test('parses namespaced flow routes only', () => {
    expect(agentFlowNamespace(ROUTE)).toBe('FldSvcAiAgents');
    expect(agentFlowNamespace(`${ROOT}/actions/custom/flow/UnmanagedFlow`)).toBeNull();
    expect(agentFlowNamespace(`${ROOT}/actions/standard/changeOrderSummaryPreview`)).toBeNull();
    expect(agentFlowNamespace('not-a-route')).toBeNull();
    expect(agentFlowNamespace(`${ROOT}/actions/custom/flow/__Bad`)).toBeNull();
  });
});

describe('agentCustomerShape', () => {
  test('maps customer, customer-type, and optional conversation inputs', () => {
    const shape = agentCustomerShape([
      { name: 'customerId', type: 'STRING' }, { name: 'customerType', type: 'STRING' },
      { name: 'conversationId', type: 'STRING', required: false },
    ]);
    expect(shape).toEqual({ customerInput: 'customerId', customerTypeInput: 'customerType', unbindableInputs: [] });
  });
  test('flags required conversation and intent inputs as unbindable', () => {
    const shape = agentCustomerShape([
      { name: 'customerId', type: 'STRING' }, { name: 'conversationId', type: 'STRING', required: true },
      { name: 'intent', type: 'STRING', required: true },
    ]);
    expect(shape?.unbindableInputs).toEqual(['conversationId', 'intent']);
  });
  test('falls back to id-typed person inputs and rejects customerless shapes', () => {
    expect(agentCustomerShape([{ name: 'contactId', type: 'ID' }])?.customerInput).toBe('contactId');
    expect(agentCustomerShape([{ name: 'recordId', type: 'ID' }])).toBeNull();
    expect(agentCustomerShape([{ name: 'topic', type: 'STRING' }])).toBeNull();
    expect(agentCustomerShape([])).toBeNull();
    expect(agentCustomerShape(undefined)).toBeNull();
    expect(agentCustomerShape([{ name: 'bad name!' }])).toBeNull();
  });
});

describe('producer discovery helpers', () => {
  test('builds a bounded namespaced view query', () => {
    expect(agentProducerListQuery('FldSvcAiAgents')).toContain("LIKE 'FldSvcAiAgents%'");
    expect(agentProducerListQuery('FldSvcAiAgents')).toContain('LIMIT 25');
    expect(agentProducerListQuery('bad name')).toBeNull();
    expect(agentProducerListQuery('')).toBeNull();
  });
  test('collects validated candidate names capped at five', () => {
    const body = { records: [{ ApiName: 'FldSvcAiAgents__Producer' }, { ApiName: 'bad name' }, { ApiName: 'FldSvcAiAgents__Producer' }, {}] };
    expect(agentProducerCandidates(body)).toEqual(['FldSvcAiAgents__Producer']);
    expect(agentProducerCandidates({})).toEqual([]);
    expect(agentProducerCandidates(null)).toEqual([]);
  });
  test('reads producer customer identity from output values', () => {
    expect(agentProducerIdentity(producerAccepted())).toEqual({ customerId: 'CUST-1', customerType: 'Person' });
    expect(agentProducerIdentity([{ isSuccess: true, outputValues: [{ name: 'customerId', value: 'C-9' }] }]))
      .toEqual({ customerId: 'C-9' });
    expect(agentProducerIdentity([{ isSuccess: true, outputValues: [] }])).toBeNull();
    expect(agentProducerIdentity([{ isSuccess: false }])).toBeNull();
    expect(agentProducerIdentity(null)).toBeNull();
  });
});

describe('invokeAgentFlowWithProducerContext', () => {
  const build = async (_name: string, marker: string, values: Record<string, unknown>) => ({ values: { ...values, LastName: marker } });
  test('rejects invalid routes and windows without touching the org', async () => {
    let calls = 0;
    const request = async (): Promise<Result> => { calls++; return notFound(); };
    const badRoute = await invokeAgentFlowWithProducerContext({ root: ROOT, route: `${ROOT}/actions/standard/x`, request, build });
    expect(badRoute.body.errorCode).toBe('FLOW_AGENT_ROUTE_INVALID');
    const badWindow = await invokeAgentFlowWithProducerContext({ root: ROOT, route: ROUTE, verificationWindowMs: -1, request, build });
    expect(badWindow.body.errorCode).toBe('FLOW_AGENT_WINDOW_INVALID');
    expect(calls).toBe(0);
  });
  test('converts with the producer identity and sweeps the owned contact', async () => {
    const posts: Array<{ path: string; body: any }> = [];
    let marker = '';
    const request = async (path: string, method = 'GET', body?: any): Promise<Result> => {
      if (method === 'POST') { posts.push({ path, body }); }
      if (method === 'DELETE') return { status: 204, ok: true, body: null };
      if (path === ROUTE && method === 'GET') return ok(agentDescriptor());
      if (path.includes('/query?')) {
        if (path.includes('FlowDefinitionView')) return ok({ records: [{ ApiName: 'FldSvcAiAgents__SendVerificationCode' }] });
        return ok({ totalSize: 0, records: [] });
      }
      if (path === PRODUCER_ROUTE && method === 'GET') return ok(producerDescriptor());
      if (path === `${ROOT}/sobjects/Contact/describe`) return ok(contactDescribe());
      if (path === `${ROOT}/sobjects/Contact` && method === 'POST') return ok({ id: CONTACT_ID }, 201);
      if (path === `${ROOT}/sobjects/Contact/${CONTACT_ID}`) return ok({ Id: CONTACT_ID, LastName: marker, Email: 'x@example.invalid' });
      if (path === PRODUCER_ROUTE && method === 'POST') return ok(producerAccepted());
      if (path === ROUTE && method === 'POST') return ok(agentAccepted());
      return notFound();
    };
    const trackingBuild = async (name: string, m: string, values: Record<string, unknown>) => { marker = m; return build(name, m, values); };
    // Readback happens before the 404 check; serve the marker once, then 404.
    let readbacks = 0;
    const wrapped = async (path: string, method = 'GET', body?: any): Promise<Result> => {
      if (path === `${ROOT}/sobjects/Contact/${CONTACT_ID}` && method === 'GET') {
        readbacks++;
        return readbacks === 1 ? request(path, method, body) : notFound();
      }
      return request(path, method, body);
    };
    const result = await invokeAgentFlowWithProducerContext({ root: ROUTE.split('/actions/')[0], route: ROUTE, request: wrapped, build: trackingBuild });
    expect(result.contextSchema?.verified).toBe(true);
    expect(result.cleanupError).toBeUndefined();
    const agentPost = posts.find((entry) => entry.path === ROUTE);
    expect(agentPost?.body).toEqual({ inputs: [{ customerId: 'CUST-1' }] });
    const producerPost = posts.find((entry) => entry.path === PRODUCER_ROUTE);
    expect(String((producerPost?.body.inputs[0] as Record<string, unknown>).email)).toContain('@example.invalid');
    expect(result.contextSchema?.producerRoute).toBe(PRODUCER_ROUTE);
    expect(result.contextSchema?.verificationRecordIds).toEqual([CONTACT_ID]);
  });
  test('required conversation inputs fail setup-blocked before any fixture', async () => {
    const posts: string[] = [];
    const request = async (path: string, method = 'GET'): Promise<Result> => {
      if (method === 'POST') posts.push(path);
      if (path === ROUTE) return ok(agentDescriptor([
        { name: 'customerId', type: 'STRING' }, { name: 'conversationId', type: 'STRING', required: true },
      ]));
      return notFound();
    };
    const result = await invokeAgentFlowWithProducerContext({ root: ROOT, route: ROUTE, request, build });
    expect(result.body.errorCode).toBe('FLOW_AGENT_CONVERSATION_REQUIRED');
    expect(posts).toEqual([]);
    expect(result.contextSchema?.verified).toBe(false);
  });
  test('missing producers and customerless shapes fail setup-blocked', async () => {
    const noProducer = async (path: string, method = 'GET'): Promise<Result> => {
      if (path.includes('/query?')) return ok({ records: [{ ApiName: 'FldSvcAiAgents__Other' }] });
      if (path === `${ROOT}/actions/custom/flow/FldSvcAiAgents__Other`) return ok({ inputs: [{ name: 'a' }], outputs: [] });
      if (path.startsWith(`${ROOT}/actions/custom/flow/`)) return ok(agentDescriptor());
      return notFound();
    };
    const missing = await invokeAgentFlowWithProducerContext({ root: ROOT, route: ROUTE, request: noProducer, build });
    expect(missing.body.errorCode).toBe('FLOW_AGENT_PRODUCER_UNAVAILABLE');
    const noCustomer = async (path: string): Promise<Result> =>
      path === ROUTE ? ok(agentDescriptor([{ name: 'topic', type: 'STRING' }])) : notFound();
    const shapeless = await invokeAgentFlowWithProducerContext({ root: ROOT, route: ROUTE, request: noCustomer, build });
    expect(shapeless.body.errorCode).toBe('FLOW_AGENT_PRODUCER_UNAVAILABLE');
    const unmanaged = await invokeAgentFlowWithProducerContext({
      root: ROOT, route: `${ROOT}/actions/custom/flow/PlainAgent`, request: noProducer, build,
    });
    expect(unmanaged.body.errorCode).toBe('FLOW_AGENT_PRODUCER_UNAVAILABLE');
  });
  test('contact-permission gaps fail before minting anything', async () => {
    const request = async (path: string, method = 'GET'): Promise<Result> => {
      if (method === 'POST') throw new Error('must not POST');
      if (path === ROUTE) return ok(agentDescriptor());
      if (path.includes('/query?')) return ok({ records: [{ ApiName: 'FldSvcAiAgents__SendVerificationCode' }] });
      if (path === PRODUCER_ROUTE) return ok(producerDescriptor());
      if (path === `${ROOT}/sobjects/Contact/describe`) return ok({ ...contactDescribe(), createable: false });
      return notFound();
    };
    const result = await invokeAgentFlowWithProducerContext({ root: ROOT, route: ROUTE, request, build });
    expect(result.body.errorCode).toBe('FLOW_AGENT_FIXTURE_PERMISSIONS_REQUIRED');
  });
  test('unverifiable cleanup surfaces without flipping the outcome', async () => {
    const request = async (path: string, method = 'GET', body?: any): Promise<Result> => {
      if (path === ROUTE && method === 'GET') return ok(agentDescriptor());
      if (path.includes('/query?')) {
        if (path.includes('FlowDefinitionView')) return ok({ records: [{ ApiName: 'FldSvcAiAgents__SendVerificationCode' }] });
        return ok({ totalSize: 1, records: [{ Id: CONTACT_ID }] });
      }
      if (path === PRODUCER_ROUTE && method === 'GET') return ok(producerDescriptor());
      if (path === `${ROOT}/sobjects/Contact/describe`) return ok(contactDescribe());
      if (path === `${ROOT}/sobjects/Contact` && method === 'POST') return ok({ id: CONTACT_ID }, 201);
      if (method === 'DELETE') return { status: 204, ok: true, body: null };
      if (path === PRODUCER_ROUTE && method === 'POST') return ok(producerAccepted());
      if (path === ROUTE && method === 'POST') return ok(agentAccepted());
      return notFound();
    };
    let marker = '';
    const trackingBuild = async (name: string, m: string, values: Record<string, unknown>) => { marker = m; return build(name, m, values); };
    const wrapped = async (path: string, method = 'GET', body?: any): Promise<Result> => {
      (request as any).__marker = marker;
      if (path === `${ROOT}/sobjects/Contact/${CONTACT_ID}` && method === 'GET') {
        (request as any).__reads = ((request as any).__reads ?? 0) + 1;
        if ((request as any).__reads === 1) return ok({ Id: CONTACT_ID, LastName: marker, Email: 'x@example.invalid' });
        return notFound();
      }
      return request(path, method, body);
    };
    const result = await invokeAgentFlowWithProducerContext({ root: ROOT, route: ROUTE, request: wrapped, build: trackingBuild });
    expect(result.cleanupError).toContain('marker-scoped sibling');
    expect(result.contextSchema?.verified).toBe(false);
  });
});
