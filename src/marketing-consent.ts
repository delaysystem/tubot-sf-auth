/**
 * Marketing Cloud Connect consent-substrate preconditions for et4ae5 flows.
 * Read-only: resolves opt-out fields and reusable opt-in rows so owned
 * probes never fabricate consent.
 */

type Result = { status: number; ok: boolean; body: any };
type Field = Record<string, any>;

export const CONSENT_OPT_OUT_FIELDS = [
  "et4ae5__HasOptedOutOfEmail__c",
  "HasOptedOutOfEmail",
  "et4ae5__HasOptedOutOfMobile__c",
  "HasOptedOutOfMobile",
] as const;

export const CONSENT_ADDRESS_FIELDS: Record<string, string[]> = {
  Contact: ["Email", "et4ae5__MobilePhone__c"],
  Lead: ["Email", "et4ae5__MobilePhone__c"],
};

export type ConsentSubstrate = {
  ok: true;
  objectName: "Contact" | "Lead";
  rowId: string;
  optOutField: string;
  optOutSettable: boolean;
  channel: "email" | "mobile" | "unknown";
  address: string | null;
};

export type ConsentRefusal = {
  ok: false;
  code:
    | "CONSENT_CONTACT_SUBSTRATE_UNAVAILABLE"
    | "CONSENT_LEAD_SUBSTRATE_UNAVAILABLE"
    | "CONSENT_OPT_OUT_UNSETTABLE"
    | "CONSENT_OPT_OUT_BLOCKED";
  message: string;
};

/**
 * Resolve the et4ae5 consent substrate: one opted-in Contact (else Lead)
 * with a settable opt-out bit. Never fabricates consent; refusal carries
 * the setup requirement.
 */
export async function resolveConsentSubstrate(input: {
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  root: string;
  objectName?: string;
  channel?: string;
}): Promise<ConsentSubstrate | ConsentRefusal> {
  const objects: Array<"Contact" | "Lead"> = input.objectName === "Contact" || input.objectName === "Lead"
    ? [input.objectName]
    : ["Contact", "Lead"];
  for (const objectName of objects) {
    const described = await input.request(`${input.root}/sobjects/${objectName}/describe`);
    if (!described.ok || !described.body || typeof described.body !== "object") continue;
    const fields = Array.isArray((described.body as { fields?: unknown }).fields)
      ? ((described.body as { fields: Field[] }).fields)
      : [];
    const byName = (name: string): Field | undefined => fields.find((field) => field?.name === name);
    const optOutField = CONSENT_OPT_OUT_FIELDS.map((name) => byName(name))
      .find((field) => field && field.createable === true);
    if (!optOutField) continue;
    if (optOutField.updateable !== true) {
      return {
        ok: false,
        code: "CONSENT_OPT_OUT_UNSETTABLE",
        message: `${objectName}.${optOutField.name} is not settable by the execution identity; grant field update access, then retry.`,
      };
    }
    const addresses = CONSENT_ADDRESS_FIELDS[objectName] ?? [];
    const where = [`${optOutField.name} = false`];
    const addr = addresses.find((name) => { const f = byName(name); return f && f.createable === true; });
    if (addr) where.push(`${addr} != null`);
    const lookup = await input.request(
      `${input.root}/query?q=${encodeURIComponent(`SELECT Id${addr ? `, ${addr}` : ""} FROM ${objectName} WHERE ${where.join(" AND ")} LIMIT 1`)}`);
    const rows = lookup.ok && lookup.body && typeof lookup.body === "object" && Array.isArray((lookup.body as { records?: unknown }).records)
      ? (lookup.body as { records: Array<Record<string, unknown>> }).records
      : [];
    const row = rows.find((candidate) => typeof candidate?.Id === "string");
    if (!row) continue;
    const address = addr && typeof row[addr] === "string" ? (row[addr] as string) : null;
    const channel: ConsentSubstrate["channel"] = addr && /mobile|phone/i.test(addr)
      ? "mobile"
      : addr && /email/i.test(addr)
        ? "email"
        : "unknown";
    return {
      ok: true,
      objectName,
      rowId: row.Id as string,
      optOutField: optOutField.name as string,
      optOutSettable: true,
      channel,
      address,
    };
  }
  return {
    ok: false,
    code: "CONSENT_CONTACT_SUBSTRATE_UNAVAILABLE",
    message: "The org exposes no opted-in Contact or Lead the execution identity can reuse; create consent substrate, then retry.",
  };
}

/**
 * Refuse honest when consent cannot be proven: the owned probe never sends
 * to an unproven address.
 */
export function consentRefusal(failure: ConsentRefusal): { status: number; body: { errorCode: string; message: string } } {
  return { status: 422, body: { errorCode: failure.code, message: failure.message } };
}
