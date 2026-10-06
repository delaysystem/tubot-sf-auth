@IsTest
private class TubotAuthAutoSetupServiceTest {
    @testSetup
    static void assignSettingsPermission() {
        List<PermissionSet> adminSets = [
            SELECT Id FROM PermissionSet WHERE Name = 'Panel_Settings_Admin_Access' LIMIT 1
        ];
        if (!adminSets.isEmpty()) {
            List<PermissionSetAssignment> assignments = [
                SELECT Id FROM PermissionSetAssignment
                WHERE AssigneeId = :UserInfo.getUserId() AND PermissionSetId = :adminSets[0].Id
                LIMIT 1
            ];
            if (assignments.isEmpty()) {
                insert new PermissionSetAssignment(
                    AssigneeId = UserInfo.getUserId(),
                    PermissionSetId = adminSets[0].Id
                );
            }
        }
    }

    private class MockHttpResponseGenerator implements HttpCalloutMock {
        public HTTPResponse respond(HTTPRequest req) {
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            String endpoint = req.getEndpoint();

            if (endpoint.contains('/services/Soap/m/')) {
                res.setHeader('Content-Type', 'text/xml');
                res.setStatusCode(200);
                res.setBody('<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata"><soapenv:Body><upsertMetadataResponse><result><created>true</created><fullName>Test</fullName><success>true</success></result></upsertMetadataResponse></soapenv:Body></soapenv:Envelope>');
                return res;
            }

            if (endpoint.contains('/apps/oauth/usage')) {
                res.setStatusCode(200);
                res.setBody('{"apps":[{"developerName":"Tubot_SF_Channel_API","identifier":"0xIg00000000001"}]}');
                return res;
            }

            if (endpoint.contains('/apps/oauth/credentials')) {
                res.setStatusCode(200);
                res.setBody('{"key":"mock_consumer_key_123456789","secret":"mock_consumer_secret_987654321"}');
                return res;
            }

            if (endpoint.contains('/api/v1/salesforce/channels')) {
                res.setStatusCode(200);
                res.setBody('{"success":true,"channelId":"0Mjg5000000UvVVCA0"}');
                return res;
            }

            res.setStatusCode(200);
            res.setBody('{"records":[]}');
            return res;
        }
    }

    @IsTest
    static void testSynchronousSetupAuthSystem() {
        TubotAuthAutoSetupService.testWithCalloutMock = true;
        Test.setMock(HttpCalloutMock.class, new MockHttpResponseGenerator());
        Test.startTest();
        TubotAuthAutoSetupService.SetupResult result = TubotAuthAutoSetupService.autoSetupAuth(null, UserInfo.getUserId());
        Test.stopTest();

        System.assertNotEquals(null, result, 'SetupResult must not be null');
        System.assertEquals(true, result.success, 'Setup must succeed with mock endpoints: ' + result.message);
        System.assertEquals('mock_consumer_key_123456789', result.clientId, 'Consumer Key must match mock');
    }

    @IsTest
    static void testReentrancyGuard() {
        TubotAuthAutoSetupService.isExecuting = true;
        try {
            TubotAuthAutoSetupService.SetupResult result = TubotAuthAutoSetupService.autoSetupAuth(null, UserInfo.getUserId());
            System.assertEquals(false, result.success);
            System.assertEquals('Auto-setup already in progress.', result.message);
        } finally {
            TubotAuthAutoSetupService.isExecuting = false;
        }
    }

    @IsTest
    static void testConnectedChannelRegistration() {
        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        if (config == null || config.Id == null) {
            config = new MCP_Config__c(SetupOwnerId = UserInfo.getOrganizationId());
        }
        config.Panel_Base_URL__c = PanelAuthSupportService.DEFAULT_PANEL_URL;
        config.Panel_Client_Id__c = 'pnl_client_salesforce_mcp';
        config.Panel_Team_Id__c = 'team_mock_autotest';
        Database.upsert(config, AccessLevel.SYSTEM_MODE);

        TubotAuthAutoSetupService.testWithCalloutMock = true;
        Test.setMock(HttpCalloutMock.class, new MockHttpResponseGenerator());

        Test.startTest();
        TubotAuthAutoSetupService.SetupResult result = TubotAuthAutoSetupService.autoSetupAuth(null, UserInfo.getUserId());
        Test.stopTest();

        System.assertNotEquals(null, result);
        System.assertEquals(true, result.success, 'Registration should succeed: ' + result.message);
    }

    @IsTest
    static void testChannelRegistrationIdempotency() {
        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        if (config == null || config.Id == null) {
            config = new MCP_Config__c(SetupOwnerId = UserInfo.getOrganizationId());
        }
        config.Panel_Base_URL__c = PanelAuthSupportService.DEFAULT_PANEL_URL;
        config.Panel_Client_Id__c = 'pnl_client_salesforce_mcp';
        config.Panel_Team_Id__c = 'team_mock_autotest';
        Database.upsert(config, AccessLevel.SYSTEM_MODE);

        List<MessagingChannel> channels = TubotAuthAutoSetupService.resolveChannels(null);
        if (!channels.isEmpty()) {
            Tubot_API_Channel__c preExisting = new Tubot_API_Channel__c(
                Channel_Id__c = channels[0].Id,
                Team_Id__c = 'team_mock_autotest',
                Integration_User_Id__c = UserInfo.getUserId(),
                Assignment_Owned__c = false
            );
            insert preExisting;
        }

        TubotAuthAutoSetupService.testWithCalloutMock = true;
        Test.setMock(HttpCalloutMock.class, new MockHttpResponseGenerator());

        Test.startTest();
        TubotAuthAutoSetupService.SetupResult result = TubotAuthAutoSetupService.autoSetupAuth(null, UserInfo.getUserId());
        Test.stopTest();

        System.assertNotEquals(null, result);
        System.assertEquals(true, result.success, 'Idempotent run should succeed: ' + result.message);
    }

    @IsTest
    static void testAsyncQueueableExecution() {
        TubotAuthAutoSetupService.testWithCalloutMock = true;
        Test.setMock(HttpCalloutMock.class, new MockHttpResponseGenerator());
        Test.startTest();
        Id jobId = TubotAuthAutoSetupService.setupAuthSystemAsync(null, UserInfo.getUserId());
        Test.stopTest();

        System.assertNotEquals(null, jobId, 'Queueable job must be enqueued');
    }

    @IsTest
    static void testHelperResolutions() {
        User u = TubotAuthAutoSetupService.resolveIntegrationUser(UserInfo.getUserId());
        System.assertNotEquals(null, u, 'Should resolve current user');

        String sess = TubotAuthAutoSetupService.resolveSessionId();
        System.assertNotEquals(null, sess, 'Session ID must resolve');
    }
}
