/** Capability evidence is scoped to the execution identity, never the setup administrator. */
export type CapabilityState = 'supported' | 'unsupported' | 'unknown';
export type CapabilityScope = { teamId: string; orgId: string; channelId: string; actorId: string; actionRoute: string; contractRevision: string };
export type CapabilityRequirement = {
  kind: 'permission-set' | 'object-access' | 'published-capability';
  name: string;
  source: 'live-descriptor' | 'live-metadata' | 'verified-context-recipe';
};
export type CapabilityObservation = CapabilityRequirement & {
  state: CapabilityState;
  reason: string;
  prerequisite?: { kind: 'permission-set-assignment' | 'license-assignment' | 'license-capacity' | 'feature-enablement'; name: string };
};
export type ActionCapabilityEvidence = {
  scope: CapabilityScope;
  descriptorAvailable: boolean;
  actorActive: boolean;
  /** True only when all prerequisites are published and checked, not inferred from category. */
  prerequisiteContractComplete: boolean;
  requirements: CapabilityObservation[];
  /** Native success must have been checked for this same tenant, actor and action contract. */
  nativeExecution?: { scope: CapabilityScope; independentlyVerified: boolean };
};
export function evaluateActionCapability(evidence: ActionCapabilityEvidence) {
  const scopeKeys: (keyof CapabilityScope)[] = ['teamId', 'orgId', 'channelId', 'actorId', 'actionRoute', 'contractRevision'];
  if (scopeKeys.some(key => typeof evidence.scope?.[key] !== 'string' || !evidence.scope[key].trim())) throw new Error('Capability evidence requires a complete tenant, channel, actor and action contract scope.');
  const verifiedNativeExecution = evidence.nativeExecution?.independentlyVerified === true && scopeKeys.every(key => evidence.nativeExecution!.scope[key] === evidence.scope[key]);
  const blockers = evidence.requirements.filter(item => item.state === 'unsupported');
  const unknown = evidence.requirements.filter(item => item.state === 'unknown');
  let state: CapabilityState;
  let reason: string;
  if (!evidence.actorActive) { state = 'unsupported'; reason = 'Execution identity is inactive.'; }
  else if (!evidence.descriptorAvailable) { state = 'unsupported'; reason = 'Action is unavailable in the execution identity catalog.'; }
  else if (blockers.length) { state = 'unsupported'; reason = 'A verified prerequisite is unavailable.'; }
  else if (unknown.length) { state = 'unknown'; reason = 'A published prerequisite has not been verified.'; }
  else if (verifiedNativeExecution) { state = 'supported'; reason = 'Native execution was independently verified for this identity and action contract.'; }
  else if (!evidence.prerequisiteContractComplete) { state = 'unknown'; reason = 'Catalog exposure does not publish a complete execution entitlement contract.'; }
  else { state = 'supported'; reason = 'Every published execution prerequisite is verified.'; }
  return { scope: evidence.scope, state, reason, requirements: evidence.requirements, prerequisites: evidence.requirements.flatMap(item => item.prerequisite ? [item.prerequisite] : []) };
}

export type LivePermissionSet = { id: string; name: string; licenseId?: string | null };
export type LivePermissionSetLicense = { id: string; name: string; status: string; total: number; used: number };
/** Evaluate only an explicitly required live permission set. No action-family or license-name guesses. */
export function permissionSetCapability(requirement: CapabilityRequirement, permissionSet: LivePermissionSet | undefined,
  assignedSetIds: ReadonlySet<string>, licenses: ReadonlyMap<string, LivePermissionSetLicense>, assignedLicenseIds: ReadonlySet<string>): CapabilityObservation {
  if (requirement.kind !== 'permission-set') throw new Error('Permission-set evidence requires a permission-set requirement.');
  if (!permissionSet) return { ...requirement, state: 'unsupported', reason: 'Required permission set is absent from live metadata.', prerequisite: { kind: 'feature-enablement', name: requirement.name } };
  if (permissionSet.licenseId?.startsWith('0PL')) {
    const license = licenses.get(permissionSet.licenseId);
    if (!license) return { ...requirement, state: 'unknown', reason: 'Required feature license metadata is unavailable.' };
    if (!Number.isInteger(license.total) || license.total < -1 || !Number.isInteger(license.used) || license.used < 0) return { ...requirement, state: 'unknown', reason: 'Required feature license capacity metadata is invalid.' };
    if (license.status !== 'Active') return { ...requirement, state: 'unsupported', reason: 'Required feature license is inactive.', prerequisite: { kind: 'feature-enablement', name: license.name } };
    if (!assignedLicenseIds.has(license.id)) {
      const exhausted = license.total >= 0 && license.used >= license.total;
      return { ...requirement, state: 'unsupported', reason: exhausted ? 'Required feature license has no available seat.' : 'Required feature license is not assigned to the execution identity.', prerequisite: { kind: exhausted ? 'license-capacity' : 'license-assignment', name: license.name } };
    }
  } else if (permissionSet.licenseId) {
    // User-license compatibility cannot be inferred from different license identifiers.
    return { ...requirement, state: 'unknown', reason: 'User-license compatibility for this permission set must be verified by Salesforce.' };
  }
  if (!assignedSetIds.has(permissionSet.id)) return { ...requirement, state: 'unsupported', reason: 'Required permission set is not assigned to the execution identity.', prerequisite: { kind: 'permission-set-assignment', name: permissionSet.name } };
  return { ...requirement, state: 'supported', reason: 'Required permission set and its feature license are assigned and active.' };
}
