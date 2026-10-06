/** Shared authorization and Panel error handling for Salesforce channel operations. */
public with sharing class PanelSalesforceChannelSupportService {
    public static final String PERMISSION_SET = 'Tubot_Salesforce_API_Read';
    @TestVisible private static Boolean allowSyntheticMessagingChannelInTest = false;

    public class ChannelServiceException extends Exception {}

    public static Exception newException(String message) {
        if (Test.isRunningTest()) { return handledException(message); }
        try {
            System.Quiddity context = Request.getCurrent().getQuiddity();
            if (context == System.Quiddity.AURA || context == System.Quiddity.VF) { return handledException(message); }
        } catch (Exception ignored) {
            // The caller receives the service exception when no UI request context exists.
        }
        return new ChannelServiceException(message);
    }

    private static AuraHandledException handledException(String message) {
        AuraHandledException error = new AuraHandledException(message);
        error.setMessage(message);
        return error;
    }

    /**
     * Resolve the API permission set matching this code's own namespace.
     * Dev orgs can hold both the packaged and unpackaged copies, so a bare
     * LIMIT 1 lookup may return the wrong one; pick by namespace instead.
     */
    public static Id resolveApiPermissionSetId() {
        String supportName = PanelSalesforceChannelSupportService.class.getName();
        String wantNs = supportName.contains('.') ? supportName.substringBefore('.') : null;
        List<PermissionSet> all = [
            SELECT Id, NamespacePrefix FROM PermissionSet
            WHERE Name = :PERMISSION_SET
            WITH USER_MODE
        ];
        for (PermissionSet ps : all) {
            if (ps.NamespacePrefix == wantNs) {
                return ps.Id;
            }
        }
        return all.isEmpty() ? null : all[0].Id;
    }

    public static Id resolveUserId(String identifier) {
        if (String.isBlank(identifier)) { return null; }
        try { return (Id) identifier; } catch (Exception invalidId) {
            List<User> matches = [SELECT Id FROM User WHERE Username = :identifier WITH USER_MODE LIMIT 1];
            return matches.isEmpty() ? null : matches[0].Id;
        }
    }

    public static Boolean messagingChannelExists(Id channelId) {
        if (Test.isRunningTest() && allowSyntheticMessagingChannelInTest) { return true; }
        return [SELECT COUNT() FROM MessagingChannel WHERE Id = :channelId WITH USER_MODE] != 0;
    }

    public static void requireAdmin() {
        Map<String, Object> status = PanelAuthController.getPanelAuthStatus();
        if (!PanelAuthSupportService.checkManageTubotPermission() ||
            !(Boolean) status.get('isConnected') || !(Boolean) status.get('canEditSettings')) {
            throw newException('A connected Panel admin with Tubot API connection permission is required.');
        }
    }

    public static void requireSettingsAdmin() {
        PanelAuthSupportService.requireSettingsAdmin();
    }

    public static String panelFailure(HttpResponse response, String operation) {
        String code = 'panel_request_failed';
        String requestId;
        try {
            Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
            if (body.get('error') instanceof String) { code = (String) body.get('error'); }
            if (body.get('requestId') instanceof String) {
                String candidate = (String) body.get('requestId');
                if (Pattern.matches('(?i)[a-f0-9-]{36}', candidate)) { requestId = candidate; }
            }
        } catch (Exception ignored) {
            // Do not include untrusted upstream bodies in Salesforce UI messages.
        }
        String guidance = guidanceFor(code);
        return operation + ' (HTTP ' + response.getStatusCode() + ', ' + code + '): ' + guidance +
            (String.isNotBlank(requestId) ? ' Request ID: ' + requestId + '.' : '');
    }

    private static String guidanceFor(String code) {
        Map<String, String> guidance = new Map<String, String>{
            'unauthorized' => 'Reconnect the Salesforce package to Panel, then retry.',
            'forbidden' => 'Use a Panel account with edit-salesforce-settings permission.',
            'salesforce_invalid_client_credentials' => 'Check the ECA consumer key and secret, then retry.',
            'salesforce_oauth_not_configured' => 'Enable ECA client credentials flow and set Run As to the selected integration user.',
            'salesforce_oauth_rejected' => 'Check ECA OAuth policies and credentials, then retry.',
            'salesforce_oauth_unavailable' => 'Salesforce OAuth is temporarily unavailable; retry in a moment.',
            'salesforce_identity_failed' => 'Check that the ECA includes the id scope and the integration user has API access.',
            'salesforce_identity_mismatch' => 'The ECA Run As user or Salesforce org does not match this connection.',
            'salesforce_identity_unavailable' => 'Salesforce identity lookup is temporarily unavailable; retry in a moment.',
            'salesforce_identity_invalid_response' => 'Salesforce returned an invalid identity response; retry and share the request ID if it repeats.',
            'salesforce_auth_failed' => 'Salesforce authentication failed. Reconnect with valid ECA credentials.',
            'credential_encryption_key_missing' => 'The auth service encryption key is missing. Contact the service administrator.',
            'credential_encryption_key_invalid' => 'The auth service encryption key is invalid. Contact the service administrator.',
            'credential_key_missing' => 'The auth service encryption key is missing. Contact the service administrator.',
            'credential_key_invalid' => 'The auth service encryption key is invalid. Contact the service administrator.',
            'auth_service_unavailable' => 'The auth service is temporarily unavailable; retry in a moment.',
            'internal_error' => 'The auth service could not complete setup. Retry; contact support if it repeats.'
        };
        return guidance.containsKey(code) ? guidance.get(code) : 'Check Panel login and Salesforce ECA setup, then retry.';
    }
}
