/**
 * @description Shared input plumbing for Simple Setup: LWC map
 * normalization, failed-result building, and integration-user selection.
 * Split from the step runner so each class stays under the complexity
 * budget.
 */
public with sharing class SimpleSetupInput {
    // Aura materializes nested LWC params with a runtime map type that is NOT
    // Map<String, Object>, so instanceof checks and direct casts fail on real
    // browser input even though JSON round-trips through tests work. Normalize
    // any map-like value through JSON; anything else yields null.
    public static Map<String, Object> asMap(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Map<String, Object>) {
            return (Map<String, Object>) value;
        }
        try {
            Object normalized = JSON.deserializeUntyped(JSON.serialize(value));
            return normalized instanceof Map<String, Object>
                ? (Map<String, Object>) normalized
                : null;
        } catch (Exception e) {
            return null;
        }
    }

    public static Map<String, Object> failed(String message) {
        return new Map<String, Object>{ 'status' => 'failed', 'message' => message };
    }

    public static String stringValue(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    public static Map<String, Object> requireUser(Map<String, Object> input) {
        return asMap(input.get('user'));
    }

    // Deterministic auto-select mirroring the wizard heuristic: prefer a
    // name/username match on 'integration', else the first Standard user.
    public static Map<String, Object> selectIntegrationUser() {
        List<Map<String, Object>> candidates =
            TubotSetupWizardController.getIntegrationCandidates();
        if (candidates.isEmpty()) {
            throw new AuraHandledException('No eligible active users found in this org.');
        }
        for (Map<String, Object> candidate : candidates) {
            String haystack = (
                stringValue(candidate.get('name')) + ' '
                + stringValue(candidate.get('username')) + ' '
                + stringValue(candidate.get('email'))
            ).toLowerCase();
            if (haystack.contains('integration') && !haystack.contains('platform')) {
                return candidate;
            }
        }
        return candidates[0];
    }

    // Resolve the UI-selected user against the live candidate allowlist so a
    // stale selection (deactivated/deleted user) fails closed with guidance
    // instead of silently running as someone else. Blank selection falls back
    // to the deterministic auto-select.
    public static Map<String, Object> resolveSelectedUser(Map<String, Object> input) {
        Map<String, Object> seed = asMap(input.get('user'));
        String requestedId = seed == null ? null : stringValue(seed.get('id'));
        if (String.isBlank(requestedId)) {
            return selectIntegrationUser();
        }
        for (Map<String, Object> candidate : TubotSetupWizardController.getIntegrationCandidates()) {
            if (requestedId == String.valueOf(candidate.get('id'))) {
                return candidate;
            }
        }
        return null;
    }
}
