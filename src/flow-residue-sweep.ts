/** Sweep communication residue left by email-sending flows.
 *
 * Root cause (blind-verified): managed flows that send email with
 * saveAsActivity (e.g. ResetPassword's SendPasswordResetEmail element) log
 * Task activities and EmailMessage rows against the fixture record. Deleting
 * the fixture Contact cascades its Tasks, but EmailMessage rows survive, so
 * a passing probe would still leave residue behind. This sweep removes rows
 * addressed to our own unique fixture identities and verifies absence.
 *
 * Safety contract: only exact matches on fixture-owned values are ever
 * deleted (fixture record Ids for Task.WhoId, the exact probe email
 * addresses we generated for EmailMessage.ToAddress). No LIKE patterns, no
 * name matching, no guessing: a value we did not generate is never touched.
 * When the execution identity cannot query (e.g. a minimal profile without
 * activity access), the sweep reports `queried: false` and the caller keeps
 * its verdict; only a witnessed-but-unremoved row fails cleanup.
 */

export type SweepRequest = (
  path: string,
  method?: string,
  body?: unknown,
) => Promise<{ status: number; ok: boolean; body: unknown }>;

export type ResidueSweep = {
  queried: boolean;
  deleted: number;
  verified: boolean;
};

const ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const recordIds = (body: unknown): string[] => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const records = (body as Record<string, unknown>).records;
  if (!Array.isArray(records)) return [];
  return records
    .map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).Id
        : null,
    )
    .filter((id): id is string => typeof id === "string" && ID.test(id));
};

/** Delete communication rows owned by this probe and verify absence. */
export async function sweepFlowCommunicationResidue(
  request: SweepRequest,
  apiRoot: string,
  fixtures: { contactIds: string[]; emails: string[] },
): Promise<ResidueSweep> {
  const contactIds = [...new Set(fixtures.contactIds)].filter((id) => ID.test(id));
  const emails = [...new Set(fixtures.emails)].filter((email) => EMAIL.test(email));
  if (!contactIds.length && !emails.length)
    return { queried: true, deleted: 0, verified: true };
  const queries: string[] = [];
  if (contactIds.length)
    queries.push(
      `SELECT Id FROM Task WHERE WhoId IN (${contactIds.map((id) => `'${id}'`).join(",")})`,
    );
  for (const email of emails)
    queries.push(`SELECT Id FROM EmailMessage WHERE ToAddress = '${email}'`);
  let deleted = 0;
  for (const soql of queries) {
    const found = await request(
      `${apiRoot}/query?q=${encodeURIComponent(soql)}`,
    );
    if (!found.ok) return { queried: false, deleted, verified: false };
    for (const id of recordIds(found.body)) {
      const object = soql.includes("FROM Task ") ? "Task" : "EmailMessage";
      const removed = await request(
        `${apiRoot}/sobjects/${object}/${id}`,
        "DELETE",
      );
      if (!removed.ok && removed.status !== 404)
        return { queried: true, deleted, verified: false };
      deleted += 1;
    }
  }
  for (const soql of queries) {
    const check = await request(`${apiRoot}/query?q=${encodeURIComponent(soql)}`);
    if (!check.ok || recordIds(check.body).length > 0)
      return { queried: true, deleted, verified: false };
  }
  return { queried: true, deleted, verified: true };
}
