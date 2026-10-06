/** Exchanges Panel OAuth authorization codes using the supplied PKCE verifier. */
public with sharing class PanelOAuthTokenExchangeService {
    public static Map<String, Object> exchange(Map<String, Object> input) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint(PanelAuthSupportService.DEFAULT_PANEL_URL + '/api/oauth/token');
        request.setMethod('POST');
        request.setHeader('Content-Type', 'application/json');
        request.setBody(JSON.serialize(new Map<String, Object>{
            'grant_type' => 'authorization_code',
            'code' => input.get('code'),
            'client_id' => input.get('clientId'),
            'redirect_uri' => input.get('redirectUri'),
            'code_verifier' => input.get('codeVerifier')
        }));
        request.setTimeout(20000);
        HttpResponse response = new Http().send(request);
        if (response.getStatusCode() != 200) {
            throw new AuraHandledException('Panel OAuth token exchange failed (HTTP ' + response.getStatusCode() + '). Restart login.');
        }
        Map<String, Object> token = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
        if (String.isBlank((String) token.get('access_token')) || String.isBlank((String) token.get('team_id'))) {
            throw new AuraHandledException('Panel returned an incomplete OAuth response. Restart login.');
        }
        return token;
    }
}
