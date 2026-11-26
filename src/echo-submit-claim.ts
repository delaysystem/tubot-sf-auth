// Submit idempotency for broker.echo(): the proxy's 25s inline race orphan +
// alarm redelivery invoke echo() twice for slow turns (duplicate agent
// bubbles ~400ms apart), and echo() POSTs unconditionally. The claim makes
// the second invocation for a requestKey return the first invocation's
// Salesforce requestId instead of POSTing again.
//
// Protocol (D1, atomic via PRIMARY KEY + OR IGNORE):
// - INSERT OR IGNORE claim row (claimant = this invocation's UUID).
// - SELECT read-back: request_id set -> return it (duplicate suppressed).
// - claimant == me -> owned: caller POSTs, then complete() stamps request_id
//   (or release() deletes the row when the POST fails, so a later retry can
//   claim fresh).
// - claimant == other, no request_id yet -> owner still POSTing: poll for the
//   result; on timeout atomically steal (UPDATE .. WHERE request_id IS NULL
//   AND claimant = other) and POST as the new owner.
// Claim-store errors fail OPEN (proceed to POST): a D1 blip must degrade to
// possible duplicates, never to dropped agent replies.
export interface ClaimDb {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
  };
}

const CLAIM_POLL_MS = 15000;
const CLAIM_POLL_INTERVAL_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readClaim(db: ClaimDb, key: string): Promise<{ claimant: string; request_id: string | null } | null> {
  const row = await db.prepare(
    'SELECT claimant, request_id FROM echo_submit_claims WHERE request_key = ?',
  ).bind(key).first<{ claimant: unknown; request_id: unknown }>();
  if (!row || typeof row.claimant !== 'string') return null;
  return { claimant: row.claimant, request_id: typeof row.request_id === 'string' ? row.request_id : null };
}

export type EchoClaim =
  | { owned: true; claimant: string }
  | { owned: false; requestId: string }
  | { owned: true; claimant: string; failOpen: true };

export async function claimEchoSubmit(
  db: ClaimDb, key: string, opts?: { pollMs?: number; intervalMs?: number },
): Promise<EchoClaim> {
  const me = crypto.randomUUID();
  const now = Date.now();
  try {
    await db.prepare(
      'INSERT OR IGNORE INTO echo_submit_claims(request_key, claimant, request_id, created_at, updated_at) VALUES(?,?,?,?,?)',
    ).bind(key, me, null, now, now).run();
  } catch {
    return { owned: true, claimant: me, failOpen: true };
  }
  const pollMs = opts?.pollMs ?? CLAIM_POLL_MS;
  let waitMs = opts?.intervalMs ?? CLAIM_POLL_INTERVAL_MS;
  const maxWaitMs = 2000;
  const deadline = Date.now() + pollMs;
  let other: string | null = null;
  for (;;) {
    let row: { claimant: string; request_id: string | null } | null = null;
    try {
      row = await readClaim(db, key);
    } catch {
      return { owned: true, claimant: me, failOpen: true };
    }
    if (!row) return { owned: true, claimant: me, failOpen: true };
    if (row.request_id) return { owned: false, requestId: row.request_id };
    if (row.claimant === me) return { owned: true, claimant: me };
    other = row.claimant;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(waitMs, remaining));
    waitMs = Math.min(maxWaitMs, waitMs * 2);
  }
  // Owner never resolved: atomically steal only if it still holds no result.
  // A concurrent completion flips request_id first, so the steal either wins
  // cleanly or loses to a completed row we then return.
  try {
    const stolen = await db.prepare(
      'UPDATE echo_submit_claims SET claimant = ?, updated_at = ? WHERE request_key = ? AND request_id IS NULL AND claimant = ?',
    ).bind(me, Date.now(), key, other).run();
    if (stolen.meta?.changes === 1) return { owned: true, claimant: me };
    const row = await readClaim(db, key);
    if (row?.request_id) return { owned: false, requestId: row.request_id };
    if (row && row.claimant === me) return { owned: true, claimant: me };
  } catch {
    return { owned: true, claimant: me, failOpen: true };
  }
  return { owned: true, claimant: me, failOpen: true };
}

export async function completeEchoSubmit(db: ClaimDb, key: string, claimant: string, requestId: string): Promise<void> {
  try {
    await db.prepare(
      'UPDATE echo_submit_claims SET request_id = ?, updated_at = ? WHERE request_key = ? AND claimant = ?',
    ).bind(requestId, Date.now(), key, claimant).run();
  } catch { /* waiters poll-then-steal; never fail the turn on bookkeeping */ }
}

export async function releaseEchoSubmit(db: ClaimDb, key: string, claimant: string): Promise<void> {
  try {
    await db.prepare(
      'DELETE FROM echo_submit_claims WHERE request_key = ? AND claimant = ?',
    ).bind(key, claimant).run();
  } catch { /* stale NULL rows are stolen, never blocking */ }
}
