import { describe, expect, test } from 'bun:test';
import { FIXTURE_PERMSET_NAME, selfProvisionFixtureGrants } from './fixture-self-provision';

type Call = { path: string; method?: string; body?: unknown };
type Scripted = { status: number; ok: boolean; body: any };

const USER = '005000000000001AAA';
const ROOT = '/services/data/v67.0';

function harness(script: Record<string, Scripted>) {
  const calls: Call[] = [];
  const request = async (path: string, method = 'GET', body?: unknown) => {
    calls.push({ path, method, body });
    const key = `${method} ${path.split('?')[0]}`;
    const hit = script[key] ?? script[path];
    if (!hit) throw new Error(`unscripted call: ${method} ${path}`);
    return hit;
  };
  return { calls, request };
}

const queryRows = (rows: unknown[]): Scripted => ({ status: 200, ok: true, body: { records: rows } });

describe('fixture permission-set self-provisioning', () => {
  test('creates the set, merges CRUD, and assigns the execution user', async () => {
    const { calls, request } = harness({
      [`GET ${ROOT}/tooling/query`]: queryRows([]),
      [`POST ${ROOT}/tooling/sobjects/PermissionSet`]: { status: 201, ok: true, body: { id: '0PS000000000001AAA', success: true } },
    });
    // Route per-call: the harness keys on method+path; queries share one key,
    // so answer sequentially via a stateful override for the ObjectPermissions leg.
    let phase = 0;
    const routed = async (path: string, method = 'GET', body?: unknown) => {
      if (method === 'GET' && path.includes('ObjectPermissions')) {
        phase += 1;
        return queryRows([]);
      }
      if (method === 'POST' && path.endsWith('/sobjects/ObjectPermissions')) {
        return { status: 201, ok: true, body: { id: '000000000000001AAA', success: true } };
      }
      if (method === 'GET' && path.includes('PermissionSetAssignment')) return queryRows([]);
      if (method === 'POST' && path.endsWith('/sobjects/PermissionSetAssignment')) {
        return { status: 201, ok: true, body: { id: '0Pa000000000001AAA', success: true } };
      }
      return request(path, method, body);
    };
    const outcome = await selfProvisionFixtureGrants({ root: ROOT, userId: USER, objects: ['Case'], request: routed });
    expect(outcome.granted).toEqual(['Case']);
    expect(outcome.assigned).toBe(true);
    expect(outcome.capabilityDenied).toBe(false);
    expect(phase).toBe(1);
    const created = calls.find((c) => c.method === 'POST' && c.path.endsWith('/sobjects/PermissionSet'));
    expect((created?.body as Record<string, string>).Name).toBe(FIXTURE_PERMSET_NAME);
  });

  test('skips writes when the grant and assignment already hold', async () => {
    const full = { Id: '000000000000001AAA', PermissionsCreate: true, PermissionsRead: true, PermissionsEdit: true, PermissionsDelete: true };
    const writes: Call[] = [];
    const request = async (path: string, method = 'GET', body?: unknown) => {
      if (method !== 'GET') writes.push({ path, method, body });
      const decoded = decodeURIComponent(path);
      if (decoded.includes('FROM PermissionSet ')) return queryRows([{ Id: '0PS000000000001AAA' }]);
      if (decoded.includes('FROM ObjectPermissions')) return queryRows([full]);
      if (decoded.includes('FROM PermissionSetAssignment')) return queryRows([{ Id: '0Pa000000000001AAA' }]);
      throw new Error(`unscripted call: ${method} ${path}`);
    };
    const outcome = await selfProvisionFixtureGrants({ root: ROOT, userId: USER, objects: ['Case', 'Case'], request });
    expect(outcome.granted).toEqual(['Case']);
    expect(outcome.assigned).toBe(true);
    expect(writes).toEqual([]);
  });

  test('denials surface capabilityDenied without throwing', async () => {
    const request = async () => ({ status: 403, ok: false, body: [{ errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY' }] });
    const outcome = await selfProvisionFixtureGrants({ root: ROOT, userId: USER, objects: ['Case'], request });
    expect(outcome.capabilityDenied).toBe(true);
    expect(outcome.granted).toEqual([]);
    expect(outcome.assigned).toBe(false);
  });

  test('invalid user or objects refuse closed with no calls', async () => {
    const calls: Call[] = [];
    const request = async (path: string, method = 'GET', body?: unknown) => {
      calls.push({ path, method, body });
      throw new Error('must not call');
    };
    expect((await selfProvisionFixtureGrants({ root: ROOT, userId: 'nope', objects: ['Case'], request })).capabilityDenied).toBe(true);
    expect((await selfProvisionFixtureGrants({ root: ROOT, userId: USER, objects: ['Case;DROP'], request })).capabilityDenied).toBe(true);
    expect(calls).toEqual([]);
  });
});
