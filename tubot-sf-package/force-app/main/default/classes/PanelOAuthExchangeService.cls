/** Completes Panel's authorization-code flow with PKCE and encrypted External Credentials storage. */
public with sharing class PanelOAuthExchangeService {
    public static Map<String, Object> exchange(String requestJson) {
        Map<String, Object> request = (Map<String, Object>) JSON.deserializeUntyped(requestJson);
        String code = (String) request.get('code');
        String redirectUri = (String) request.get('redirectUri');
        String verifier = (String) request.get('codeVerifier');
        validateRequest(code, redirectUri, verifier);
        MCP_Config__c config = PanelAuthSupportService.getConfig();
        String clientId = String.isNotBlank(config.Panel_Client_Id__c)
            ? config.Panel_Client_Id__c : PanelAuthSupportService.DEFAULT_CLIENT_ID;
        Map<String, Object> token = PanelOAuthTokenExchangeService.exchange(new Map<String, Object>{
            'code' => code, 'redirectUri' => redirectUri, 'codeVerifier' => verifier, 'clientId' => clientId
        });
        String accessToken = (String) token.get('access_token');
        Map<String, Object> profile = fetchProfile(accessToken);
        PanelExternalCredentialTokenService.store(accessToken);
        saveConnection(config, token, profile);
        return PanelAuthController.getPanelAuthStatus();
    }

    private static void validateRequest(String code, String redirectUri, String verifier) {
        if (String.isBlank(code)) { throw new AuraHandledException('Authorization code cannot be blank.'); }
        if (redirectUri != PanelAuthSupportService.DEFAULT_PANEL_URL + '/oauth/callback') {
            throw new AuraHandledException('Invalid Panel OAuth redirect URI. Restart Panel login.');
        }
        if (String.isBlank(verifier)) { throw new AuraHandledException('PKCE verifier is required. Restart Panel login.'); }
    }

    private static Map<String, Object> fetchProfile(String accessToken) {
        Map<String, Object> profile = new Map<String, Object>{ 'role' => '', 'teamName' => '', 'permissions' => '', 'email' => '' };
        fetchRole(profile, accessToken);
        fetchEmail(profile, accessToken);
        if (String.isBlank((String) profile.get('role')) ||
            String.isBlank((String) profile.get('teamName')) ||
            String.isBlank((String) profile.get('email'))) {
            throw profileLookupFailed('incomplete Panel account profile', null);
        }
        return profile;
    }

    private static void fetchRole(Map<String, Object> profile, String accessToken) {
        HttpResponse response = fetchProfileEndpoint('/api/v1/team/role', accessToken);
        if (response.getStatusCode() != 200) {
            throw profileLookupFailed('team profile', response.getStatusCode());
        }
        try {
            Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
            Map<String, Object> role = (Map<String, Object>) body.get('role');
            if (role != null) { profile.put('role', (String) role.get('name')); }
            profile.put('teamName', (String) body.get('teamName'));
            profile.put('permissions', permissionText(body.get('permissions')));
        } catch (Exception ex) {
            throw profileLookupFailed('team profile', null);
        }
    }

    private static String permissionText(Object rawPermissions) {
        if (!(rawPermissions instanceof List<Object>)) { return ''; }
        List<String> values = new List<String>();
        for (Object permission : (List<Object>) rawPermissions) { values.add(String.valueOf(permission)); }
        String result = String.join(values, ',');
        if (result.length() <= 255) { return result; }
        if (result.contains('edit_salesforce_settings')) {
            result = 'edit_salesforce_settings,' + result.replace('edit_salesforce_settings,', '').replace(',edit_salesforce_settings', '');
        }
        return result.substring(0, Math.min(255, result.length()));
    }

    private static void fetchEmail(Map<String, Object> profile, String accessToken) {
        HttpResponse response = fetchProfileEndpoint('/api/v1/user', accessToken);
        if (response.getStatusCode() != 200) {
            throw profileLookupFailed('user profile', response.getStatusCode());
        }
        try {
            Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
            Map<String, Object> user = (Map<String, Object>) body.get('user');
            if (user != null) { profile.put('email', (String) user.get('email')); }
        } catch (Exception ex) {
            throw profileLookupFailed('user profile', null);
        }
    }

    private static HttpResponse fetchProfileEndpoint(String path, String accessToken) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint(PanelAuthSupportService.DEFAULT_PANEL_URL + path);
        request.setMethod('GET');
        // Runtime credential is minted in this same OAuth login flow: storing it in External Credentials first performs DML and blocks these profile callouts (uncommitted work pending, verified live on scratch), and endpoint-only named credentials cannot deploy (SecuredEndpoint requires an Authentication parameter). The host is allowlisted in the Panel_Tubot remote site.
        request.setHeader('Authorization', 'Bearer ' + accessToken); //NOPMD ApexSuggestUsingNamedCred
        request.setTimeout(20000);
        try {
            return new Http().send(request);
        } catch (Exception ex) {
            throw profileLookupFailed('Panel account', null);
        }
    }

    private static AuraHandledException profileLookupFailed(String profileName, Integer statusCode) {
        String status = statusCode == null ? '' : ' (HTTP ' + statusCode + ')';
        return new AuraHandledException(
            'Panel authorized this login, but Salesforce could not verify the ' + profileName + status +
            '. Restart Panel login and retry. (PANEL_PROFILE_LOOKUP_FAILED)'
        );
    }

    private static void saveConnection(MCP_Config__c config, Map<String, Object> token, Map<String, Object> profile) {
        config.Panel_Base_URL__c = PanelAuthSupportService.DEFAULT_PANEL_URL;
        config.Panel_User_Email__c = (String) profile.get('email');
        config.Panel_User_Role__c = (String) profile.get('role');
        config.Panel_Team_Id__c = (String) token.get('team_id');
        config.Panel_Team_Name__c = (String) profile.get('teamName');
        config.Panel_Permissions__c = (String) profile.get('permissions');
        Database.upsert(config, AccessLevel.SYSTEM_MODE);
    }

}
