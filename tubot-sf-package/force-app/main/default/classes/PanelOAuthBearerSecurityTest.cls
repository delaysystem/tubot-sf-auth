@isTest
private class PanelOAuthBearerSecurityTest {

    private class OAuthFlowMock implements HttpCalloutMock {
        public List<HttpRequest> seen = new List<HttpRequest>();

        public HTTPResponse respond(HTTPRequest req) {
            seen.add(req);
            String endpoint = req.getEndpoint();
            if (endpoint.contains('/api/oauth/token')) {
                return response(200, '{"access_token":"mock_pnl_at_12345","token_type":"Bearer",' +
                    '"expires_in":2592000,"refresh_token":"mock_pnl_rt_12345",' +
                    '"team_id":"team_mock_tenant","user_id":"usr_mock_123"}');
            }
            if (endpoint.contains('/api/v1/team/role')) {
                return response(200, '{"teamName":"Acme Multi-Tenant Corp",' +
                    '"role":{"name":"edit-salesforce-settings","isSystemRole":true},' +
                    '"permissions":["access_dashboard","edit_salesforce_settings"]}');
            }
            if (endpoint.contains('/api/v1/user')) {
                return response(200, '{"user":{"id":"usr_mock_123","email":"john@example.com",' +
                    '"firstName":"John","lastName":"Doe"}}');
            }
            return response(200, '{"success":true,"code":"pnl_code_mock_poll_123"}');
        }

        private HTTPResponse response(Integer statusCode, String body) {
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            res.setStatusCode(statusCode);
            res.setBody(body);
            return res;
        }
    }

    @isTest
    static void testProfileCallsSendRuntimeBearerOnly() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        OAuthFlowMock mock = new OAuthFlowMock();
        Test.setMock(HttpCalloutMock.class, mock);
        PanelExternalCredentialTokenService.bypassCredentialWriteForTest = true;

        System.runAs(admin) {
        Test.startTest();
        // Poll first: exchange() ends with DML, which would block a later callout in this test transaction.
        PanelAuthController.pollOAuthCode('sf_state_test123', 'valid_code_verifier');
        PanelAuthController.exchangeOAuthCode(JSON.serialize(new Map<String, String>{
            'code' => 'mock_code_abc123',
            'redirectUri' => PanelAuthSupportService.DEFAULT_PANEL_URL + '/oauth/callback',
            'codeVerifier' => 'mock_code_verifier_456'
        }));
        Test.stopTest();
        }

        System.assertEquals(4, mock.seen.size(), 'Poll, token, role, and user callouts must all fire.');
        for (HttpRequest req : mock.seen) {
            assertBearerBehavior(req);
        }
    }

    private static void assertBearerBehavior(HttpRequest req) {
        String endpoint = req.getEndpoint();
        if (endpoint.contains('/api/v1/team/role') || endpoint.contains('/api/v1/user')) {
            System.assertEquals('Bearer mock_pnl_at_12345', req.getHeader('Authorization'),
                'Profile callouts must carry the freshly minted runtime bearer: ' + endpoint);
        } else {
            System.assertEquals(null, req.getHeader('Authorization'),
                'Token and poll callouts must not send an Authorization header: ' + endpoint);
        }
    }
}
