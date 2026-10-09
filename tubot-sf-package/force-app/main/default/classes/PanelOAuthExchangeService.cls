/** Completes Panel's authorization-code flow with PKCE and encrypted External Credentials storage. */
public with sharing class PanelOAuthExchangeService {
    public static Map<String, Object> exchange(String requestJson) {
        Map<String, Object> request = (Map<String, Object>) JSON.deserializeUntyped(requestJson);
        String code = (String) request.get('code');
        String redirectUri = (String) request.get('redirectUri');
        String verifier = (String) request.get('codeVerifier');
        MCP_Config__c config = PanelAuthSupportService.getConfig();
        Panel_Environment__mdt environment = PanelEnvironmentResolver.resolve(config);
        String panelBaseUrl = environment.Panel_Base_URL__c.removeEnd('/');
        validateRequest(code, redirectUri, verifier, panelBaseUrl);
        String clientId = String.isNotBlank(config.Panel_Client_Id__c)
            ? config.Panel_Client_Id__c : environment.Client_Id__c;
        Map<String, Object> token = PanelOAuthTokenExchangeService.exchange(new Map<String, Object>{
            'code' => code, 'redirectUri' => redirectUri, 'codeVerifier' => verifier, 'clientId' => clientId
        }, panelBaseUrl);
        String accessToken = (String) token.get('access_token');
        Map<String, Object> profile = fetchProfile(panelBaseUrl, accessToken);
        if (profile.get('userId') != token.get('user_id') || profile.get('teamId') != token.get('team_id')) {
            throw profileLookupFailed('OAuth identity mismatch', null);
        }
        PanelExternalCredentialTokenService.store(accessToken, (String) token.get('refresh_token'));
        saveConnection(config, panelBaseUrl, token, profile);
        return PanelAuthController.getPanelAuthStatus();
    }

    private static void validateRequest(String code, String redirectUri, String verifier, String panelBaseUrl) {
        if (String.isBlank(code)) { throw new AuraHandledException('Authorization code cannot be blank.'); }
        if (redirectUri != panelBaseUrl + '/oauth/callback') {
            throw new AuraHandledException('Invalid Panel OAuth redirect URI. Restart Panel login.');
        }
        if (String.isBlank(verifier)) { throw new AuraHandledException('PKCE verifier is required. Restart Panel login.'); }
    }

    private static Map<String, Object> fetchProfile(String panelBaseUrl, String accessToken) {
        HttpResponse response = fetchProfileEndpoint(panelBaseUrl, '/api/oauth/userinfo', accessToken);
        if (response.getStatusCode() != 200) {
            throw profileLookupFailed('user profile', response.getStatusCode());
        }
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
        if (String.isBlank((String) body.get('email')) || String.isBlank((String) body.get('team_name'))) {
            throw profileLookupFailed('incomplete Panel account profile', null);
        }
        return new Map<String, Object>{
            'email' => body.get('email'), 'teamName' => body.get('team_name'),
            'role' => null, 'permissions' => null,
            'userId' => body.get('sub'), 'teamId' => body.get('team_id')
        };
    }

    private static HttpResponse fetchProfileEndpoint(String panelBaseUrl, String path, String accessToken) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint(panelBaseUrl + path);
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

    private static void saveConnection(MCP_Config__c config, String panelBaseUrl, Map<String, Object> token, Map<String, Object> profile) {
        config.Panel_Token_Expires_At__c = System.now().addSeconds(Integer.valueOf(String.valueOf(token.get('expires_in'))));
        config.Panel_Base_URL__c = panelBaseUrl;
        config.Panel_User_Email__c = (String) profile.get('email');
        config.Panel_User_Role__c = (String) profile.get('role');
        config.Panel_Team_Id__c = (String) token.get('team_id');
        config.Panel_Team_Name__c = (String) profile.get('teamName');
        config.Panel_Permissions__c = (String) profile.get('permissions');
        Database.upsert(config, AccessLevel.SYSTEM_MODE);
    }

}
