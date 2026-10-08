// SELF_OAUTH_ROUTE is a Panel URL path, not a credential: the token match
// on "OAUTH" is a false positive (no secret material in this class).
@SuppressWarnings('PMD.AvoidHardcodedCredentialsInFieldDecls')
public with sharing class TuBotSelfOrgConnectionController {
    private static final String SELF_OAUTH_ROUTE = '/api/v1/salesforce/self-oauth';
    private static final String CALLBACK_PATH = '/api/v1/salesforce/self-oauth/callback';

    private static MCP_Config__c getOrgConfig() {
        return MCP_Config__c.getOrgDefaults();
    }

    private static void requireConnectionPermission() {
        if (!PanelAuthSupportService.checkManageTubotPermission()) {
            throw new AuraHandledException('You do not have permission to manage TuBot Salesforce API connections.');
        }
    }

    @AuraEnabled
    public static Map<String, Object> getConnectionStatus() {
        requireConnectionPermission();
        // The Panel-connection client ships in the package (TuBot Panel
        // Connection, global consumer): no per-org ECA setup exists, so the
        // connection is always "configured" and only the Panel link varies.
        Map<String, Object> result = new Map<String, Object>{ 'configured' => true, 'connected' => false };

        Map<String, Object> panelStatus = PanelAuthController.getPanelAuthStatus();
        if (!(Boolean) panelStatus.get('isConnected')) {
            result.put('message', 'Connect Panel first.');
            return result;
        }
        HttpResponse response = PanelAuthSupportService.executePanelCallout(
            SELF_OAUTH_ROUTE + '?orgId=' + EncodingUtil.urlEncode(UserInfo.getOrganizationId(), 'UTF-8'),
            'GET', null
        );
        if (response.getStatusCode() < 200 || response.getStatusCode() >= 300) {
            result.put('message', 'Could not load the Salesforce API connection status. Refresh and retry.');
            return result;
        }
        Map<String, Object> payload = PanelSelfOrgResponseParser.parse(response.getBody());
        Boolean connected = payload.get('connected') == true;
        result.put('connected', connected);
        result.put('message', connected ? 'Connected' : 'Not connected');
        return result;
    }

    @AuraEnabled
    public static String getAuthorizationUrl() {
        requireConnectionPermission();
        MCP_Config__c config = getOrgConfig();
        String panelBaseUrl = PanelBaseUrlResolver.resolve(config);
        requireConnectedPanelAdministrator();
        // Panel holds the packaged global consumer key: the org sends only
        // its own identity, never any client credential.
        return requestAuthorizationUrl(panelBaseUrl);
    }

    private static void requireConnectedPanelAdministrator() {
        Map<String, Object> panelStatus = PanelAuthController.getPanelAuthStatus();
        if (!(Boolean) panelStatus.get('isConnected') || !(Boolean) panelStatus.get('canEditSettings')) {
            throw new AuraHandledException('Connect Panel with a Salesforce settings administrator before continuing.');
        }
    }

    private static String requestAuthorizationUrl(String panelBaseUrl) {
        String callbackUrl = panelBaseUrl + CALLBACK_PATH;
        String body = JSON.serialize(new Map<String, Object>{
            'orgId' => UserInfo.getOrganizationId(),
            'instanceUrl' => Url.getOrgDomainUrl().toExternalForm(),
            'salesforceUserId' => UserInfo.getUserId(),
            'redirectUri' => callbackUrl
        });
        HttpResponse response = PanelAuthSupportService.executePanelCallout(SELF_OAUTH_ROUTE, 'POST', body);
        Map<String, Object> payload = PanelSelfOrgResponseParser.parse(response.getBody());
        if (isAuthorizationUrlRequestFailure(response, payload)) {
            throw new AuraHandledException(PanelSelfOrgResponseParser.safeError(payload, 'Salesforce could not start PKCE authorization. Check the External Client App and retry.'));
        }
        String authorizationUrl = (String) payload.get('authorizationUrl');
        if (!PanelSelfOrgResponseParser.isSalesforceAuthorizationUrl(authorizationUrl)) {
            throw new AuraHandledException('The authorization service returned an invalid Salesforce URL.');
        }
        return authorizationUrl;
    }

    private static Boolean isAuthorizationUrlRequestFailure(HttpResponse response, Map<String, Object> payload) {
        return response.getStatusCode() < 200 || response.getStatusCode() >= 300 ||
            !(payload.get('authorizationUrl') instanceof String);
    }

    @AuraEnabled
    public static void disconnect() {
        requireConnectionPermission();
        String body = JSON.serialize(new Map<String, Object>{ 'orgId' => UserInfo.getOrganizationId() });
        HttpResponse response = PanelAuthSupportService.executePanelCallout(SELF_OAUTH_ROUTE, 'DELETE', body);
        if (response.getStatusCode() < 200 || response.getStatusCode() >= 300) {
            Map<String, Object> payload = PanelSelfOrgResponseParser.parse(response.getBody());
            throw new AuraHandledException(PanelSelfOrgResponseParser.safeError(payload, 'Could not disconnect the Salesforce API. Retry in a moment.'));
        }
    }

    public static HttpResponse sendSalesforceApiRequest(HttpRequest salesforceRequest) {
        requireConnectionPermission();
        if (salesforceRequest == null) {
            throw new AuraHandledException('A Salesforce API request is required.');
        }
        String orgRoot = Url.getOrgDomainUrl().toExternalForm().removeEnd('/');
        String orgEndpoint = salesforceRequest.getEndpoint();
        if (String.isBlank(orgEndpoint) || !orgEndpoint.startsWith(orgRoot + '/services/')) {
            throw new AuraHandledException('The Salesforce API request URL is invalid.');
        }
        Map<String, Object> requestHeaders = new Map<String, Object>{
            'contentType' => salesforceRequest.getHeader('Content-Type'),
            'accept' => salesforceRequest.getHeader('Accept'),
            'soapAction' => salesforceRequest.getHeader('SOAPAction')
        };
        Map<String, Object> payload = new Map<String, Object>{
            'orgId' => UserInfo.getOrganizationId(),
            'path' => orgEndpoint.substring(orgRoot.length()),
            'method' => salesforceRequest.getMethod(),
            'requestBody' => salesforceRequest.getBody(),
            'headers' => requestHeaders
        };
        HttpResponse response = PanelAuthSupportService.executePanelCalloutWithTimeout(JSON.serialize(new Map<String, Object>{
            'path' => SELF_OAUTH_ROUTE + '/request', 'method' => 'POST',
            'body' => JSON.serialize(payload), 'timeoutMs' => 120000
        }));
        Map<String, Object> responseBody = PanelSelfOrgResponseParser.parse(response.getBody());
        String errorCode = responseBody.get('error') instanceof String ? (String) responseBody.get('error') : null;
        if (new Set<String>{ 'self_oauth_not_connected', 'salesforce_refresh_failed', 'salesforce_oauth_unavailable',
            'salesforce_request_unavailable', 'auth_service_unavailable' }.contains(errorCode)) {
            throw new AuraHandledException(PanelSelfOrgResponseParser.safeError(
                responseBody, 'Connect or reauthorize Salesforce API in Panel Settings, then retry.'
            ));
        }
        return response;
    }

}
