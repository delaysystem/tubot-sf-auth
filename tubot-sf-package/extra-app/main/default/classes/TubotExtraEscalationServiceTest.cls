@IsTest
private class TubotExtraEscalationServiceTest {
    @TestSetup
    static void createMessagingSession() {
        String testUsername = 'tubot-extra-' + UserInfo.getOrganizationId() + '@example.invalid';
        User testUser = new User(
            ProfileId = UserInfo.getProfileId(),
            LastName = 'TuBot Extra Test',
            Alias = 'tbextra',
            Email = 'tubot-extra@example.invalid',
            Username = testUsername,
            TimeZoneSidKey = 'America/Los_Angeles',
            LocaleSidKey = 'en_US',
            EmailEncodingKey = 'UTF-8',
            LanguageLocaleKey = 'en_US'
        );
        insert testUser;

        PermissionSet messagingAccess = [
            SELECT Id
            FROM PermissionSet
            WHERE Name = 'TuBot_Extra_Messaging_Access'
            LIMIT 1
        ];
        insert new PermissionSetAssignment(
            AssigneeId = testUser.Id,
            PermissionSetId = messagingAccess.Id
        );

        System.runAs(testUser) {
            List<Conversation> conversations = Test.loadData(
                Conversation.SObjectType,
                'TubotExtraConversationFixture'
            );
            MessagingChannel channel = new MessagingChannel(
                DeveloperName = 'TubotExtraTestChannel',
                MasterLabel = 'TuBot Extra Test Channel',
                MessageType = 'EmbeddedMessaging',
                MessagingPlatformKey = 'tubot-extra-test-channel'
            );
            insert channel;

            MessagingEndUser endUser = new MessagingEndUser(
                Name = 'TuBot Extra Test User',
                MessagingChannelId = channel.Id,
                MessageType = 'EmbeddedMessaging',
                MessagingPlatformKey = 'tubot-extra-test-user'
            );
            insert endUser;

            insert new MessagingSession(
                MessagingChannelId = channel.Id,
                MessagingEndUserId = endUser.Id,
                ConversationId = conversations[0].Id,
                Status = 'New'
            );
        }
    }

    @IsTest
    static void escalationPersistsAllMessagingSessionFields() {
        User testUser = getTestUser();
        System.runAs(testUser) {
            MessagingSession beforeUpdate = [SELECT Id FROM MessagingSession LIMIT 1];
            String requestJson = JSON.serialize(new Map<String, Object>{
                'sessionId' => beforeUpdate.Id,
                'reason' => '  Customer requested a person  ',
                'summary' => 'Product question; needs a human follow up.',
                'varTargetQueueName' => '  Billing Queue  ',
                'varRouting' => '  Billing_Routing_Config  ',
                'varSkillLevel' => 3,
                'varTargetSkillName' => '  Billing  ',
                'varFlowHuman' => '  Human_Handoff  '
            });

            Test.startTest();
            Map<String, Object> result = TubotExtraEscalationController.escalateSessionRecord(requestJson);
            Test.stopTest();

            System.assertEquals(true, result.get('success'), 'Service error: ' + result.get('error'));
            MessagingSession saved = [
                SELECT Escalate_To_Human__c, Escalation_Reason__c, AI_Conversation_Summary__c,
                    varTargetQueueName__c, varRouting__c, varSkillLevel__c,
                    varTargetSkillName__c, varFlowHuman__c
                FROM MessagingSession
                WHERE Id = :beforeUpdate.Id
                WITH USER_MODE
            ];
            System.assertEquals(true, saved.Escalate_To_Human__c);
            System.assertEquals('Customer requested a person', saved.Escalation_Reason__c);
            System.assertEquals('Product question; needs a human follow up.', saved.AI_Conversation_Summary__c);
            System.assertEquals('Billing_Queue', saved.varTargetQueueName__c);
            System.assertEquals('Billing_Routing_Config', saved.varRouting__c);
            System.assertEquals(3, saved.varSkillLevel__c);
            System.assertEquals('Billing', saved.varTargetSkillName__c);
            System.assertEquals('Human_Handoff', saved.varFlowHuman__c);
            System.assertEquals(false, result.get('usedFallbackQueue'));
        }
    }

    @IsTest
    static void emptyRoutingUsesChatQueueFallback() {
        System.runAs(getTestUser()) {
            MessagingSession session = [SELECT Id FROM MessagingSession LIMIT 1];
            Map<String, Object> result = TubotExtraEscalationService.escalate(JSON.serialize(
                new Map<String, Object>{ 'sessionId' => session.Id }
            ));

            System.assertEquals(true, result.get('success'), 'Service error: ' + result.get('error'));
            System.assertEquals(true, result.get('usedFallbackQueue'));
            System.assertEquals('Chat_Queue', result.get('varTargetQueueName'));
            MessagingSession saved = [
                SELECT Escalate_To_Human__c, varTargetQueueName__c
                FROM MessagingSession
                WHERE Id = :session.Id
                WITH USER_MODE
            ];
            System.assertEquals(true, saved.Escalate_To_Human__c);
            System.assertEquals('Chat_Queue', saved.varTargetQueueName__c);
        }
    }

    @IsTest
    static void invalidSessionIdReturnsHelpfulError() {
        Map<String, Object> result = TubotExtraEscalationService.escalate('{"sessionId":"not-an-id"}');

        System.assertEquals(false, result.get('success'));
        System.assertEquals('A valid Messaging Session ID is required.', result.get('error'));
    }

    private static User getTestUser() {
        String testUsername = 'tubot-extra-' + UserInfo.getOrganizationId() + '@example.invalid';
        return [SELECT Id FROM User WHERE Username = :testUsername LIMIT 1];
    }
}
