import { sameSalesforceId } from './salesforce-id';

type Result = { status: number; ok: boolean; body: any };
type Value = Record<string, any>;

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

export type ReclaimOutcome = { reclaimed: boolean; ownerBefore: string | null; ownerAfter: string | null };

/**
 * Cleanup-time owner reclaim to a caller-supplied identity (fixture
 * CreatedById or integration id, never invented); proves PATCH stuck on
 * re-read. Best-effort: failure returns reclaimed:false.
 */
export async function reclaimFixtureOwnerForDelete(input: {
  root: string;
  objectName: string;
  id: string;
  ownerId: string;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  currentOwnerId?: string | null;
}): Promise<ReclaimOutcome> {
  const { root, request } = input;
  if (!OBJECT_NAME.test(input.objectName) || !SF_ID.test(input.id) || !SF_ID.test(input.ownerId)) {
    return { reclaimed: false, ownerBefore: null, ownerAfter: null };
  }
  let ownerBefore: string | null = typeof input.currentOwnerId === 'string' ? input.currentOwnerId : null;
  if (ownerBefore === null) {
    try {
      const read = await request(`${root}/sobjects/${input.objectName}/${input.id}`);
      const cand = read.ok && read.body !== null && typeof read.body === 'object' ? (read.body as Value).OwnerId : null;
      ownerBefore = typeof cand === 'string' ? cand : null;
    } catch {
      return { reclaimed: false, ownerBefore: null, ownerAfter: null };
    }
  }
  if (typeof ownerBefore !== 'string' || !SF_ID.test(ownerBefore)) {
    return { reclaimed: false, ownerBefore, ownerAfter: ownerBefore };
  }
  if (sameSalesforceId(ownerBefore, input.ownerId)) return { reclaimed: true, ownerBefore, ownerAfter: ownerBefore };
  try {
    let patched = await request(`${root}/sobjects/${input.objectName}/${input.id}`, 'PATCH', { OwnerId: input.ownerId });
    if (!patched.ok && /^00G[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?$/.test(ownerBefore)) {
      // Queue-drifted fixture (org automation reassigned past the create):
      // queue members can take ownership, so join the queue, then reclaim.
      // Attempt-driven best-effort: a membership denial falls through to
      // reclaimed:false exactly as before. The membership itself is benign
      // (idempotent, scoped to the execution identity) and stays for the
      // next probe instead of churning join/leave calls.
      try {
        await request(`${root}/sobjects/GroupMember`, 'POST', { GroupId: ownerBefore, UserOrGroupId: input.ownerId });
      } catch {
        // Denied or duplicate: the PATCH retry below proves the outcome.
      }
      patched = await request(`${root}/sobjects/${input.objectName}/${input.id}`, 'PATCH', { OwnerId: input.ownerId });
    }
    if (!patched.ok) return { reclaimed: false, ownerBefore, ownerAfter: ownerBefore };
    const reread = await request(`${root}/sobjects/${input.objectName}/${input.id}`);
    const after = reread.ok && reread.body !== null && typeof reread.body === 'object' ? (reread.body as Value).OwnerId : null;
    const ownerAfter = typeof after === 'string' ? after : ownerBefore;
    return {
      reclaimed: typeof ownerAfter === 'string' && SF_ID.test(ownerAfter) && sameSalesforceId(ownerAfter, input.ownerId),
      ownerBefore,
      ownerAfter,
    };
  } catch {
    return { reclaimed: false, ownerBefore, ownerAfter: ownerBefore };
  }
}
