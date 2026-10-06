/** REST responses normally contain one JSON document. Salesforce occasionally
 * appends extra JSON documents after a complete action envelope (e.g. a
 * trailing `[{"message":"Type cannot be serialized",...}]` after a finished
 * Apex envelope). Policy: the first complete envelope is the outcome; trailing
 * documents are preserved separately as diagnostics and never upgrade a
 * rejection. A trailing error never salvages a failed envelope, and output
 * values no caller verified stay unverified. */
export const MAX_SALESFORCE_JSON_CHARACTERS = 8 * 1024 * 1024;
/** End offset (exclusive) of the first balanced JSON value starting at `start`, or -1. */
function leadingValueEnd(raw: string, start: number): number {
  let i = start;
  while (i < raw.length && /\s/.test(raw[i]!)) i++;
  if (i >= raw.length) return -1;
  const open = raw[i]!;
  if (open !== "{" && open !== "[") {
    try {
      JSON.parse(raw.slice(start));
      return raw.length;
    } catch { return -1; }
  }
  const close = open === "{" ? "}" : "]";
  let depth = 0, inString = false, escaped = false;
  for (let j = i; j < raw.length; j++) {
    const ch = raw[j]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}
/** Trailing JSON documents after the first complete value. [] unless every
 * segment (leading and trailing) parses as JSON. */
export function extractTrailingResponseDocuments(raw: string): unknown[] {
  const end = leadingValueEnd(raw, 0);
  if (end < 0) return [];
  const rest = raw.slice(end).trim();
  if (!rest) return [];
  let leading: unknown;
  try { leading = JSON.parse(raw.slice(0, end)); } catch { return []; }
  void leading;
  const documents: unknown[] = [];
  let offset = end;
  while (true) {
    while (offset < raw.length && /\s/.test(raw[offset]!)) offset++;
    if (offset >= raw.length) break;
    const nextEnd = leadingValueEnd(raw, offset);
    if (nextEnd < 0) return [];
    try { documents.push(JSON.parse(raw.slice(offset, nextEnd))); } catch { return []; }
    offset = nextEnd;
  }
  return documents.length ? documents : [];
}
export function parseSalesforceResponseJson(raw: string, maxCharacters = MAX_SALESFORCE_JSON_CHARACTERS): unknown {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || raw.length > maxCharacters)
    return { errorCode: 'SALESFORCE_RESPONSE_TOO_LARGE',
      message: 'The Salesforce response exceeded the safe JSON parsing limit; execution success could not be verified.' };
  if (raw.length === 0) return null;
  try { return JSON.parse(raw); }
  catch {
    const end = leadingValueEnd(raw, 0);
    if (end > 0) {
      try {
        const leading = JSON.parse(raw.slice(0, end));
        if (extractTrailingResponseDocuments(raw).length) return leading;
      } catch { /* fall through to malformed */ }
    }
    return { errorCode: 'SALESFORCE_NON_JSON_RESPONSE',
      message: 'Salesforce returned a response that is not valid JSON; execution success could not be verified.' };
  }
}
