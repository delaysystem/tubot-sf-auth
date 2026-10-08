@IsTest
private class TuBotSelfOrgConnectionControllerTest {
    private class PanelResponseMock implements HttpCalloutMock {
        private Integer statusCode;
        private String responseBody;
        private String requestMethod;
        private String requestEndpoint;
        private String requestBody;

        public PanelResponseMock(Integer code, String body) {
            statusCode = code;
            responseBody = body;
        }

        public HTTPResponse respond(HTTPRequest request) {
            requestMethod = request.getMethod();
            requestEndpoint = request.getEndpoint();
            requestBody = request.getBody();
            HttpResponse response = new HttpResponse();
            response.setHeader('Content-Type', 'application/json');
            response.setStatusCode(statusCode);
            response.setBody(responseBody);
            return response;
        }
    }

    @TestSetup
    static void setupAuthorizedInstaller() {
        User currentUser = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        System.runAs(currentUser) {
            PanelTestPermissionHelper.assignPermissionSet(currentUser.Id, 'Panel_Settings_Admin_Access');
        }

        MCP_Config__c config = new MCP_Config__c(SetupOwnerId = UserInfo.getOrganizationId());
        config.Panel_Base_URL__c = 'https://panel.example.invalid';
        config.Panel_Client_Id__c = 'test-panel-client';
        config.Panel_User_Email__c = 'panel-admin@example.invalid';
        config.Panel_User_Role__c = 'admin';
        config.Panel_Team_Id__c = 'test-team';
        config.Panel_Team_Name__c = 'Test Panel Team';
        config.Panel_Permissions__c = 'edit_salesforce_settings';
        upsert config;
    }

    private static User currentUser() {
        return [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
    }

    @IsTest
    static void connectionStatusIsAlwaysConfiguredForBundledClient() {
        // The Panel-connection client ships in the package (global
        // consumer): no per-org ECA setup can be missing.
        PanelAuthSupportService.managePermissionTestOverride = true;
        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        config.Panel_Team_Id__c = null;
        Database.upsert(config, AccessLevel.SYSTEM_MODE);

        User admin = currentUser();
        Map<String, Object> result;
        System.runAs(admin) {
            result = TuBotSelfOrgConnectionController.getConnectionStatus();
        }

        System.assertEquals(true, result.get('configured'));
        System.assertEquals(false, result.get('connected'));
        System.assertEquals('Connect Panel first.', result.get('message'));
    }

    @IsTest
    static void authorizationUrlUsesPanelPkceBroker() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        PanelResponseMock mock = new PanelResponseMock(
            200, '{"authorizationUrl":"https://login.salesforce.com/services/oauth2/authorize?response_type=code"}'
        );
        Test.setMock(HttpCalloutMock.class, mock);
        User admin = currentUser();
        String result;
        Test.startTest();
        System.runAs(admin) {
            result = TuBotSelfOrgConnectionController.getAuthorizationUrl();
        }
        Test.stopTest();
        System.assertEquals('https://login.salesforce.com/services/oauth2/authorize?response_type=code', result);
        // Durable regression: the org sends only its own identity. Panel
        // holds the packaged global consumer key.
        Map<String, Object> payload = (Map<String, Object>) JSON.deserializeUntyped(mock.requestBody);
        System.assertEquals(false, payload.containsKey('clientId'), 'Authorize request must not carry a client id.');
        System.assertEquals(false, payload.containsKey('clientSecret'), 'Authorize request must not carry a client secret.');
    }

    @IsTest
    static void connectionStatusReadsPanelResponse() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        Test.setMock(HttpCalloutMock.class, new PanelResponseMock(200, '{"connected":true}'));
        User admin = currentUser();
        Map<String, Object> result;
        Test.startTest();
        System.runAs(admin) {
            result = TuBotSelfOrgConnectionController.getConnectionStatus();
        }
        Test.stopTest();
        System.assertEquals(true, result.get('configured'));
        System.assertEquals(true, result.get('connected'));
        System.assertEquals('Connected', result.get('message'));
    }

    @IsTest
    static void disconnectCallsPanelBroker() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        PanelResponseMock mock = new PanelResponseMock(204, '');
        Test.setMock(HttpCalloutMock.class, mock);
        User admin = currentUser();
        Test.startTest();
        System.runAs(admin) {
            TuBotSelfOrgConnectionController.disconnect();
        }
        Test.stopTest();
        System.assertEquals('DELETE', mock.requestMethod);
        System.assert(mock.requestEndpoint.endsWith('/api/v1/salesforce/self-oauth'));
        Map<String, Object> payload = (Map<String, Object>) JSON.deserializeUntyped(mock.requestBody);
        System.assertEquals(UserInfo.getOrganizationId(), payload.get('orgId'));
    }

    @IsTest
    static void salesforceApiProxyRejectsNonOrgEndpoints() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        HttpRequest request = new HttpRequest();
        request.setEndpoint('https://example.invalid/services/data/v67.0/query');
        request.setMethod('GET');
        User admin = currentUser();
        Boolean rejected = false;
        System.runAs(admin) {
            try {
                TuBotSelfOrgConnectionController.sendSalesforceApiRequest(request);
            } catch (AuraHandledException ex) {
                rejected = true;
            }
        }
        System.assertEquals(true, rejected);
    }
}
