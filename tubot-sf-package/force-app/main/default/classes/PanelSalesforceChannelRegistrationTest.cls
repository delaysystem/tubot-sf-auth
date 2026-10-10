@IsTest
private class PanelSalesforceChannelRegistrationTest {
    private static final String TEAM_ID = 'team_coverage_registration';
    private static HttpRequest capturedRequest;

    private class PanelRegistrationMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest request) {
            capturedRequest = request;
            HttpResponse response = new HttpResponse();
            response.setStatusCode(201);
            response.setHeader('Content-Type', 'application/json');
            response.setBody('{"success":true}');
            return response;
        }
    }

    @testSetup
    static void prepareConnectedPanelAndChannelRecord() {
        if (!hasChannelIdField()) { return; }

        User installer = [SELECT Id, ProfileId FROM User WHERE Id = :UserInfo.getUserId()];
        User target = createIntegrationUser(installer.ProfileId);
        Map<String, Object> channel = createChannel('connect', installer.Id);
        System.runAs(installer) {
            PanelTestPermissionHelper.assignPermissionSet(installer.Id, 'Panel_Settings_Admin_Access');
            PanelTestPermissionHelper.assignPermissionSet(installer.Id, 'Tubot_Salesforce_API_Read');
        }

        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        if (config == null || config.Id == null) {
            config = new MCP_Config__c(SetupOwnerId = UserInfo.getOrganizationId());
        }
        config.Panel_Team_Id__c = TEAM_ID;
        config.Panel_Team_Name__c = 'Coverage Registration';
        config.Panel_User_Email__c = 'coverage-registration@example.invalid';

        String channelId = String.valueOf(channel.get('id'));
        System.runAs(installer) {
            Database.upsert(config, AccessLevel.SYSTEM_MODE);
            insert new Tubot_API_Channel__c(
                Connection_Key__c = channelId + ':' + installer.Id,
                Channel_Id__c = channelId,
                Team_Id__c = TEAM_ID,
                Integration_User_Id__c = String.valueOf(installer.Id),
                Assignment_Owned__c = false
            );
        }
    }

    @IsTest
    static void prepareCreatesOwnedChannelAndQueuesMissingApiGrant() {
        if (!hasChannelIdField()) { return; }
        PanelAuthSupportService.managePermissionTestOverride = true;
        Tubot_API_Channel__c seed = preparedChannel();
        if (seed == null) { return; }

        User target = [
            SELECT Id FROM User
            WHERE LastName = 'CoverageRegistrationTarget' AND IsActive = true
            WITH USER_MODE
            LIMIT 1
        ];
        Test.startTest();
        PanelSalesforceChannelPreparationService.prepare(seed.Channel_Id__c, String.valueOf(target.Id));
        Test.stopTest();

        String targetId = String.valueOf(target.Id);
        Id apiPermissionSetId = PanelSalesforceChannelSupportService.resolveApiPermissionSetId();
        Tubot_API_Channel__c prepared = [
            SELECT Channel_Id__c, Team_Id__c, Integration_User_Id__c, Assignment_Owned__c, Assignment_Id__c
            FROM Tubot_API_Channel__c
            WHERE Channel_Id__c = :seed.Channel_Id__c AND Integration_User_Id__c = :targetId
            WITH USER_MODE
            LIMIT 1
        ];
        System.assertEquals(TEAM_ID, prepared.Team_Id__c);
        System.assertEquals(true, prepared.Assignment_Owned__c);
        System.assertEquals(null, prepared.Assignment_Id__c);
        System.assertEquals(1, [
            SELECT COUNT() FROM PermissionSetAssignment
            WHERE AssigneeId = :target.Id AND PermissionSetId = :apiPermissionSetId
            WITH USER_MODE
        ]);
    }

    @IsTest
    static void connectRegistersThePreparedChannelWithPanel() {
        if (!hasChannelIdField()) { return; }
        PanelAuthSupportService.managePermissionTestOverride = true;
        Tubot_API_Channel__c prepared = preparedChannel();
        if (prepared == null) { return; }
        Test.setMock(HttpCalloutMock.class, new PanelRegistrationMock());

        Test.startTest();
        PanelSalesforceChannelConnectService.connect(JSON.serialize(new Map<String, String>{
            'channelId' => prepared.Channel_Id__c,
            'integrationUserId' => prepared.Integration_User_Id__c
        }));
        Test.stopTest();

        System.assertNotEquals(null, capturedRequest);
        System.assertEquals('POST', capturedRequest.getMethod());
        System.assert(capturedRequest.getEndpoint().endsWith('/api/v1/salesforce/channels'));
        Map<String, Object> payload = (Map<String, Object>) JSON.deserializeUntyped(capturedRequest.getBody());
        System.assertEquals(UserInfo.getOrganizationId(), payload.get('orgId'));
        System.assertEquals(prepared.Channel_Id__c, payload.get('channelId'));
        System.assertEquals(prepared.Integration_User_Id__c, payload.get('integrationUserId'));
        System.assertNotEquals(null, payload.get('instanceUrl'));
    }

    private static Tubot_API_Channel__c preparedChannel() {
        if (!hasChannelIdField()) { return null; }
        String installerId = String.valueOf(UserInfo.getUserId());
        List<Tubot_API_Channel__c> rows = [
            SELECT Channel_Id__c, Integration_User_Id__c
            FROM Tubot_API_Channel__c
            WHERE Team_Id__c = :TEAM_ID AND Integration_User_Id__c = :installerId
            WITH USER_MODE
            LIMIT 1
        ];
        System.assertEquals(1, rows.size(), 'The setup transaction must seed one prepared connection.');
        return rows[0];
    }

    private static Boolean hasChannelIdField() {
        return Schema.SObjectType.Tubot_API_Channel__c.fields.getMap().containsKey('Channel_Id__c');
    }

    private static Map<String, Object> createChannel(String prefix, Id userId) {
        String suffix = EncodingUtil.convertToHex(Crypto.generateAesKey(128)).substring(0, 10);
        SimpleSetupChannelStep.forceNoExistingChannel = true;
        SimpleSetupChannelStep.ChannelSpec spec = new SimpleSetupChannelStep.ChannelSpec();
        spec.channelName = 'Cov75_' + prefix + '_' + suffix;
        spec.channelLabel = 'Coverage ' + prefix + ' ' + suffix;
        spec.queueName = 'Cov75Q_' + prefix + '_' + suffix;
        spec.queueLabel = 'Coverage Queue ' + prefix + ' ' + suffix;
        spec.userId = userId;
        return SimpleSetupChannelStep.createChannelWithQueue(spec);
    }

    private static User createIntegrationUser(Id profileId) {
        String suffix = EncodingUtil.convertToHex(Crypto.generateAesKey(128)).substring(0, 12);
        User user = new User(
            Alias = 'c75user',
            Email = 'coverage-registration-user-' + suffix + '@example.invalid',
            EmailEncodingKey = 'UTF-8',
            LastName = 'CoverageRegistrationTarget',
            LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US',
            ProfileId = profileId,
            TimeZoneSidKey = 'America/Los_Angeles',
            Username = 'coverage-registration-' + suffix + '@example.invalid'
        );
        insert user;
        return user;
    }
}
