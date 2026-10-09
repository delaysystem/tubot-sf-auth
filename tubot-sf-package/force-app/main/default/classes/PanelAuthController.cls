/**
 * @description Controller for Panel OAuth 2.0 Authentication and Multi-Tenant
 * Agentforce "Agent Select" Custom Settings grounding.
 */
public with sharing class PanelAuthController {

    /** Lightweight fail-closed check used before the settings component loads any data. */
    @AuraEnabled(cacheable=true)
    public static Boolean hasPanelSettingsAccess() {
        return PanelAuthSupportService.checkManageTubotPermission();
    }

    /**
     * @description Checks current Panel OAuth connection and permission state.
     */
    @AuraEnabled
    public static Map<String, Object> getPanelAuthStatus() {
        requireSettingsAdmin();
        MCP_Config__c config = PanelAuthSupportService.getConfig();
        Panel_Environment__mdt environment = PanelEnvironmentResolver.resolve(config);
        String environmentKey = PanelEnvironmentResolver.selectedKey(config);
        Boolean hasAccessToken = String.isNotBlank(config?.Panel_Team_Id__c);
        String userRole = config?.Panel_User_Role__c;
        String permissions = config?.Panel_Permissions__c;
        Boolean hasVerifiedProfile = String.isNotBlank(config?.Panel_User_Email__c) &&
            String.isNotBlank(config?.Panel_Team_Name__c);
        // The bearer lives only in Salesforce External Credentials, never in a custom setting.
        return new Map<String, Object>{
            'isConnected' => hasAccessToken && hasVerifiedProfile,
            'panelBaseUrl' => environment.Panel_Base_URL__c.removeEnd('/'),
            'panelEnvironment' => environmentKey,
            'panelEnvironmentLabel' => environment.Environment_Label__c,
            'clientId' => String.isNotBlank(config?.Panel_Client_Id__c) ? config.Panel_Client_Id__c : environment.Client_Id__c,
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
            String credentialName = PanelAuthSupportService.getNamedCredentialApiName();
            return [SELECT COUNT() FROM NamedCredential
                    WHERE DeveloperName = :credentialName
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
        return PanelAuthSupportService.checkManageTubotPermission();
    }

    /** Exchanges a PKCE authorization code and stores the Panel connection. */
    @AuraEnabled
    public static Map<String, Object> exchangeOAuthCode(String requestJson) {
        requireSettingsAdmin();
        return PanelOAuthExchangeService.exchange(requestJson);
    }

    /** Changes the org-wide Panel and auth environment after revoking its current session. */
    @AuraEnabled
    public static Map<String, Object> setPanelEnvironment(String environmentName) {
        requireSettingsAdmin();
        MCP_Config__c config = PanelAuthSupportService.getConfig();
        String currentEnvironment = PanelEnvironmentResolver.selectedKey(config);
        String targetEnvironment = PanelEnvironmentResolver.normalize(environmentName);
        if (currentEnvironment == targetEnvironment) {
            return getPanelAuthStatus();
        }

        Panel_Environment__mdt target = PanelEnvironmentResolver.resolve(targetEnvironment);
        String disconnectedTeamId = config.Panel_Team_Id__c;
        if (String.isNotBlank(disconnectedTeamId)) {
            revokeCurrentPanelSession(config);
        }
        PanelExternalCredentialTokenService.clear();

        config.Panel_Environment__c = targetEnvironment;
        config.Panel_Base_URL__c = target.Panel_Base_URL__c.removeEnd('/');
        config.Panel_Client_Id__c = target.Client_Id__c;
        config.Panel_Token_Expires_At__c = null;
        config.Panel_User_Email__c = null;
        config.Panel_User_Role__c = null;
        config.Panel_Team_Id__c = null;
        config.Panel_Team_Name__c = null;
        config.Panel_Permissions__c = null;
        if (config.SetupOwnerId == null) {
            config.SetupOwnerId = UserInfo.getOrganizationId();
        }
        Database.upsert(config, AccessLevel.SYSTEM_MODE);
        PanelSalesforceChannelCleanupService.clearLocalConnections(disconnectedTeamId);
        return getPanelAuthStatus();
    }

    /** Runs separately from the action being authorized so credential DML never blocks that action's callouts. */
    @AuraEnabled
    public static void ensurePanelSession(Boolean forceRefresh) {
        requireSettingsAdmin();
        MCP_Config__c config = PanelAuthSupportService.getConfig();
        if (String.isBlank(config.Panel_Team_Id__c)) return;
        // Legacy installs have no expiry/refresh credential and retain their seven-day upgrade window.
        if (forceRefresh != true && (config.Panel_Token_Expires_At__c == null ||
                config.Panel_Token_Expires_At__c > System.now().addMinutes(2))) return;
        HttpRequest request = new HttpRequest();
        request.setEndpoint('callout:' + PanelAuthSupportService.getRefreshNamedCredentialName() + '/api/oauth/refresh');
        request.setMethod('POST');
        request.setHeader('Content-Type', 'application/json');
        request.setBody('{}');
        request.setTimeout(20000);
        HttpResponse response = new Http().send(request);
        if (response.getStatusCode() != 200) {
            throw new AuraHandledException('Panel session expired or was revoked. Connect Panel again.');
        }
        Map<String, Object> token = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
        if (token.get('team_id') != config.Panel_Team_Id__c || token.get('expires_in') == null ||
                String.isBlank((String) token.get('access_token')) || String.isBlank((String) token.get('refresh_token'))) {
            throw new AuraHandledException('Panel refresh identity could not be verified. Connect Panel again.');
        }
        PanelExternalCredentialTokenService.store((String) token.get('access_token'), (String) token.get('refresh_token'));
        config.Panel_Token_Expires_At__c = System.now().addSeconds(Integer.valueOf(String.valueOf(token.get('expires_in'))));
        Database.upsert(config, AccessLevel.SYSTEM_MODE);
    }

    /**
     * @description Disconnects Panel session and clears stored tokens.
     */
    @AuraEnabled
    public static Map<String, Object> logoutPanel() {
        requireSettingsAdmin();
        // Revoke the exact Panel grant before removing the Salesforce-held bearer.
        MCP_Config__c sessionConfig = PanelAuthSupportService.getConfig();
        if (String.isNotBlank(sessionConfig.Panel_Team_Id__c)) {
            revokeCurrentPanelSession(sessionConfig);
        }
        MCP_Config__c config = PanelAuthSupportService.getConfig();
        String disconnectedTeamId = config.Panel_Team_Id__c;
        if (config != null) {
            config.Panel_Token_Expires_At__c = null;
            config.Panel_User_Email__c = null;
            config.Panel_User_Role__c = null;
            config.Panel_Team_Id__c = null;
            config.Panel_Team_Name__c = null;
            config.Panel_Permissions__c = null;
            // Clear the same protected org-wide settings after the admin permission check above.
            Database.upsert(config, AccessLevel.SYSTEM_MODE);
        }
        PanelSalesforceChannelCleanupService.clearLocalConnections(disconnectedTeamId);
        try {
            PanelExternalCredentialTokenService.clear();
        } catch (Exception ex) {
            System.debug('>>> [PanelAuthController] External credential cleanup failed.');
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
        req.setEndpoint(PanelAuthSupportService.getPanelBaseUrl() + '/api/oauth/poll');
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

    private static void revokeCurrentPanelSession(MCP_Config__c config) {
        HttpResponse revoke;
        if (config.Panel_Token_Expires_At__c == null) {
            revoke = PanelAuthSupportService.executePanelCallout('/api/oauth/revoke', 'POST', '{}');
        } else {
            HttpRequest request = new HttpRequest();
            request.setEndpoint('callout:' + PanelAuthSupportService.getRefreshNamedCredentialName() + '/api/oauth/revoke');
            request.setMethod('POST');
            request.setHeader('Content-Type', 'application/json');
            request.setBody('{}');
            request.setTimeout(20000);
            revoke = new Http().send(request);
        }
        if (revoke == null || revoke.getStatusCode() < 200 || revoke.getStatusCode() >= 300) {
            throw new AuraHandledException('Panel could not revoke this session. Retry disconnect or the environment change.');
        }
    }

}
