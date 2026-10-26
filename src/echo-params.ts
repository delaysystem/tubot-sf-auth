import type {TenantScope} from '../../tubot-sf-proxy/src/contracts';

const GUEST_RE = /^0PA[A-Za-z0-9]{12,15}$/;
export const validGuestId = (v: unknown): v is string => typeof v === 'string' && GUEST_RE.test(v);

export interface EchoParam {name: string; textValue: string}

/**
 * Invocable parameters for the echo notification. Channel and org come from the
 * authoritative RPC scope and the guest from the server-resolved session
 * recipient — either re-queried in echo() or relayed by the proxy from the
 * verify result (format-validated, with a session-query fallback). Other
 * proxy-supplied turn fields must only match scope when present (see
 * turnScopeMatches).
 */
export function echoParameters(scope: TenantScope, recipient: string, text: string): EchoParam[] {
  return [
    {name: 'text', textValue: text},
    {name: 'channelId', textValue: scope.channelId},
    {name: 'orgId', textValue: scope.orgId},
    {name: 'guestId', textValue: recipient},
  ];
}

const DEF_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const NS_RE = /^[A-Za-z0-9]+$/;

/**
 * Qualify a message definition name to the resolved flow's namespace
 * context: packaged flows reject unpackaged twins with INVALID_INPUT and
 * vice versa. Unparseable names pass through untouched (fail loud at
 * submit, never silently rewritten).
 */
export function qualifyDefinitionName(definitionName: string, flowNs: string | null): string {
  if (typeof definitionName !== 'string' || !DEF_RE.test(definitionName)) return definitionName;
  const sep = definitionName.indexOf('__');
  const base = sep > 0 ? definitionName.slice(sep + 2) : definitionName;
  if (!base || !DEF_RE.test(base)) return definitionName;
  if (flowNs) {
    if (!NS_RE.test(flowNs)) return definitionName;
    return `${flowNs}__${base}`;
  }
  return base;
}

/** Flip to the other namespace twin once, or null when there is no twin. */
export function flipDefinitionTwin(definitionName: string): string | null {
  if (typeof definitionName !== 'string' || !DEF_RE.test(definitionName)) return null;
  const sep = definitionName.indexOf('__');
  if (sep > 0) {
    const base = definitionName.slice(sep + 2);
    return base && DEF_RE.test(base) ? base : null;
  }
  return null;
}

/** True only for the precise definition-name INVALID_INPUT rejection. */
export function isDefinitionInvalidInput(result: unknown): boolean {
  const first = Array.isArray(result) ? result[0] : null;
  const errors = (first && typeof first === 'object' ? (first as {errors?: unknown}).errors : null);
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => e && typeof e === 'object' &&
    (e as {statusCode?: unknown}).statusCode === 'INVALID_INPUT' &&
    typeof (e as {message?: unknown}).message === 'string' &&
    ((e as {message: string}).message.includes('messageDefinitionName')));
}
