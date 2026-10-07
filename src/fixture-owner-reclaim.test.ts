import { describe, expect, test } from 'bun:test';
import { reclaimFixtureOwnerForDelete } from './fixture-owner-reclaim';

type Call = { path: string; method?: string; body?: unknown };

const ROOT = '/services/data/v67.0';
const SELF = '005000000000001AAA';
const QUEUE = '00G000000000001AAA';
const RECORD = '500000000000001AAA';

function harness(impl: (call: Call) => { status: number; ok: boolean; body: any }) {
  const calls: Call[] = [];
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const call = { path, method, body };
    calls.push(call);
    return impl(call);
  };
  return { calls, request };
}

describe('fixture owner reclaim with queue drift', () => {
  test('joins the owning queue then reclaims when the direct PATCH is refused', async () => {
    let patches = 0;
    const { calls, request } = harness((call) => {
      if (call.method === 'GET') return { status: 200, ok: true, body: { OwnerId: patches > 0 ? SELF : QUEUE } };
      if (call.path.endsWith('/sobjects/GroupMember')) return { status: 201, ok: true, body: { id: '0Lt000000000001AAA' } };
      if (call.method === 'PATCH') {
        patches += 1;
        return patches === 1
          ? { status: 400, ok: false, body: [{ errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY' }] }
          : { status: 204, ok: true, body: null };
      }
      throw new Error(`unscripted ${call.method} ${call.path}`);
    });
    const outcome = await reclaimFixtureOwnerForDelete({ root: ROOT, objectName: 'Case', id: RECORD, ownerId: SELF, request });
    expect(outcome.reclaimed).toBe(true);
    expect(outcome.ownerBefore).toBe(QUEUE);
    expect(calls.some((c) => c.path.endsWith('/sobjects/GroupMember') && (c.body as Record<string, string>).GroupId === QUEUE)).toBe(true);
  });

  test('leaves non-queue PATCH refusals untouched (no membership call)', async () => {
    const other = '005000000000002AAA';
    const { calls, request } = harness((call) => {
      if (call.method === 'GET') return { status: 200, ok: true, body: { OwnerId: other } };
      if (call.method === 'PATCH') return { status: 400, ok: false, body: [{ errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY' }] };
      throw new Error(`unscripted ${call.method} ${call.path}`);
    });
    const outcome = await reclaimFixtureOwnerForDelete({ root: ROOT, objectName: 'Case', id: RECORD, ownerId: SELF, request });
    expect(outcome.reclaimed).toBe(false);
    expect(calls.some((c) => c.path.endsWith('/sobjects/GroupMember'))).toBe(false);
  });
});
