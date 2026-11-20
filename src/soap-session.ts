// SOAP session injection (split from the worker entry: entry-module exports
// must be handlers/classes only — a string export breaks workerd startup).
export const SOAP_SESSION_PLACEHOLDER = "{{TUBOT_SF_SESSION}}";

// SOAP endpoints ignore the Bearer [REDACTED] and require the token inside the
// XML SessionHeader. Callers send a placeholder there instead of any
// credential; it is substituted server-side only (never logged, never
// returned), so session material never crosses the service boundary.
export function injectSoapSession(path: unknown, requestBody: unknown, accessToken: string): unknown {
  if (typeof requestBody !== "string" || typeof path !== "string" || !path.startsWith("/services/Soap/")) {
    return requestBody;
  }
  if (!requestBody.includes(SOAP_SESSION_PLACEHOLDER)) return requestBody;
  return requestBody.split(SOAP_SESSION_PLACEHOLDER).join(accessToken);
}
