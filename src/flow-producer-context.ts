/** Verification-producer Flow shape detection and fixture identity completion.
 *
 * Root causes (blind-verified via admin CLI against live managed flows):
 * - Verification producers (e.g. SendVerificationCode) return null
 *   verification outputs for identities that match no record. Probing with
 *   a bare synthetic email string can never succeed; the probe must create
 *   a disposable owned Contact carrying that email first, then invoke.
 * - Record-input flows acting on people records (e.g. ResetPassword) fault
 *   when the disposable fixture lacks a routable identity: Contact/Lead
 *   fixtures synthesized with only a Name marker carry a null Email and the
 *   managed flow faults with UNKNOWN_EXCEPTION. Completing a createable
 *   Email field with an undeliverable probe address fixes the whole family.
 * - Event fixtures synthesized with only a Subject marker fault at insert:
 *   the org requires ActivityDateTime + DurationInMinutes
 *   (REQUIRED_FIELD_MISSING). Completing a forward slot fixes scheduling
 *   flows that validate those fields on the passed record variable.
 *
 * Zero-hardcoding contract: shapes are detected from live descriptor
 * vocabulary only. Probe identities always use the undeliverable
 * example.invalid domain, so no challenge or notification can ever reach a
 * real recipient. No org IDs, aliases, URLs, or customer values here.
 */

export const PRODUCER_REQUIRED_OUTPUTS = [
  "verificationCode",
  "authenticationKey",
  "customerId",
  "customerType",
] as const;

export const UNDELIVERABLE_DOMAIN = "example.invalid";

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

type Field = { name?: unknown; type?: unknown; maxOccurs?: unknown };

const fieldsOf = (value: unknown): Field[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is Field =>
          !!entry && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];

/** Return the producer input name when the live descriptor is a lone
 * verification-challenge producer: exactly one single STRING input and the
 * four producer outputs. Anything else returns null (never guessed). */
export function verificationProducerInput(
  inputs: unknown,
  outputs: unknown,
): string | null {
  const fields = fieldsOf(inputs);
  const out = fieldsOf(outputs);
  if (fields.length !== 1) return null;
  const [field] = fields;
  if (typeof field.name !== "string" || !FIELD_NAME.test(field.name)) return null;
  if (field.type !== "STRING") return null;
  if (typeof field.maxOccurs === "number" && field.maxOccurs > 1) return null;
  const names = new Set(
    out
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === "string"),
  );
  return PRODUCER_REQUIRED_OUTPUTS.every((name) => names.has(name))
    ? (field.name as string)
    : null;
}

export type FixtureField = {
  name?: unknown;
  type?: unknown;
  createable?: unknown;
};

/** Complete a disposable person-record fixture with a routable but
 * undeliverable identity. Returns the values unchanged unless the live
 * describe exposes a createable type-email `Email` field that the values
 * leave empty. Pure: never touches org state. */
export function personIdentityCompletion(
  fields: FixtureField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const current = values.Email;
  if (typeof current === "string" && current.length > 0) return values;
  const emailField = fields.find(
    (field) =>
      field.name === "Email" &&
      field.createable === true &&
      String(field.type).toLowerCase() === "email",
  );
  if (!emailField) return values;
  return {
    ...values,
    Email: `flow-probe-${crypto.randomUUID()}@${UNDELIVERABLE_DOMAIN}`,
  };
}

/** Complete a disposable Event fixture with a forward slot. Returns the
 * values unchanged unless the object is Event and the live describe
 * exposes createable slot fields the values leave empty. Pure: never
 * touches org state. */
export function eventSlotCompletion(
  objectName: string,
  fields: FixtureField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  if (objectName !== "Event") return values;
  const want = (name: string): boolean => {
    const field = fields.find((entry) => entry.name === name && entry.createable === true);
    if (!field) return false;
    const current = values[name];
    return current == null || current === "";
  };
  const completed = { ...values };
  if (want("DurationInMinutes")) completed.DurationInMinutes = 60;
  if (want("ActivityDateTime")) {
    completed.ActivityDateTime = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  }
  return completed;
}
