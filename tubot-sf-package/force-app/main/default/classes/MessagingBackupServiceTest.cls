@isTest
private class MessagingBackupServiceTest {
    private static Boolean rejectedRestoreRequestObserved = false;

    private class RejectedRestoreMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest request) {
            rejectedRestoreRequestObserved = true;
            HttpResponse response = new HttpResponse();
            response.setStatusCode(500);
            response.setBody('{"error":"metadata_unavailable"}');
            return response;
        }
    }

    private class ToolingBackupMock implements HttpCalloutMock {
        public HTTPResponse respond(HTTPRequest req) {
            String endpoint = req.getEndpoint();
            if (endpoint.contains('/tooling/query')) {
                return response(200, queryBody(endpoint));
            }
            if (isWrite(endpoint)) { return writeResponse(req.getMethod()); }
            return response(200, '{"success":true}');
        }

        private String queryBody(String endpoint) {
            if (endpoint.contains('CustomField')) { return customFieldBody(); }
            if (endpoint.contains('EmbeddedServiceCustomComponent')) { return componentBody(); }
            if (endpoint.contains('EmbeddedServiceConfig')) { return deploymentBody(); }
            if (endpoint.contains('LightningComponentBundle')) { return bundleBody(); }
            return '{"totalSize":0,"done":true,"records":[]}';
        }

        private String customFieldBody() {
            return '{"totalSize":2,"done":true,"records":[' +
                '{"Id":"00Ng001","DeveloperName":"Escalate_To_Human","TableEnumOrId":"MessagingSession","Description":"AI Escalation"},' +
                '{"Id":"00Ng002","DeveloperName":"AI_Conversation_Summary","TableEnumOrId":"MessagingSession","Description":"Summary"}' +
            ']}';
        }

        private String componentBody() {
            return '{"totalSize":1,"done":true,"records":[' +
                '{"Id":"0URg001","EmbeddedServiceConfigId":"deployment-test-001","Feature":"EmbeddedMessaging","CustomComponentId":"0Rbg001","CustomComponentType":"MIAW_Header"}' +
            ']}';
        }

        private String deploymentBody() {
            return '{"totalSize":2,"done":true,"records":[' +
                '{"Id":"deployment-test-001","DeveloperName":"WebChatDeployment","MasterLabel":"Web Chat Deployment","DeploymentType":"Web","DeploymentFeature":"EmbeddedMessaging"},' +
                '{"Id":"deployment-test-002","DeveloperName":"APIDeployment","MasterLabel":"API Deployment","DeploymentType":"API","DeploymentFeature":"EmbeddedMessaging"}' +
            ']}';
        }

        private String bundleBody() {
            return '{"totalSize":1,"done":true,"records":[' +
                '{"Id":"0Rbg001","DeveloperName":"headerCustom","MasterLabel":"Header Custom"}' +
            ']}';
        }

        private Boolean isWrite(String endpoint) {
            return endpoint.contains('/tooling/sobjects/EmbeddedServiceCustomComponent') ||
                endpoint.contains('/sobjects/MessagingChannel/') || endpoint.contains('/tooling/sobjects/CustomField');
        }

        private HTTPResponse writeResponse(String method) {
            if (method == 'POST') { return response(201, '{"id":"0URgNew123","success":true}'); }
            if (method == 'PATCH') { return response(204, ''); }
            return response(200, '{"success":true}');
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
    static void setupData() {
        User thisUser = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        System.runAs(thisUser) {
            PanelTestPermissionHelper.assignPermissionSet(thisUser.Id, 'Panel_Settings_Admin_Access');
        }

        Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
        if (config == null || config.Id == null) {
            config = new Messaging_Config__c(SetupOwnerId = UserInfo.getOrganizationId());
        }
        upsert config;

        Agentforce_Agent_Select__c setting = new Agentforce_Agent_Select__c(
            Name = 'WebChatDeployment',
            Agent_Id__c = 'agent-test-messaging',
            Agent_Name__c = 'Test Service Agent',
            Deployment_Label__c = 'Web Chat Deployment',
            Tenant_Id__c = 'team_mock_123'
        );
        upsert setting;
    }

    @isTest
    static void testRestoreAgentSelectSettingsKeepsTenantScope() {
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        config.Panel_Team_Id__c = 'team_mock_123';
        upsert config;
        upsert new Agentforce_Agent_Select__c(
            Name = 'OtherTeamDeployment',
            Agent_Id__c = 'agent-other-team',
            Agent_Name__c = 'Other Team Agent',
            Deployment_Label__c = 'Other Team Deployment',
            Tenant_Id__c = 'other-test-team'
        );
        List<String> logs = new List<String>();
        System.runAs(admin) {
            MessagingBackupRestoreSettingsService.restoreAgentSelectSettings(new List<Object>{
                new Map<String, Object>{
                    'name' => 'WebChatDeployment', 'tenantId' => 'team_mock_123',
                    'agentId' => 'agent-restored', 'agentName' => 'Restored Agent',
                    'deploymentLabel' => 'Restored Deployment'
                },
                new Map<String, Object>{
                    'name' => 'OtherTeamDeployment', 'tenantId' => 'team_mock_123',
                    'agentId' => 'agent-cross-tenant', 'agentName' => 'Wrong Team Agent',
                    'deploymentLabel' => 'Wrong Team Deployment'
                },
                new Map<String, Object>{
                    'name' => 'OtherTeamSnapshot', 'tenantId' => 'other-test-team',
                    'agentId' => 'agent-other', 'agentName' => 'Other Agent',
                    'deploymentLabel' => 'Other Deployment'
                }
            }, logs);
        }

        Agentforce_Agent_Select__c restored = Agentforce_Agent_Select__c.getAll().get('WebChatDeployment');
        System.assertEquals('agent-restored', restored.Agent_Id__c);
        System.assertEquals('Restored Agent', restored.Agent_Name__c);
        System.assertEquals('team_mock_123', restored.Tenant_Id__c);
        Agentforce_Agent_Select__c otherTeam = Agentforce_Agent_Select__c.getAll().get('OtherTeamDeployment');
        System.assertEquals('agent-other-team', otherTeam.Agent_Id__c);
        System.assertEquals('other-test-team', otherTeam.Tenant_Id__c);
        System.assertEquals(null, Agentforce_Agent_Select__c.getAll().get('OtherTeamSnapshot'));
        System.assertEquals(1, logs.size());
    }

    @isTest
    static void testRestoreMessagingSettingsAppliesSnapshotValues() {
        Map<String, Object> snapshot = new Map<String, Object>{
            'selectedChannelId' => 'restored-channel',
            'targetGroupId' => 'restored-queue',
            'useFlowRouting' => false,
            'autoQueueDetector' => true,
            'agentKeyword' => 'restore-agent',
            'reactivationKeyword' => 'restore-reset',
            'detectJoinedAgent' => false,
            'reminderEnabled' => true,
            'reminderTemplate' => 'Restore reminder',
            'confirmationText' => 'Restore confirmation',
            'disabledChannelIds' => 'channel-a,channel-b',
            'reminderMinutes' => 9
        };
        List<String> logs = new List<String>();

        MessagingBackupRestoreSettingsService.restoreMessagingSettings(snapshot, logs);

        Messaging_Config__c restored = Messaging_Config__c.getOrgDefaults();
        System.assertEquals('restored-channel', restored.Selected_Messaging_Channel_Id__c);
        System.assertEquals('restored-queue', restored.Target_Group_Id__c);
        System.assertEquals(false, restored.Use_Flow_Routing__c);
        System.assertEquals(true, restored.Auto_Queue_Detector__c);
        System.assertEquals('restore-agent', restored.Agent_Keyword__c);
        System.assertEquals('restore-reset', restored.Reactivation_Keyword__c);
        System.assertEquals(false, restored.Detect_Joined_Agent__c);
        System.assertEquals(true, restored.Reminder_Enabled__c);
        System.assertEquals('Restore reminder', restored.Reminder_Message_Template__c);
        System.assertEquals('Restore confirmation', restored.Confirmation_Text__c);
        System.assertEquals('channel-a,channel-b', restored.Disabled_Channel_Ids__c);
        System.assertEquals(9, restored.Reminder_Minutes__c);
        System.assertEquals(1, logs.size());
    }

    @isTest
    static void testCreateAutomaticBackup() {
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        System.runAs(admin) {
        Test.setMock(HttpCalloutMock.class, new ToolingBackupMock());

        Test.startTest();
        Map<String, Object> result = MessagingBackupService.createBackup(JSON.serialize(new Map<String, Object>{'triggerType' => MessagingBackupService.TRIGGER_AUTOMATIC_APPLY, 'notes' => 'Test pre-apply backup', 'deploymentName' => 'WebChatDeployment', 'sessionTokenOverride' => null}));
        Test.stopTest();

        System.assertNotEquals(null, result, 'Result should not be null');
        System.assertEquals(true, result.get('success'), 'Backup should succeed');
        System.assertNotEquals(null, result.get('backupId'), 'Backup ID should be generated');
        System.assertNotEquals(null, result.get('backupReference'), 'Backup reference should be generated');
        System.assertNotEquals(null, result.get('itemSummary'), 'Item summary should be generated');

        Id backupId = (Id) result.get('backupId');
        Messaging_Backup__c rec = [
            SELECT Id, Name, Backup_Name__c, Trigger_Type__c, Status__c, Item_Summary__c, Backup_Data__c
            FROM Messaging_Backup__c
            WHERE Id = :backupId
        ];
        System.assertEquals(MessagingBackupService.STATUS_ACTIVE, rec.Status__c);
        System.assertEquals(MessagingBackupService.TRIGGER_AUTOMATIC_APPLY, rec.Trigger_Type__c);
        System.assertNotEquals(null, rec.Backup_Data__c);
        }
    }

    @isTest
    static void testCreateManualBackupViaMessagingBackupController() {
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        System.runAs(admin) {
        Test.setMock(HttpCalloutMock.class, new ToolingBackupMock());

        Test.startTest();
        Map<String, Object> result = MessagingBackupController.createManualBackup(JSON.serialize(new Map<String, Object>{'deploymentName' => 'WebChatDeployment', 'notes' => 'Manual backup from Step-by-Step setup page', 'sessionTokenOverride' => null}));
        Test.stopTest();

        System.assertNotEquals(null, result);
        System.assertEquals(true, result.get('success'));
        System.assertEquals(MessagingBackupService.TRIGGER_MANUAL, result.get('triggerType'));
        }
    }

    @isTest
    static void testGetBackupsAndDetails() {
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        System.runAs(admin) {
        Test.setMock(HttpCalloutMock.class, new ToolingBackupMock());

        Map<String, Object> createRes = MessagingBackupService.createBackup(JSON.serialize(new Map<String, Object>{'triggerType' => MessagingBackupService.TRIGGER_AUTOMATIC_APPLY, 'notes' => 'Initial test backup', 'deploymentName' => 'WebChatDeployment', 'sessionTokenOverride' => null}));
        Id backupId = (Id) createRes.get('backupId');

        Test.startTest();
        List<Map<String, Object>> backups = MessagingBackupController.getMessagingBackups();
        Map<String, Object> details = MessagingBackupController.getMessagingBackupDetails(backupId);
        Test.stopTest();

        System.assertNotEquals(null, backups, 'Backups list should not be null');
        System.assert(backups.size() > 0, 'Backups list should contain at least 1 record');
        System.assertEquals(true, details.get('success'));
        System.assertNotEquals(null, details.get('rawJson'));
        System.assertNotEquals(null, details.get('snapshot'));
        }
    }

    @isTest
    static void testRestoreBackup() {
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        System.runAs(admin) {
        Test.setMock(HttpCalloutMock.class, new ToolingBackupMock());

        Map<String, Object> createRes = MessagingBackupService.createBackup(JSON.serialize(new Map<String, Object>{'triggerType' => MessagingBackupService.TRIGGER_AUTOMATIC_APPLY, 'notes' => 'Backup to restore', 'deploymentName' => 'WebChatDeployment', 'sessionTokenOverride' => null}));
        Id backupId = (Id) createRes.get('backupId');

        Test.startTest();
        Map<String, Object> restoreRes = MessagingBackupController.restoreMessagingBackup(backupId, null);
        Test.stopTest();

        System.assertNotEquals(null, restoreRes);
        System.assertEquals(true, restoreRes.get('success'), 'Restore should report success');

        Messaging_Backup__c rec = [
            SELECT Id, Status__c, Restored_At__c
            FROM Messaging_Backup__c
            WHERE Id = :backupId
        ];
        System.assertEquals(MessagingBackupService.STATUS_RESTORED, rec.Status__c);
        System.assertNotEquals(null, rec.Restored_At__c);
        }
    }

    @isTest
    static void testRejectedRestorePreservesBackupStatus() {
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        System.runAs(admin) {
        Messaging_Backup__c backup = new Messaging_Backup__c(
            Backup_Name__c = 'Rejected restore test',
            Trigger_Type__c = MessagingBackupService.TRIGGER_MANUAL,
            Status__c = MessagingBackupService.STATUS_ACTIVE,
            Item_Summary__c = '1 Header Assignment',
            Backup_Data__c = JSON.serialize(new Map<String, Object>{
                'customComponents' => new List<Object>{new Map<String, Object>{
                    'componentType' => 'MIAW_Header', 'deploymentId' => 'test-deployment',
                    'componentId' => 'test-component'
                }}
            })
        );
        insert backup;
        Test.setMock(HttpCalloutMock.class, new RejectedRestoreMock());
        Test.startTest();
        Map<String, Object> result = MessagingBackupService.restoreBackup(backup.Id, null);
        Test.stopTest();
        System.assertEquals(true, rejectedRestoreRequestObserved, 'The restore must reach the failed upstream request.');
        System.assertEquals(false, result.get('success'));
        Messaging_Backup__c persisted = [
            SELECT Status__c, Restored_At__c FROM Messaging_Backup__c WHERE Id = :backup.Id
        ];
        System.assertEquals(MessagingBackupService.STATUS_ACTIVE, persisted.Status__c);
        System.assertEquals(null, persisted.Restored_At__c);
        }
    }

    @isTest
    static void testDeleteBackup() {
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        System.runAs(admin) {
        Test.setMock(HttpCalloutMock.class, new ToolingBackupMock());

        Map<String, Object> createRes = MessagingBackupService.createBackup(JSON.serialize(new Map<String, Object>{'triggerType' => MessagingBackupService.TRIGGER_MANUAL, 'notes' => 'To be deleted', 'deploymentName' => 'WebChatDeployment', 'sessionTokenOverride' => null}));
        Id backupId = (Id) createRes.get('backupId');

        Test.startTest();
        Map<String, Object> delRes = MessagingBackupController.deleteMessagingBackup(backupId);
        Test.stopTest();

        System.assertEquals(true, delRes.get('success'));
        List<Messaging_Backup__c> remaining = [SELECT Id FROM Messaging_Backup__c WHERE Id = :backupId];
        System.assertEquals(0, remaining.size());
        }
    }

    @isTest
    static void testAutomaticApplyBackupSnapshot() {
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        System.runAs(admin) {
        Test.setMock(HttpCalloutMock.class, new ToolingBackupMock());

        Test.startTest();
        Map<String, Object> setupRes = MessagingBackupService.createBackup(JSON.serialize(new Map<String, Object>{
            'triggerType' => MessagingBackupService.TRIGGER_AUTOMATIC_APPLY,
            'notes' => 'Automatic pre-apply backup', 'deploymentName' => 'WebChatDeployment',
            'sessionTokenOverride' => null
        }));
        Test.stopTest();

        System.assertNotEquals(null, setupRes);
        System.assertEquals(true, setupRes.get('success'), 'The automatic apply snapshot should be captured.');
        System.assertNotEquals(null, setupRes.get('backupId'), 'Step 0 backupId should be present in result');

        List<Messaging_Backup__c> bks = [
            SELECT Id, Trigger_Type__c, Status__c
            FROM Messaging_Backup__c
            WHERE Trigger_Type__c = :MessagingBackupService.TRIGGER_AUTOMATIC_APPLY
        ];
        System.assert(bks.size() > 0, 'At least one automatic backup should be persisted in database');
        }
    }
}
