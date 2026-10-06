/**
 * @description Controller for Panel OAuth 2.0 Authentication and Multi-Tenant
 * Agentforce "Agent Select" Custom Settings grounding.
 */
public with sharing class PanelAuthController {

    /**
     * @description Checks current Panel OAuth connection and permission state.
     */
    @AuraEnabled
    public static Map<String, Object> getPanelAuthStatus() {
        requireSettingsAdmin();
        MCP_Config__c config = PanelAuthSupportService.getConfig();
        Boolean hasAccessToken = String.isNotBlank(config?.Panel_Team_Id__c);
        String userRole = config?.Panel_User_Role__c;
        String permissions = config?.Panel_Permissions__c;
        Boolean hasVerifiedProfile = String.isNotBlank(config?.Panel_User_Email__c) &&
            String.isNotBlank(userRole) && String.isNotBlank(config?.Panel_Team_Name__c);
        // The bearer lives only in Salesforce External Credentials, never in a custom setting.
        return new Map<String, Object>{
            'isConnected' => hasAccessToken && hasVerifiedProfile,
            'panelBaseUrl' => PanelAuthSupportService.DEFAULT_PANEL_URL,
            'clientId' => String.isNotBlank(config?.Panel_Client_Id__c) ? config.Panel_Client_Id__c : PanelAuthSupportService.DEFAULT_CLIENT_ID,
            'userEmail' => config?.Panel_User_Email__c,
            'userRole' => userRole,
            'teamId' => config?.Panel_Team_Id__c,
            'teamName' => config?.Panel_Team_Name__c,
            'permissions' => permissions,
            'canEditSettings' => checkUserCanEditSettings(userRole, permissions),
            'hasAccessToken' => hasAccessToken,
            'usesExternalCredentials' => hasPanelNamedCredential(),
            'externalCredentialName' => PanelAuthSupportService.getExternalCredentialName(),
            'namedCredentialName' => PanelAuthSupportService.getNamedCredentialName()
        };
    }

    /**
     * @description True only when a Panel Named Credential definition is
     * resolvable in this org. ExternalCredential/UserExternalCredential are
     * not valid Apex types, so the Named Credential (the callout entry
     * point) is the only credential state Apex can verify live. Fail-closed:
     * never claim configured without evidence.
     */
    @TestVisible
    private static Boolean hasPanelNamedCredential() {
        try {
            return [SELECT COUNT() FROM NamedCredential
                    WHERE DeveloperName = 'Panel_Named_Credential'
                    WITH USER_MODE] > 0;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * @description Helper to evaluate if the user's role/permissions grant custom settings editing.
     */
    @TestVisible
    private static Boolean checkUserCanEditSettings(String userRole, String permissions) {
        if (String.isNotBlank(userRole)) {
            String roleLower = userRole.toLowerCase().trim();
            if (roleLower == 'owner' || roleLower == 'admin' || roleLower == 'edit-salesforce-settings') {
                return true;
            }
        }
        if (String.isNotBlank(permissions)) {
            for (String permission : permissions.split(',')) {
                if (permission.trim().toLowerCase() == 'edit_salesforce_settings') { return true; }
            }
        }
        return false;
    }

    /** Exchanges a PKCE authorization code and stores the Panel connection. */
    @AuraEnabled
    public static Map<String, Object> exchangeOAuthCode(String requestJson) {
        requireSettingsAdmin();
        return PanelOAuthExchangeService.exchange(requestJson);
    }

    /**
     * @description Disconnects Panel session and clears stored tokens.
     */
    @AuraEnabled
    public static Map<String, Object> logoutPanel() {
        requireSettingsAdmin();
        // Revoke the exact Panel grant before removing the Salesforce-held bearer.
        if (String.isNotBlank(PanelAuthSupportService.getConfig().Panel_Team_Id__c)) {
            HttpResponse revoke = PanelAuthSupportService.executePanelCallout('/api/oauth/revoke', 'POST', '{}');
            if (revoke.getStatusCode() < 200 || revoke.getStatusCode() >= 300) {
                throw new AuraHandledException('Panel could not revoke this session. Retry disconnect.');
            }
        }
        MCP_Config__c config = PanelAuthSupportService.getConfig();
        String disconnectedTeamId = config.Panel_Team_Id__c;
        if (config != null) {
            config.Panel_User_Email__c = null;
            config.Panel_User_Role__c = null;
            config.Panel_Team_Id__c = null;
            config.Panel_Team_Name__c = null;
            config.Panel_Permissions__c = null;
            // Clear the same protected org-wide settings after the admin permission check above.
            Database.upsert(config, AccessLevel.SYSTEM_MODE);
        }
        PanelSalesforceChannelService.clearLocalConnections(disconnectedTeamId);
        try {
            PanelExternalCredentialTokenService.clear();
        } catch (Exception ex) {
            System.debug('>>> [PanelAuthController] Note clearing external credential token: ' + ex.getMessage());
        }
        return getPanelAuthStatus();
    }

    /**
     * @description Polls Panel OAuth state endpoint to retrieve authorization code
     * when the popup completes, overcoming cross-origin window.opener severance.
     */
    @AuraEnabled
    public static Map<String, Object> pollOAuthCode(String state, String codeVerifier) {
        requireSettingsAdmin();
        if (String.isBlank(state) || String.isBlank(codeVerifier)) {
            return new Map<String, Object>{ 'success' => false, 'error' => 'State and PKCE verifier are required.' };
        }

        HttpRequest req = new HttpRequest();
        req.setEndpoint(PanelAuthSupportService.DEFAULT_PANEL_URL + '/api/oauth/poll');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setBody(JSON.serialize(new Map<String, String>{ 'state' => state, 'codeVerifier' => codeVerifier }));
        req.setTimeout(10000);

        Http http = new Http();
        try {
            HttpResponse res = http.send(req);
            if (res.getStatusCode() == 200) {
                return (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
            }
            return new Map<String, Object>{ 'success' => false, 'pending' => true, 'statusCode' => res.getStatusCode() };
        } catch (Exception ex) {
            System.debug('>>> [PanelAuthController] pollOAuthCode note: ' + ex.getMessage());
            return new Map<String, Object>{ 'success' => false, 'pending' => true, 'error' => ex.getMessage() };
        }
    }

    private static void requireSettingsAdmin() {
        PanelAuthSupportService.requireSettingsAdmin();
    }

}
