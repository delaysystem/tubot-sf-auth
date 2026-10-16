import type {TenantScope} from '../../tubot-sf-proxy/src/contracts';

const GUEST_RE = /^0PA[A-Za-z0-9]{12,15}$/;
export const validGuestId = (v: unknown): v is string => typeof v === 'string' && GUEST_RE.test(v);

export interface EchoParam {name: string; textValue: string}

/**
 * Invocable parameters for the echo notification. Channel and org come from the
 * authoritative RPC scope and the guest from the server-resolved session
 * recipient — never from proxy-supplied turn fields, which must only match
 * scope when present (see turnScopeMatches).
 */
export function echoParameters(scope: TenantScope, recipient: string, text: string): EchoParam[] {
  return [
    {name: 'text', textValue: text},
    {name: 'channelId', textValue: scope.channelId},
    {name: 'orgId', textValue: scope.orgId},
    {name: 'guestId', textValue: recipient},
  ];
}
