@IsTest
private class PanelSalesforceChannelServiceTest {
    private class ChannelCalloutMock implements HttpCalloutMock {
        private Integer statusCode;
        private String responseBody;
        private HttpRequest lastRequest;

        public ChannelCalloutMock(Integer statusCode, String responseBody) {
            this.statusCode = statusCode;
            this.responseBody = responseBody;
        }

        public HTTPResponse respond(HTTPRequest req) {
            lastRequest = req;
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            res.setStatusCode(this.statusCode);
            res.setBody(this.responseBody);
            return res;
        }
    }

    private static User setupAdminAccess() {
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
        config.Panel_User_Email__c = 'admin@example.com';
        config.Panel_User_Role__c = 'admin';
        config.Panel_Team_Id__c = 'team_mock_123';
        config.Panel_Team_Name__c = 'Mock Team';
        config.Panel_Permissions__c = 'access_dashboard,edit_salesforce_settings';
        Database.upsert(config, AccessLevel.SYSTEM_MODE);
        return thisUser;
    }

    private static Id syntheticMessagingChannelId() {
        String keyPrefix = MessagingChannel.SObjectType.getDescribe(SObjectDescribeOptions.DEFERRED).getKeyPrefix();
        return (Id) (keyPrefix + '000000000000');
    }

    private static void assignApiPermission(User targetUser) {
        Id psId = PanelTestPermissionHelper.resolvePermissionSetId(PanelSalesforceChannelService.PERMISSION_SET);
        System.assertNotEquals(null, psId, 'The packaged API permission set must exist.');
        List<PermissionSetAssignment> existing = [
            SELECT Id FROM PermissionSetAssignment
            WHERE AssigneeId = :targetUser.Id AND PermissionSetId = :psId LIMIT 1
        ];
        if (existing.isEmpty()) {
            System.runAs(targetUser) {
                insert new PermissionSetAssignment(AssigneeId = targetUser.Id, PermissionSetId = psId);
            }
        }
    }

    @IsTest
    static void unprivilegedCallerCannotRegisterCredentials() {
        Boolean denied = false;
        try {
            PanelSalesforceChannelService.connectChannel(JSON.serialize(new Map<String, String>{
                'channelId' => 'channel-test-001', 'integrationUserId' => UserInfo.getUserId(),
                'clientId' => 'key', 'clientSecret' => 'secret'
            }));
        } catch (AuraHandledException ex) {
            denied = true;
        }
        System.assertEquals(true, denied, 'Registration requires the dedicated custom permission and Panel admin grant.');
    }

    @IsTest
    static void unprivilegedCallerCannotFetchToolProxies() {
        Boolean denied = false;
        try {
            PanelSalesforceChannelService.getToolProxyList('channel-test-001');
        } catch (AuraHandledException ex) {
            denied = true;
        }
        System.assertEquals(true, denied, 'Fetching tool proxies requires admin permissions and connected status.');
    }

    @IsTest
    static void getToolProxyListSuccess() {
        User admin = setupAdminAccess();
        Test.setMock(HttpCalloutMock.class, new ChannelCalloutMock(
            200, '{"urls":["https://panel.tubot.lat/tools/proxy1","https://panel.tubot.lat/tools/proxy2"]}'
        ));

        Test.startTest();
        List<String> proxies;
        System.runAs(admin) { proxies = PanelSalesforceChannelService.getToolProxyList('channel-test-001'); }
        Test.stopTest();

        System.assertNotEquals(null, proxies, 'Proxy list should not be null');
        System.assertEquals(2, proxies.size(), 'Should return 2 URLs');
        System.assertEquals('https://panel.tubot.lat/tools/proxy1', proxies[0]);
        System.assertEquals('https://panel.tubot.lat/tools/proxy2', proxies[1]);
    }

    @IsTest
    static void getToolProxyListFallbackUrls() {
        User admin = setupAdminAccess();
        Test.setMock(HttpCalloutMock.class, new ChannelCalloutMock(
            200, '{"callableToolUrls":["https://panel.tubot.lat/tools/fallbackProxy"]}'
        ));

        Test.startTest();
        List<String> proxies;
        System.runAs(admin) { proxies = PanelSalesforceChannelService.getToolProxyList('channel-test-001'); }
        Test.stopTest();

        System.assertNotEquals(null, proxies);
        System.assertEquals(1, proxies.size());
        System.assertEquals('https://panel.tubot.lat/tools/fallbackProxy', proxies[0]);
    }

    @IsTest
    static void getToolProxyListValidationBlankChannel() {
        User admin = setupAdminAccess();
        Boolean threw = false;
        System.runAs(admin) {
            try {
                PanelSalesforceChannelService.getToolProxyList('   ');
            } catch (AuraHandledException ex) {
                threw = true;
            }
        }
        System.assertEquals(true, threw, 'Blank channelId should throw validation exception');
    }

    @IsTest
    static void getToolProxyListHttpError() {
        User admin = setupAdminAccess();
        Test.setMock(HttpCalloutMock.class, new ChannelCalloutMock(500, '{"error":"internal_error"}'));

        Boolean threw = false;
        Test.startTest();
        System.runAs(admin) {
            try {
                PanelSalesforceChannelService.getToolProxyList('channel-test-001');
            } catch (AuraHandledException ex) {
                threw = true;
            }
        }
        Test.stopTest();
        System.assertEquals(true, threw, 'HTTP 500 should throw an exception');
    }

    @IsTest
    static void listConnectionsReconcilesRemoteExecutionUsers() {
        User admin = setupAdminAccess();
        String integrationUserId = UserInfo.getUserId();
        System.runAs(admin) {
            insert new List<Tubot_API_Channel__c>{
                new Tubot_API_Channel__c(
                    Team_Id__c = 'team_mock_123',
                    Channel_Id__c = 'channel-test-001',
                    Integration_User_Id__c = integrationUserId
                ),
                new Tubot_API_Channel__c(
                    Team_Id__c = 'team_mock_123',
                    Channel_Id__c = 'channel-test-002',
                    Integration_User_Id__c = integrationUserId
                )
            };
        }
        Test.setMock(HttpCalloutMock.class, new ChannelCalloutMock(200,
            '{"channels":[{"channelId":"channel-test-001","executionUsers":[' +
            '{"integrationUserId":"' + integrationUserId + '","isPrimary":true}]},' +
            '{"channelId":"channel-test-002","executionUsers":[]}]}'));

        Test.startTest();
        List<Map<String, String>> connections;
        System.runAs(admin) { connections = PanelSalesforceChannelService.listConnections(); }
        Test.stopTest();

        System.assertEquals(2, connections.size());
        Map<String, Map<String, String>> byChannel = new Map<String, Map<String, String>>();
        for (Map<String, String> connection : connections) {
            byChannel.put(connection.get('channelId'), connection);
        }
        System.assertEquals('true', byChannel.get('channel-test-001').get('isActive'));
        System.assertEquals('true', byChannel.get('channel-test-001').get('isPrimary'));
        System.assertEquals('false', byChannel.get('channel-test-002').get('isActive'));
        System.assertEquals('false', byChannel.get('channel-test-002').get('isPrimary'));
    }

    @IsTest
    static void disconnectRejectsInvalidChannelId() {
        User admin = setupAdminAccess();
        Boolean rejected = false;
        System.runAs(admin) {
            try { PanelSalesforceChannelService.disconnectChannel('not-a-salesforce-id'); }
            catch (AuraHandledException expected) { rejected = true; }
        }
        System.assertEquals(true, rejected, 'Invalid channel IDs must fail before any remote operation.');
    }

    @IsTest
    static void connectChannelRejectsMissingValuesAndUnknownChannel() {
        User admin = setupAdminAccess();
        assignApiPermission(admin);

        Boolean missingValuesRejected = false;
        Boolean unknownChannelRejected = false;
        System.runAs(admin) {
            try {
                PanelSalesforceChannelService.connectChannel('{}');
            } catch (AuraHandledException ex) {
                missingValuesRejected = ex.getMessage().contains('required');
            }
            try {
                PanelSalesforceChannelService.connectChannel(JSON.serialize(new Map<String, String>{
                    'channelId' => String.valueOf(syntheticMessagingChannelId()),
                    'integrationUserId' => String.valueOf(admin.Id),
                    'clientId' => 'test-eca-client',
                    'clientSecret' => 'test-only-eca-secret'
                }));
            } catch (AuraHandledException ex) {
                unknownChannelRejected = ex.getMessage().contains('Messaging Channel does not exist');
            }
        }

        System.assertEquals(true, missingValuesRejected);
        System.assertEquals(true, unknownChannelRejected);
    }

    @IsTest
    static void prepareChannelCreatesAndReusesTheSelectedTeamConnection() {
        User admin = setupAdminAccess();
        assignApiPermission(admin);
        String channelId = String.valueOf(syntheticMessagingChannelId());
        PanelSalesforceChannelSupportService.allowSyntheticMessagingChannelInTest = true;

        System.runAs(admin) {
            PanelSalesforceChannelService.prepareChannel(channelId, String.valueOf(admin.Id));
            PanelSalesforceChannelService.prepareChannel(channelId, String.valueOf(admin.Id));
            List<Tubot_API_Channel__c> prepared = [
                SELECT Channel_Id__c, Integration_User_Id__c, Team_Id__c, Assignment_Owned__c
                FROM Tubot_API_Channel__c WHERE Channel_Id__c = :channelId WITH USER_MODE
            ];
            System.assertEquals(1, prepared.size(), 'Repeated preparation must be idempotent.');
            System.assertEquals(String.valueOf(admin.Id), prepared[0].Integration_User_Id__c);
            System.assertEquals('team_mock_123', prepared[0].Team_Id__c);
            System.assertEquals(false, prepared[0].Assignment_Owned__c);
            System.assertEquals(true, PanelSalesforceChannelService.isApiPermissionReady(String.valueOf(admin.Id)));
            System.assertEquals(false, PanelSalesforceChannelService.isApiPermissionReady('not-a-user'));
        }
    }

    @IsTest
    static void connectChannelRegistersCredentialsForPreparedChannel() {
        User admin = setupAdminAccess();
        assignApiPermission(admin);
        String channelId = String.valueOf(syntheticMessagingChannelId());
        System.runAs(admin) {
            insert new Tubot_API_Channel__c(
                Channel_Id__c = channelId,
                Integration_User_Id__c = String.valueOf(admin.Id),
                Team_Id__c = 'team_mock_123'
            );
        }
        PanelSalesforceChannelSupportService.allowSyntheticMessagingChannelInTest = true;
        ChannelCalloutMock mock = new ChannelCalloutMock(201, '{"success":true}');
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        System.runAs(admin) {
            PanelSalesforceChannelService.connectChannel(JSON.serialize(new Map<String, String>{
                'channelId' => channelId,
                'integrationUserId' => String.valueOf(admin.Id),
                'clientId' => 'test-eca-client',
                'clientSecret' => 'test-only-eca-secret'
            }));
        }
        Test.stopTest();

        Map<String, Object> payload = (Map<String, Object>) JSON.deserializeUntyped(mock.lastRequest.getBody());
        System.assertEquals(channelId, payload.get('channelId'));
        System.assertEquals(String.valueOf(admin.Id), payload.get('integrationUserId'));
        System.assertEquals(true, payload.containsKey('clientSecret'));
    }

    @IsTest
    static void executionUserCanConnectAndDisconnectWithPreparedPermission() {
        User admin = setupAdminAccess();
        assignApiPermission(admin);
        String channelId = String.valueOf(syntheticMessagingChannelId());
        String userId = String.valueOf(admin.Id);
        System.runAs(admin) {
            insert new Tubot_API_Channel__c(
                Channel_Id__c = channelId,
                Integration_User_Id__c = userId,
                Team_Id__c = 'team_mock_123'
            );
        }
        Test.setMock(HttpCalloutMock.class, new ChannelCalloutMock(204, ''));

        Test.startTest();
        System.runAs(admin) {
            PanelSalesforceChannelService.connectExecutionUser(JSON.serialize(new Map<String, String>{
                'channelId' => channelId,
                'integrationUserId' => userId,
                'clientId' => 'test-execution-client',
                'clientSecret' => 'test-only-execution-secret'
            }));
            PanelSalesforceChannelService.disconnectExecutionUser(channelId, userId);
        }
        Test.stopTest();

        System.runAs(admin) {
            System.assertEquals(0, [
                SELECT COUNT() FROM Tubot_API_Channel__c
                WHERE Channel_Id__c = :channelId AND Integration_User_Id__c = :userId
            ]);
        }
    }

    @IsTest
    static void disconnectChannelRemovesRemoteAndLocalConnection() {
        User admin = setupAdminAccess();
        String channelId = String.valueOf(syntheticMessagingChannelId());
        System.runAs(admin) {
            insert new Tubot_API_Channel__c(
                Channel_Id__c = channelId,
                Integration_User_Id__c = String.valueOf(admin.Id),
                Team_Id__c = 'team_mock_123'
            );
        }
        Test.setMock(HttpCalloutMock.class, new ChannelCalloutMock(204, ''));

        Test.startTest();
        System.runAs(admin) {
            PanelSalesforceChannelService.disconnectChannel(channelId);
        }
        Test.stopTest();

        System.runAs(admin) {
            System.assertEquals(0, [
                SELECT COUNT() FROM Tubot_API_Channel__c WHERE Channel_Id__c = :channelId
            ]);
        }
    }

    @IsTest
    static void clearLocalConnectionsDeletesOnlyTheSelectedTeamRows() {
        User admin = setupAdminAccess();
        System.runAs(admin) {
            insert new List<Tubot_API_Channel__c>{
                new Tubot_API_Channel__c(Team_Id__c = 'team_mock_123', Channel_Id__c = 'channel-test-003'),
                new Tubot_API_Channel__c(Team_Id__c = 'other-test-team', Channel_Id__c = 'channel-test-004')
            };
        }

        Test.startTest();
        System.runAs(admin) {
            PanelSalesforceChannelService.clearLocalConnections('team_mock_123');
            PanelSalesforceChannelService.clearLocalConnections(null);
        }
        Test.stopTest();

        System.runAs(admin) {
            System.assertEquals(0, [
                SELECT COUNT() FROM Tubot_API_Channel__c WHERE Team_Id__c = 'team_mock_123'
            ]);
            System.assertEquals(1, [
                SELECT COUNT() FROM Tubot_API_Channel__c WHERE Team_Id__c = 'other-test-team'
            ]);
        }
    }

    @IsTest
    static void assignmentCleanupRemovesPackageApiGrantOnLastChannel() {
        User admin = setupAdminAccess();
        System.runAs(admin) {
        List<PermissionSet> sets = [SELECT Id FROM PermissionSet WHERE Name = 'Tubot_Salesforce_API_Read' LIMIT 1];
        System.assertEquals(1, sets.size(), 'The packaged API permission set must exist.');
        Id userId = UserInfo.getUserId();
        List<PermissionSetAssignment> existing = [
            SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = :userId AND PermissionSetId = :sets[0].Id LIMIT 1
        ];
        Id assignmentId;
        if (existing.isEmpty()) {
            PermissionSetAssignment assignment = new PermissionSetAssignment(
                AssigneeId = userId, PermissionSetId = sets[0].Id
            );
            insert assignment;
            assignmentId = assignment.Id;
        } else {
            assignmentId = existing[0].Id;
        }
        Test.startTest();
        System.enqueueJob(new PanelApiAssignmentQueueable(new List<PanelApiAssignmentQueueable.Request>{
            new PanelApiAssignmentQueueable.Request(userId, 'REMOVE', assignmentId)
        }));
        Test.stopTest();
        System.assertEquals(0, [SELECT COUNT() FROM PermissionSetAssignment WHERE Id = :assignmentId]);
        }
    }
}
