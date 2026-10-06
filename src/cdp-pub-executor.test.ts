import { describe, expect, test } from 'bun:test';
import { buildCdpPublishArgs, classifyCdpPublishState, isCdpPublishAccepted, redactCdpPublishDiagnostic, runCdpPublishLifecycle, type CdpPubDiscovery, type CdpPubTransport, type TransportResult } from './cdp-pub-executor';

const ROOT = '/services/data/v67.0';
const ROUTE = `${ROOT}/actions/standard/cdpPublishSegment`;
const DESCRIPTOR = [{ name: 'segmentId', type: 'STRING', required: true }];
const ROW_ID = '1sgg50000001kX3AAI';
const DISCOVERY: Extract<CdpPubDiscovery, { found: true }> = {
  found: true, value: ROW_ID, rowId: ROW_ID, soql: "SELECT Id FROM MarketSegment WHERE SegmentStatus='ACTIVE' LIMIT 1",
};

const ok = (body: unknown, status = 200): TransportResult => ({ status, ok: status >= 200 && status < 300, body });
const acceptedEnvelope = () => [{ actionName: 'cdpPublishSegment', errors: null, isSuccess: true, outputValues: null }];

describe('CDP publish probe args', () => {
  test('declared live names only; gaps fail without invention', () => {
    const built = buildCdpPublishArgs(DESCRIPTOR, ROW_ID);
    if (!('args' in built)) throw new Error('expected args');
    expect(built.args).toEqual({ segmentId: ROW_ID });
    expect('failure' in buildCdpPublishArgs(DESCRIPTOR, '')).toBe(true);
    expect('failure' in buildCdpPublishArgs([{ name: 'a', required: true }, { name: 'b', required: true }], ROW_ID)).toBe(true);
    expect('failure' in buildCdpPublishArgs([{ name: 'bad name' }], ROW_ID)).toBe(true);
  });
});

describe('CDP publish outcome states', () => {
  test('strict acceptance; false successes rejected', () => {
    expect(isCdpPublishAccepted(200, acceptedEnvelope())).toBe(true);
    expect(isCdpPublishAccepted(200, [{ isSuccess: true, errors: [], outputValues: { errorMessage: 'boom' } }])).toBe(false);
    expect(isCdpPublishAccepted(200, [])).toBe(false);
    expect(classifyCdpPublishState(200, [{ isSuccess: false, errors: [{ message: 'fault' }] }])).toBe('rejected');
  });
  test('not-found and pending classified; license only on license text', () => {
    expect(classifyCdpPublishState(200, [{ isSuccess: false, errors: [{ statusCode: 'ITEM_NOT_FOUND', message: 'Calculated Insight record not found.' }] }])).toBe('not-found');
    expect(classifyCdpPublishState(202, { message: 'Activation accepted, check later' })).toBe('pending');
    expect(classifyCdpPublishState(403, { message: 'Data Cloud license is required' })).toBe('license');
    expect(classifyCdpPublishState(403, { message: 'Access denied' })).toBe('rejected');
  });
  test('diagnostics redact secrets, ids, and emails', () => {
    const text = redactCdpPublishDiagnostic(`queued for s3cr3t user@example.com ${ROW_ID}`, ['s3cr3t']);
    expect(text).not.toContain('s3cr3t');
    expect(text).not.toContain('user@example.com');
    expect(text).not.toContain(ROW_ID);
  });
});

describe('CDP publish lifecycle', () => {
  test('verified native success flips the probe', async () => {
    const seen: string[] = [];
    const request: CdpPubTransport = async (path) => { seen.push(path); return ok(acceptedEnvelope()); };
    const result = await runCdpPublishLifecycle({
      root: ROOT, route: ROUTE, actionName: 'cdpPublishSegment', descriptorInputs: DESCRIPTOR,
      discover: async () => DISCOVERY, request, verify: async () => ({ verified: true }),
    });
    expect(result.success).toBe(true);
    expect(result.operationState).toBe('verified');
    expect(seen).toEqual([ROUTE]);
    expect(result.contextSchema.verified).toBe(true);
  });

  test('success withheld when the readback never verifies', async () => {
    const request: CdpPubTransport = async () => ok(acceptedEnvelope());
    const result = await runCdpPublishLifecycle({
      root: ROOT, route: ROUTE, actionName: 'cdpPublishSegment', descriptorInputs: DESCRIPTOR,
      discover: async () => DISCOVERY, request, verify: async () => ({ verified: false }), maxVerifyPolls: 2,
    });
    expect(result.success).toBe(false);
    expect(result.operationState).toBe('pending');
    expect(result.status).toBe(202);
  });

  test('absent substrate never posts; returns setup-blocked evidence', async () => {
    let posted = false;
    const request: CdpPubTransport = async () => { posted = true; return ok(acceptedEnvelope()); };
    const result = await runCdpPublishLifecycle({
      root: ROOT, route: ROUTE, actionName: 'cdpSendToActivation', descriptorInputs: [{ name: 'activationName', required: true }],
      discover: async () => ({ found: false, evidence: ['MarketSegmentActivation totalSize 0', 'ActivationTarget totalSize 0'] }),
      request, verify: async () => ({ verified: true }),
    });
    expect(posted).toBe(false);
    expect(result.success).toBe(false);
    expect(result.operationState).toBe('substrate-absent');
    expect((result.body as Record<string, unknown>).errorCode).toBe('CDP_PUB_SUBSTRATE_ABSENT');
  });

  test('descriptor gaps and bad routes fail without posting', async () => {
    let posted = false;
    const request: CdpPubTransport = async () => { posted = true; return ok(acceptedEnvelope()); };
    const gap = await runCdpPublishLifecycle({
      root: ROOT, route: ROUTE, actionName: 'cdpPublishSegment', descriptorInputs: [],
      discover: async () => DISCOVERY, request, verify: async () => ({ verified: true }),
    });
    expect(gap.success).toBe(false);
    const badRoute = await runCdpPublishLifecycle({
      root: ROOT, route: 'https://evil.example/hook', actionName: 'cdpPublishSegment', descriptorInputs: DESCRIPTOR,
      discover: async () => DISCOVERY, request, verify: async () => ({ verified: true }),
    });
    expect(badRoute.success).toBe(false);
    expect(posted).toBe(false);
  });

  test('ITEM_NOT_FOUND and license outcomes map to blocked states', async () => {
    const notFound: CdpPubTransport = async () => ok([{ isSuccess: false, errors: [{ statusCode: 'ITEM_NOT_FOUND', message: 'Calculated Insight record not found.' }] }]);
    const missing = await runCdpPublishLifecycle({
      root: ROOT, route: `${ROOT}/actions/standard/cdpPublishCalculatedInsight`, actionName: 'cdpPublishCalculatedInsight',
      descriptorInputs: [{ name: 'calculatedInsightApiName', required: true }],
      discover: async () => ({ found: true, value: 'tubot__Gone__cio', rowId: ROW_ID, soql: 'SELECT Id, Name FROM MktCalculatedInsight LIMIT 1' }),
      request: notFound, verify: async () => ({ verified: true }),
    });
    expect(missing.operationState).toBe('not-found');
    const licensed: CdpPubTransport = async () => ({ status: 403, ok: false, body: { message: 'Feature license is required' } });
    const blocked = await runCdpPublishLifecycle({
      root: ROOT, route: ROUTE, actionName: 'cdpPublishSegment', descriptorInputs: DESCRIPTOR,
      discover: async () => DISCOVERY, request: licensed, verify: async () => ({ verified: true }),
    });
    expect(blocked.operationState).toBe('license');
    expect(blocked.success).toBe(false);
  });

  test('unverified cleanup withholds success', async () => {
    const request: CdpPubTransport = async () => ok(acceptedEnvelope());
    const result = await runCdpPublishLifecycle({
      root: ROOT, route: ROUTE, actionName: 'cdpPublishSegment', descriptorInputs: DESCRIPTOR,
      discover: async () => DISCOVERY, request, verify: async () => ({ verified: true }),
      cleanup: async () => ({ cleaned: false, error: 'stray remains' }),
    });
    expect(result.success).toBe(false);
    expect(result.cleanupError).toBe('stray remains');
  });
});
