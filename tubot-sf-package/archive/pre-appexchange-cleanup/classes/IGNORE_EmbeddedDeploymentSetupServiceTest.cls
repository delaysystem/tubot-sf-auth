@isTest
private class IGNORE_EmbeddedDeploymentSetupServiceTest {

    private class ToolingSetupMock implements HttpCalloutMock {
        public HTTPResponse respond(HTTPRequest req) {
            String endpoint = req.getEndpoint();
            if (endpoint.contains('/tooling/query')) {
                return response(200, queryBody(endpoint));
            }
            if (isToolingWrite(endpoint)) { return writeResponse(req.getMethod()); }
            return response(200, '{"success":true}');
        }

        private static String queryBody(String endpoint) {
            if (endpoint.contains('EmbeddedServiceCustomComponent')) { return componentQueryBody(); }
            if (endpoint.contains('EmbeddedServiceConfig')) { return deploymentQueryBody(); }
            if (endpoint.contains('LightningComponentResource')) { return resourceQueryBody(); }
            if (endpoint.contains('LightningComponentBundle')) { return bundleQueryBody(endpoint); }
            return '{"totalSize":0,"done":true,"records":[]}';
        }

        private static String componentQueryBody() {
            return '{"totalSize":1,"done":true,"records":[' +
                '{"Id":"0URg001","EmbeddedServiceConfigId":"deployment-test-001","Feature":"EmbeddedMessaging","CustomComponentId":"0Rbg001","CustomComponentType":"MIAW_Header"}' +
            ']}';
        }

        private static String deploymentQueryBody() {
            return '{"totalSize":3,"done":true,"records":[' +
                '{"Id":"deployment-test-001","DeveloperName":"MyWebDeploy","MasterLabel":"My Web Deploy","DeploymentType":"Web","DeploymentFeature":"EmbeddedMessaging"},' +
                '{"Id":"deployment-test-002","DeveloperName":"MyApiDeploy","MasterLabel":"My API Deploy","DeploymentType":"API","DeploymentFeature":"EmbeddedMessaging"},' +
                '{"Id":"04Ig003","DeveloperName":"MyMobileDeploy","MasterLabel":"My Mobile Deploy","DeploymentType":"Mobile","DeploymentFeature":"EmbeddedMessaging"}' +
            ']}';
        }

        private static String resourceQueryBody() {
            return '{"totalSize":2,"done":true,"records":[' +
                '{"Id":"0Rdg001","LightningComponentBundleId":"0Rbg001","FilePath":"lwc/headerCustom/headerCustom.js","Format":"js","Source":"import { initCustomHeader } from \'c/headerCustomLogic\';"},' +
                '{"Id":"0Rdg002","LightningComponentBundleId":"0Rbg001","FilePath":"lwc/headerCustom/headerCustom.js-meta.xml","Format":"js","Source":"<targets><target>lightningSnapin__MessagingHeader</target></targets>"}' +
            ']}';
        }

        private static String bundleQueryBody(String endpoint) {
            if (endpoint.contains('redCustomHeader')) {
                return '{"totalSize":1,"done":true,"records":[' +
                    '{"Id":"0Rbg002","DeveloperName":"redCustomHeader","MasterLabel":"Red Custom Header","ManageableState":"unmanaged"}' +
                ']}';
            }
            return '{"totalSize":2,"done":true,"records":[' +
                '{"Id":"0Rbg001","DeveloperName":"headerCustom","MasterLabel":"Custom Header","ManageableState":"unmanaged"},' +
                '{"Id":"0Rbg002","DeveloperName":"redCustomHeader","MasterLabel":"Red Custom Header","ManageableState":"unmanaged"}' +
            ']}';
        }

        private static Boolean isToolingWrite(String endpoint) {
            return endpoint.contains('/tooling/sobjects/EmbeddedServiceCustomComponent') ||
                endpoint.contains('/tooling/sobjects/LightningComponentResource') ||
                endpoint.contains('/tooling/sobjects/CustomField') ||
                endpoint.contains('/tooling/sobjects/QuickActionDefinition') ||
                endpoint.contains('/tooling/sobjects/Layout');
        }

        private static HTTPResponse writeResponse(String method) {
            if (method == 'POST') { return response(201, '{"id":"0URgNew123","success":true,"errors":[]}'); }
            if (method == 'PATCH') { return response(204, ''); }
            return response(200, '{"Id":"001mock","Metadata":{"quickActionList":{"quickActionListItems":[]}}}');
        }

        private static HTTPResponse response(Integer statusCode, String body) {
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            res.setStatusCode(statusCode);
            res.setBody(body);
            return res;
        }
    }

    @testSetup
    static void setupData() {
        User thisUser = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        System.runAs(thisUser) {
            List<PermissionSet> settingsSets = [
                SELECT Id FROM PermissionSet WHERE Name = 'Panel_Settings_Admin_Access' LIMIT 1
            ];
            if (!settingsSets.isEmpty()) {
                List<PermissionSetAssignment> settingsAssignments = [
                    SELECT Id FROM PermissionSetAssignment
                    WHERE AssigneeId = :thisUser.Id AND PermissionSetId = :settingsSets[0].Id LIMIT 1
                ];
                if (settingsAssignments.isEmpty()) {
                    insert new PermissionSetAssignment(
                        AssigneeId = thisUser.Id,
                        PermissionSetId = settingsSets[0].Id
                    );
                }
            }
        }

        Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
        if (config == null || config.Id == null) {
            config = new Messaging_Config__c(SetupOwnerId = UserInfo.getOrganizationId());
        }
        config.Api_Token__c = 'mock_api_token_123';
        upsert config;
    }

    @isTest
    static void testGetEmbeddedServiceDeployments() {
        Test.setMock(HttpCalloutMock.class, new ToolingSetupMock());

        Test.startTest();
        List<Map<String, Object>> listResult = EmbeddedDeploymentSetupService.getEmbeddedServiceDeployments(null);
        Test.stopTest();

        System.assertNotEquals(null, listResult, 'Deployments list should not be null');
        System.assertEquals(3, listResult.size(), 'Should return 3 deployments');
        System.assertEquals('MyWebDeploy', listResult[0].get('developerName'));
        System.assertEquals(true, listResult[0].get('isWeb'));
        System.assertEquals(true, listResult[1].get('isApiOrMobile'));
    }

    @isTest
    static void testGetDeploymentCustomComponents() {
        Test.setMock(HttpCalloutMock.class, new ToolingSetupMock());

        Test.startTest();
        Map<String, Object> compResult = EmbeddedDeploymentSetupService.getDeploymentCustomComponents('deployment-test-001', null);
        Test.stopTest();

        System.assertNotEquals(null, compResult);
        List<Map<String, Object>> comps = (List<Map<String, Object>>) compResult.get('components');
        System.assertNotEquals(null, comps);
        System.assertEquals(1, comps.size());
        System.assertEquals('MIAW_Header', comps[0].get('type'));
    }

    @isTest
    static void testAcceptDeploymentSetupWeb() {
        Test.setMock(HttpCalloutMock.class, new ToolingSetupMock());

        Test.startTest();
        Map<String, Object> res = EmbeddedDeploymentSetupService.acceptDeploymentSetup(
            'deployment-test-001',
            'MyWebDeploy',
            'Web',
            'agent-test-web',
            'Coral Cloud Agent',
            null
        );
        Test.stopTest();

        System.assertNotEquals(null, res);
        System.assertEquals(true, res.get('success'));
        System.assertEquals(true, res.get('isWeb'));
        System.assertEquals('Web', res.get('deploymentType'));
        System.assertEquals(true, res.get('headerComponentUpdated'));
        System.assertEquals('headerCustom', res.get('headerComponentName'));

        // Verify Custom Settings mapping
        Agentforce_Agent_Select__c setting = Agentforce_Agent_Select__c.getInstance('MyWebDeploy');
        System.assertNotEquals(null, setting);
        System.assertEquals('agent-test-web', setting.Agent_Id__c);
    }

    @isTest
    static void testAcceptDeploymentSetupApiOrMobile() {
        Test.setMock(HttpCalloutMock.class, new ToolingSetupMock());

        Test.startTest();
        Map<String, Object> res = EmbeddedDeploymentSetupService.acceptDeploymentSetup(
            'deployment-test-002',
            'MyApiDeploy',
            'API',
            'agent-test-api',
            'Test Agent',
            null
        );
        Test.stopTest();

        System.assertNotEquals(null, res);
        System.assertEquals(true, res.get('success'));
        System.assertEquals(false, res.get('isWeb'));
        System.assertEquals('API', res.get('deploymentType'));
        System.assertEquals('placeholder', res.get('placeholderText'));
        System.assertNotEquals(null, res.get('scrtUrl'));
        System.assert(((String) res.get('scrtUrl')).contains('salesforce-scrt.com'));

        // Verify Custom Settings mapping
        Agentforce_Agent_Select__c setting = Agentforce_Agent_Select__c.getInstance('MyApiDeploy');
        System.assertNotEquals(null, setting);
        System.assertEquals('agent-test-api', setting.Agent_Id__c);
    }

    @isTest
    static void testPanelAuthControllerSetupDelegation() {
        Test.setMock(HttpCalloutMock.class, new ToolingSetupMock());

        Test.startTest();
        List<Map<String, Object>> deps = EmbeddedDeploymentAdminController.getEmbeddedServiceDeployments(null);
        Map<String, Object> comps = EmbeddedDeploymentAdminController.getDeploymentCustomComponents('deployment-test-001', null);
        Map<String, Object> acceptRes = EmbeddedDeploymentAdminController.acceptDeploymentSetup(JSON.serialize(new Map<String, Object>{'deploymentId' => 'deployment-test-001', 'deploymentName' => 'MyWebDeploy', 'deploymentType' => 'Web', 'agentId' => 'agent-test-controller', 'agentName' => 'Agent', 'sessionTokenOverride' => null}));
        Test.stopTest();

        System.assertNotEquals(null, deps);
        System.assertNotEquals(null, comps);
        System.assertEquals(true, acceptRes.get('success'));
    }

    @isTest
    static void testSaveAgentSelectMappingViaRest() {
        Test.setMock(HttpCalloutMock.class, new ToolingSetupMock());

        Test.startTest();
        Boolean restRes = EmbeddedDeploymentSetupService.saveAgentSelectMappingViaRest(
            'TestDeploy', 'agent-test-api', 'Test Agent', null
        );
        Boolean channelRestRes = MessagingChannelOmniFlowConfigurator.updateViaRest(JSON.serialize(new Map<String, Object>{
            'channelId' => UserInfo.getUserId(), 'flowId' => 'flow-test-durable', 'queueId' => UserInfo.getUserId()
        }));
        Test.stopTest();

        System.assertEquals(true, restRes, 'saveAgentSelectMappingViaRest should succeed with mock HTTP 200');
        System.assertEquals(true, channelRestRes, 'setChannelOmniFlowViaRest should succeed with mock HTTP 200');
    }

    @isTest
    static void testPublishDeploymentSiteAndEnsureFlowIsActive() {
        Test.setMock(HttpCalloutMock.class, new ToolingSetupMock());

        Test.startTest();
        List<String> logs = new List<String>();
        Map<String, Object> pubRes = EmbeddedDeploymentSetupService.publishDeploymentSite('MyWebDeploy', null, logs);
        EmbeddedDeploymentSetupService.ensureFlowIsActive('t2', null, logs);
        Test.stopTest();

        System.assertNotEquals(null, pubRes);
        System.assertNotEquals(0, logs.size());
    }

    @isTest
    static void testAcceptDeploymentSetupWithRedCustomHeader() {
        Test.setMock(HttpCalloutMock.class, new ToolingSetupMock());

        Test.startTest();
        Map<String, Object> res = EmbeddedDeploymentSetupService.acceptDeploymentSetup(
            'deployment-test-001',
            'MyWebDeploy',
            'Web',
            'agent-test-web',
            'Coral Cloud Agent',
            null,
            'redCustomHeader'
        );
        Test.stopTest();

        System.assertNotEquals(null, res);
        System.assertEquals(true, res.get('success'));
        System.assertEquals(true, res.get('isWeb'));
        System.assertEquals('redCustomHeader', res.get('headerComponentName'));
    }

    @isTest
    static void testGetAvailableHeaderComponents() {
        Test.setMock(HttpCalloutMock.class, new ToolingSetupMock());

        Test.startTest();
        List<Map<String, Object>> headers = EmbeddedDeploymentSetupService.getAvailableHeaderComponents(null);
        Test.stopTest();

        System.assertNotEquals(null, headers);
        System.assert(headers.size() >= 2, 'Should return at least headerCustom and redCustomHeader');

        Boolean foundRed = false;
        Boolean foundCustom = false;
        for (Map<String, Object> h : headers) {
            String dName = (String) h.get('developerName');
            if (dName == 'redCustomHeader') { foundRed = true; }
            if (dName == 'headerCustom') { foundCustom = true; }
        }
        System.assertEquals(true, foundRed, 'Should find redCustomHeader in available headers');
        System.assertEquals(true, foundCustom, 'Should find headerCustom in available headers');
    }

    @isTest
    static void testInjectHeaderCustomLogic() {
        Test.setMock(HttpCalloutMock.class, new ToolingSetupMock());

        Test.startTest();
        Map<String, Object> res = EmbeddedDeploymentSetupService.injectHeaderCustomLogic('redCustomHeader', null);
        String jsInjected = EmbeddedDeploymentSetupService.injectJsLogic('export default class MyHeader extends LightningElement {}');
        String metaInjected = EmbeddedDeploymentSetupService.injectMetaTarget('<LightningComponentBundle></LightningComponentBundle>');
        Test.stopTest();

        System.assertNotEquals(null, res);
        System.assertEquals(true, res.get('success'));
        System.assert(jsInjected.contains('c/headerCustomLogic'));
        System.assert(metaInjected.contains('lightningSnapin__MessagingHeader'));
    }
}
