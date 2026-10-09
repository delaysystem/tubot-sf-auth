@isTest
private class PanelAuthControllerTest {

    private class PanelHttpMock implements HttpCalloutMock {
        public HTTPResponse respond(HTTPRequest req) {
            String endpoint = req.getEndpoint();
            if (endpoint.contains('/api/oauth/')) { return oauthResponse(endpoint); }
            if (endpoint.contains('/api/v1/')) { return panelApiResponse(endpoint); }
            if (endpoint.contains('/tooling/query')) { return response(200, toolingQueryBody(endpoint)); }
            if (endpoint.contains('/tooling/sobjects/')) { return toolingWriteResponse(req); }
            if (endpoint.contains('/composite/sobjects')) { return response(200, '[{"id":"01kg50000Mock123","success":true,"errors":[]}]'); }
            return response(200, '{"status":"ok"}');
        }

        private HTTPResponse oauthResponse(String endpoint) {
            if (endpoint.contains('/api/oauth/token')) {
                return response(200, '{"access_token":"mock_pnl_at_12345","token_type":"Bearer",' +
                    '"expires_in":900,"refresh_token":"mock_pnl_rt_12345",' +
                    '"team_id":"team_mock_tenant","user_id":"usr_mock_123"}');
            }
            if (endpoint.contains('/api/oauth/userinfo')) {
                return response(200, '{"sub":"usr_mock_123","email":"john@example.com",' +
                    '"team_id":"team_mock_tenant","team_name":"Acme Multi-Tenant Corp"}');
            }
            return response(200, '{"success":true,"code":"pnl_code_mock_poll_123"}');
        }

        private HTTPResponse panelApiResponse(String endpoint) {
            if (endpoint.contains('/api/v1/team/role')) {
                return response(200, '{"teamName":"Acme Multi-Tenant Corp",' +
                    '"role":{"name":"edit-salesforce-settings","isSystemRole":true},' +
                    '"permissions":["access_dashboard","edit_salesforce_settings"]}');
            }
            if (endpoint.contains('/api/v1/user')) {
                return response(200, '{"user":{"id":"usr_mock_123","email":"john@example.com",' +
                    '"firstName":"John","lastName":"Doe"}}');
            }
            if (endpoint.contains('/api/v1/salesforce/deployments')) { return response(200, '{"success":true,"message":"Grounded in Panel engine"}'); }
            if (endpoint.contains('/api/v1/subscription')) { return response(200, '{"subscription":{"planName":"Pro","status":"active"}}'); }
            if (endpoint.contains('/api/v1/team/members')) { return response(200, '{"members":[{"email":"john@example.com","role":"edit-salesforce-settings"}]}'); }
            return response(200, '{"status":"ok"}');
        }

        private String toolingQueryBody(String endpoint) {
            if (endpoint.contains('QuickActionDefinition')) { return emptyRecords(); }
            if (endpoint.contains('Layout')) { return '{"totalSize":1,"done":true,"records":[{"Id":"00hg500000MockLay","Name":"Messaging Session Layout"}]}'; }
            if (endpoint.contains('EmbeddedServiceCustomComponent')) { return componentQueryBody(); }
            if (endpoint.contains('LightningComponentBundle')) { return bundleQueryBody(); }
            if (endpoint.contains('LightningComponentResource')) { return resourceQueryBody(); }
            return emptyRecords();
        }

        private String componentQueryBody() {
            return '{"totalSize":1,"done":true,"records":[{"Id":"0URg001",' +
                '"EmbeddedServiceConfigId":"deployment-test-001","Feature":"EmbeddedMessaging",' +
                '"CustomComponentId":"0Rbg001","CustomComponentType":"MIAW_Header"}]}';
        }

        private String bundleQueryBody() {
            return '{"totalSize":2,"done":true,"records":[{"Id":"0Rbg001","DeveloperName":"headerCustom",' +
                '"MasterLabel":"Custom Header","ManageableState":"unmanaged"},{"Id":"0Rbg002",' +
                '"DeveloperName":"redCustomHeader","MasterLabel":"Red Custom Header","ManageableState":"unmanaged"}]}';
        }

        private String resourceQueryBody() {
            return '{"totalSize":2,"done":true,"records":[{"Id":"0Rdg001","LightningComponentBundleId":"0Rbg001",' +
                '"FilePath":"lwc/headerCustom/headerCustom.js","Format":"js",' +
                '"Source":"import { initCustomHeader } from \'c/headerCustomLogic\';"},{"Id":"0Rdg002",' +
                '"LightningComponentBundleId":"0Rbg001","FilePath":"lwc/headerCustom/headerCustom.js-meta.xml",' +
                '"Format":"js","Source":"<targets><target>lightningSnapin__MessagingHeader</target></targets>"}]}';
        }

        private HTTPResponse toolingWriteResponse(HTTPRequest req) {
            String endpoint = req.getEndpoint();
            if (endpoint.contains('/tooling/sobjects/QuickActionDefinition/')) {
                return response(201, '{"id":"09Dg500000MockQA","success":true,"errors":[]}');
            }
            if (endpoint.contains('/tooling/sobjects/Layout/')) { return layoutWriteResponse(req.getMethod()); }
            if (endpoint.contains('/tooling/sobjects/CustomField/')) {
                return response(201, '{"id":"00Ng500000Mock123","success":true,"errors":[]}');
            }
            return componentWriteResponse(req.getMethod());
        }

        private HTTPResponse layoutWriteResponse(String method) {
            if (method == 'PATCH') { return response(204, ''); }
            return response(200, '{"Id":"00hg500000MockLay","Name":"Messaging Session Layout",' +
                '"Metadata":{"quickActionList":{"quickActionListItems":[]}}}');
        }

        private HTTPResponse componentWriteResponse(String method) {
            if (method == 'PATCH') { return response(204, ''); }
            return response(201, '{"id":"0URgNew123","success":true}');
        }

        private String emptyRecords() {
            return '{"totalSize":0,"done":true,"records":[]}';
        }

        private HTTPResponse response(Integer statusCode, String body) {
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            res.setStatusCode(statusCode);
            res.setBody(body);
            return res;
        }
    }

    @testSetup
    static void setupTestData() {
        User thisUser = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        System.runAs(thisUser) {
            PanelTestPermissionHelper.assignPermissionSet(thisUser.Id, 'Panel_Settings_Admin_Access');
        }

        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        if (config == null || config.Id == null) {
            config = new MCP_Config__c(SetupOwnerId = UserInfo.getOrganizationId());
        }
        config.Panel_Base_URL__c = PanelAuthSupportService.DEFAULT_PANEL_URL;
        config.Panel_Client_Id__c = 'pnl_client_salesforce_mcp';
        config.Panel_User_Email__c = 'john@example.com';
        config.Panel_User_Role__c = 'edit-salesforce-settings';
        config.Panel_Team_Id__c = 'team_mock_tenant';
        config.Panel_Team_Name__c = 'Acme Multi-Tenant Corp';
        config.Panel_Permissions__c = 'access_dashboard,edit_salesforce_settings';
        Database.upsert(config, AccessLevel.SYSTEM_MODE);

        Agentforce_Agent_Select__c mapping1 = new Agentforce_Agent_Select__c(
            Name = 'MyLWCWebApp',
            Agent_Id__c = 'agent-test-web',
            Agent_Name__c = 'Coral Cloud Agent',
            Deployment_Label__c = 'My LWC Web App',
            Tenant_Id__c = 'team_mock_tenant'
        );
        Agentforce_Agent_Select__c mapping2 = new Agentforce_Agent_Select__c(
            Name = 'myApiAgentforceDeploy',
            Agent_Id__c = 'agent-test-api',
            Agent_Name__c = 'Test',
            Deployment_Label__c = 'myApiAgentforceDeploy',
            Tenant_Id__c = 'team_mock_tenant'
        );
        insert new List<Agentforce_Agent_Select__c>{ mapping1, mapping2 };
    }

    @isTest
    static void testGetPanelAuthStatus() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        Map<String, Object> status;
        System.runAs(admin) {
        Test.startTest();
        status = PanelAuthController.getPanelAuthStatus();
        Test.stopTest();
        }

        System.assertNotEquals(null, status, 'Status should not be null');
        System.assertEquals(true, status.get('isConnected'), 'Should be connected');
        System.assertEquals(true, status.get('canEditSettings'), 'edit-salesforce-settings role should be allowed to edit');
        System.assertEquals('john@example.com', status.get('userEmail'), 'User email should match');
        // The flag must match live Named Credential presence in any org
        // (proves it is measured, not hardcoded).
        Integer namedCount = [SELECT COUNT() FROM NamedCredential
                              WHERE DeveloperName = 'Panel_Named_Credential' WITH USER_MODE];
        System.assertEquals(namedCount > 0, status.get('usesExternalCredentials'), 'Flag must match live NamedCredential presence');
        System.assertEquals(PanelAuthSupportService.getExternalCredentialName(), status.get('externalCredentialName'));
        System.assertEquals(PanelAuthSupportService.getNamedCredentialName(), status.get('namedCredentialName'));
    }

    @isTest
    static void testHasPanelNamedCredentialMatchesLivePresence() {
        // NamedCredential definitions are visible in test context, so the
        // helper must agree with a live count in any org. Fails if the flag
        // is ever re-hardcoded to a constant.
        Integer namedCount = [SELECT COUNT() FROM NamedCredential
                              WHERE DeveloperName = 'Panel_Named_Credential' WITH USER_MODE];
        Test.startTest();
        Boolean result = PanelAuthController.hasPanelNamedCredential();
        Test.stopTest();
        System.assertEquals(namedCount > 0, result, 'Flag must match live NamedCredential presence');
    }

    @isTest
    static void testReadOnlySettingsPathsUseCurrentOrgState() {
        Boolean livePermission = PanelAuthSupportService.checkManageTubotPermission();
        System.assertEquals(livePermission, PanelAuthController.hasPanelSettingsAccess());

        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        String currentEnvironment = PanelEnvironmentResolver.selectedKey(config);
        Map<String, Object> status = PanelAuthController.setPanelEnvironment(currentEnvironment);
        System.assertEquals(currentEnvironment, status.get('panelEnvironment'));

        if (config.Panel_Token_Expires_At__c == null ||
            config.Panel_Token_Expires_At__c > System.now().addMinutes(2)) {
            Datetime previousExpiry = config.Panel_Token_Expires_At__c;
            PanelAuthController.ensurePanelSession(false);
            System.assertEquals(previousExpiry, MCP_Config__c.getOrgDefaults().Panel_Token_Expires_At__c);
        }
    }

    @isTest
    static void testIncompleteProfileIsNotReportedConnected() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        config.Panel_User_Email__c = null;
        Database.upsert(config, AccessLevel.SYSTEM_MODE);

        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        Map<String, Object> status;
        System.runAs(admin) {
            status = PanelAuthController.getPanelAuthStatus();
        }

        System.assertEquals(true, status.get('hasAccessToken'), 'The saved team identifier should remain visible.');
        System.assertEquals(false, status.get('isConnected'), 'A missing account profile must prompt a fresh Panel login.');
    }

    @isTest
    static void testCheckUserCanEditSettings() {
        // This test user has the package permission set from @testSetup. Role claims do not grant it.
        System.assertEquals(true, PanelAuthController.checkUserCanEditSettings('guest', null));
        System.assertEquals(true, PanelAuthController.checkUserCanEditSettings('coworker', 'not_edit_salesforce_settings'));
        PanelAuthSupportService.managePermissionTestOverride = false;
        System.assertEquals(false, PanelAuthController.checkUserCanEditSettings('owner', null));
        System.assertEquals(false, PanelAuthController.checkUserCanEditSettings('admin', null));
        System.assertEquals(false, PanelAuthController.checkUserCanEditSettings('owner', 'access_dashboard,edit_salesforce_settings'));
    }

    @isTest
    static void testExchangeOAuthCode() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        Test.setMock(HttpCalloutMock.class, new PanelHttpMock());
        PanelExternalCredentialTokenService.bypassCredentialWriteForTest = true;

        Map<String, Object> res;
        System.runAs(admin) {
        Test.startTest();
        res = PanelAuthController.exchangeOAuthCode(JSON.serialize(new Map<String, String>{
            'code' => 'mock_code_abc123',
            'redirectUri' => PanelAuthSupportService.DEFAULT_PANEL_URL + '/oauth/callback',
            'codeVerifier' => 'mock_code_verifier_456',
            'panelBaseUrl' => 'http://localhost:3000'
        }));
        Test.stopTest();
        }

        System.assertNotEquals(null, res);
        System.assertEquals(true, res.get('isConnected'));
        System.assertEquals('john@example.com', res.get('userEmail'));
        System.assertEquals(null, res.get('userRole'), 'Panel role claims are not stored as Salesforce authorization.');
        MCP_Config__c stored = MCP_Config__c.getOrgDefaults();
        System.assertEquals('john@example.com', stored.Panel_User_Email__c, 'Connection profile must persist without token fields.');
        System.assertEquals(null, stored.Panel_User_Role__c, 'OAuth exchange must clear any stale role claim.');
        System.assertEquals(null, stored.Panel_Permissions__c, 'OAuth exchange must clear any stale permission claims.');
    }

    @isTest
    static void testLogoutPanel() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        Test.setMock(HttpCalloutMock.class, new PanelHttpMock());
        PanelExternalCredentialTokenService.bypassCredentialWriteForTest = true;
        Map<String, Object> res;
        System.runAs(admin) {
        Test.startTest();
        res = PanelAuthController.logoutPanel();
        Test.stopTest();
        }

        System.assertEquals(false, res.get('isConnected'));
        System.assertEquals(false, res.get('hasAccessToken'));
    }

    @isTest
    static void testPollOAuthCode() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        Test.setMock(HttpCalloutMock.class, new PanelHttpMock());

        Map<String, Object> pollEmpty;
        Map<String, Object> pollRes;
        System.runAs(admin) {
        Test.startTest();
        pollEmpty = PanelAuthController.pollOAuthCode('', '');
        pollRes = PanelAuthController.pollOAuthCode('sf_state_test123', 'valid_code_verifier');
        Test.stopTest();
        }

        System.assertEquals(false, pollEmpty.get('success'));
        System.assertEquals(true, pollRes.get('success'));
        System.assertEquals('pnl_code_mock_poll_123', pollRes.get('code'));
    }

    @isTest
    static void testMessagingChannelDiscovery() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        List<Map<String, Object>> channels;
        System.runAs(admin) {
            channels = MessagingConfigurationController.getMessagingChannels();
        }
        System.assertNotEquals(null, channels, 'Authorized settings users must be able to read messaging channels.');
    }

    @isTest
    static void testExternalCredentialsCalloutAndTokenPatch() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        Test.setMock(HttpCalloutMock.class, new PanelHttpMock());
        PanelExternalCredentialTokenService.bypassCredentialWriteForTest = true;

        HttpResponse res;
        System.runAs(admin) {
        Test.startTest();
        PanelExternalCredentialTokenService.store('mock_access_token_xyz');
        res = PanelAuthSupportService.executePanelCallout('/api/v1/subscription', 'GET', null);
        Test.stopTest();
        }

        System.assertNotEquals(null, res);
        System.assertEquals(200, res.getStatusCode());
    }

    @isTest
    static void testSettingsAdminGateHonorsTestOverride() {
        PanelAuthSupportService.managePermissionTestOverride = false;
        Boolean rejected = false;
        try {
            PanelAuthSupportService.requireSettingsAdmin();
        } catch (AuraHandledException expected) {
            rejected = true;
        }
        System.assertEquals(true, rejected, 'Unauthorized users must be rejected.');

        PanelAuthSupportService.managePermissionTestOverride = true;
        PanelAuthSupportService.requireSettingsAdmin();
    }

}
