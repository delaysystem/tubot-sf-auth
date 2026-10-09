@isTest
private class SessionFieldsProvisioningServiceTest {

    private class ToolingAndCompositeHttpMock implements HttpCalloutMock {
        public HTTPResponse respond(HTTPRequest req) {
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            String endpoint = req.getEndpoint();

            if (endpoint.contains('/tooling/sobjects/CustomField/')) {
                res.setStatusCode(201);
                res.setBody('{"id":"00Ng500000Mock123","success":true,"errors":[]}');
            } else if (endpoint.contains('/composite/sobjects')) {
                res.setStatusCode(200);
                res.setBody('[{"id":"01kg50000Mock123","success":true,"errors":[]}]');
            } else if (endpoint.contains('/tooling/query')) {
                res.setStatusCode(200);
                if (endpoint.contains('QuickActionDefinition')) {
                    res.setBody('{"totalSize":0,"done":true,"records":[]}');
                } else if (endpoint.contains('Layout')) {
                    res.setBody('{"totalSize":1,"done":true,"records":[{"Id":"00hg500000MockLay","Name":"Messaging Session Layout"}]}');
                } else {
                    res.setBody('{"totalSize":0,"done":true,"records":[]}');
                }
            } else if (endpoint.contains('/tooling/sobjects/QuickActionDefinition/')) {
                res.setStatusCode(201);
                res.setBody('{"id":"09Dg500000MockQA","success":true,"errors":[]}');
            } else if (endpoint.contains('/tooling/sobjects/Layout/')) {
                if (req.getMethod() == 'PATCH') {
                    res.setStatusCode(204);
                    res.setBody('');
                } else {
                    res.setStatusCode(200);
                    res.setBody('{"Id":"00hg500000MockLay","Name":"Messaging Session Layout","Metadata":{"quickActionList":{"quickActionListItems":[]}}}');
                }
            } else {
                res.setStatusCode(200);
                res.setBody('{"success":true}');
            }
            return res;
        }
    }

    @testSetup
    static void setupTestData() {
        // Setup objects (PermissionSet) inside runAs to prevent MIXED_DML_OPERATION
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

            PermissionSet psAi = new PermissionSet(
                Name = 'Test_AI_Integration_PS',
                Label = 'Test AI Integration PS'
            );
            PermissionSet psAgent = new PermissionSet(
                Name = 'Test_Agent_Messaging_PS',
                Label = 'Test Agent Messaging PS'
            );
            insert new List<PermissionSet>{ psAi, psAgent };
        }

        Messaging_Config__c msgConfig = Messaging_Config__c.getOrgDefaults();
        if (msgConfig == null || msgConfig.Id == null) {
            msgConfig = new Messaging_Config__c(SetupOwnerId = UserInfo.getOrganizationId());
        }
        upsert msgConfig;
    }

    @isTest
    static void testGetRequiredFieldSpecs() {
        List<SessionFieldsProvisioningService.FieldDefinitionSpec> specs = SessionFieldsProvisioningService.getRequiredFieldSpecs();
        System.assertNotEquals(null, specs, 'Specs list should not be null');
        System.assertEquals(8, specs.size(), 'Should have exactly 8 session field specs');

        Set<String> fieldNames = new Set<String>();
        for (SessionFieldsProvisioningService.FieldDefinitionSpec spec : specs) {
            fieldNames.add(spec.apiName);
        }
        System.assert(fieldNames.contains('Escalate_To_Human__c'), 'Should contain Escalate_To_Human__c');
        System.assert(fieldNames.contains('Escalation_Reason__c'), 'Should contain Escalation_Reason__c');
        System.assert(fieldNames.contains('AI_Conversation_Summary__c'), 'Should contain AI_Conversation_Summary__c');
        System.assert(fieldNames.contains('varSkillLevel__c'), 'Should contain varSkillLevel__c');
        System.assert(fieldNames.contains('varTargetSkillName__c'), 'Should contain varTargetSkillName__c');
        System.assert(fieldNames.contains('varTargetQueueName__c'), 'Should contain varTargetQueueName__c');
        System.assert(fieldNames.contains('varRouting__c'), 'Should contain varRouting__c');
        System.assert(fieldNames.contains('varFlowHuman__c'), 'Should contain varFlowHuman__c');
    }

    @isTest
    static void testMessagingChannels() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        List<Map<String, Object>> channels;
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        System.runAs(admin) {
            channels = SessionFieldsProvisioningService.getMessagingChannels();
        }
        System.assertNotEquals(null, channels, 'Authorized settings users can read messaging channels.');
    }

    @IsTest
    static void testRestoreFieldProvisioningPipelineWithExistingPackageFields() {
        Test.setMock(HttpCalloutMock.class, new ToolingAndCompositeHttpMock());
        String request = JSON.serialize(new Map<String, String>{
            'aiPermSetDevName' => 'Test_AI_Integration_PS',
            'agentPermSetDevName' => 'Test_Agent_Messaging_PS',
            'targetUserIdentifier' => 'default'
        });

        Test.startTest();
        Map<String, Object> result = SessionFieldProvisioningPipelineService.create(request);
        Test.stopTest();

        System.assertEquals(true, result.get('success'), 'Restore must complete field and permission checks.');
        System.assertEquals(8, ((List<Object>) result.get('step1Fields')).size());
        System.assertNotEquals(null, result.get('step2PermSets'));
        System.assertNotEquals(null, result.get('step3FieldPermissions'));
        System.assertNotEquals(null, result.get('step4Verification'));
    }
}
