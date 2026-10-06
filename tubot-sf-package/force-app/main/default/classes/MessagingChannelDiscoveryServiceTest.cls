@IsTest
private class MessagingChannelDiscoveryServiceTest {
    private static Id syntheticId(String prefix) {
        return (Id) (prefix + '000000000000');
    }

    private static MessagingChannel channel(String developerName, Id handlerId, Id fallbackQueueId) {
        return new MessagingChannel(
            Id = syntheticId(MessagingChannel.SObjectType.getDescribe(SObjectDescribeOptions.DEFERRED).getKeyPrefix()),
            MasterLabel = developerName,
            DeveloperName = developerName,
            MessageType = 'Web',
            SessionHandlerId = handlerId,
            FallbackQueueId = fallbackQueueId
        );
    }

    @IsTest
    static void describesUnassignedQueueFlowAndOtherHandlers() {
        Id queueId = syntheticId('00G');
        Id flowId = syntheticId('300');
        Id otherHandlerId = UserInfo.getUserId();
        Group queue = new Group(Id = queueId, Name = 'Support Queue', DeveloperName = 'Support_Queue');
        Map<Id, Group> queues = new Map<Id, Group>{ queueId => queue };
        Map<String, String> flowNames = new Map<String, String>{ String.valueOf(flowId) => 'Main Flow (main_flow)' };
        MessagingChannelDiscoveryService.DiscoveryContext context =
            new MessagingChannelDiscoveryService.DiscoveryContext();
        context.channels = new List<MessagingChannel>{
            channel('Unassigned_Channel', null, null),
            channel('Queue_Channel', queueId, queueId),
            channel('Flow_Channel', flowId, null),
            channel('Other_Channel', otherHandlerId, null),
            channel('Target_Flow_Channel', flowId, queueId)
        };
        context.queuesById = queues;
        context.flowNamesById = flowNames;
        context.targetFlowId = flowId;
        context.holdingQueueId = queueId;
        context.targetFlowName = 'Main Flow (main_flow)';
        context.holdingQueueName = 'Support Queue (Support_Queue)';
        List<Map<String, Object>> rows = MessagingChannelDiscoveryService.describeChannelsForTest(context);

        System.assertEquals(5, rows.size());
        System.assertEquals('Unassigned', rows[0].get('routingTypeLabel'));
        System.assertEquals('None', rows[0].get('fallbackQueueName'));
        System.assertEquals(false, rows[0].get('isFlow'));
        System.assertEquals('Omni-Queue', rows[1].get('routingTypeLabel'));
        System.assertEquals('Support Queue (Support_Queue)', rows[1].get('handlerName'));
        System.assertEquals('Support Queue (Support_Queue)', rows[1].get('fallbackQueueName'));
        System.assertEquals('Omni-Flow', rows[2].get('routingTypeLabel'));
        System.assertEquals('Main Flow (main_flow)', rows[2].get('handlerName'));
        System.assertEquals('Other (' + otherHandlerId + ')', rows[3].get('routingTypeLabel'));
        System.assertEquals('Main Flow (main_flow)', rows[3].get('omniFlowName'));
        System.assertEquals(true, rows[4].get('isTargetOmniFlow'));
        System.assertEquals(true, rows[4].get('holdingQueueAvailable'));
        System.assertEquals(true, rows[4].get('omniFlowAvailable'));
    }

    @IsTest
    static void queriesCurrentChannelsForTheSettingsScreen() {
        Test.startTest();
        List<Map<String, Object>> rows = MessagingChannelDiscoveryService.getChannels();
        Test.stopTest();

        System.assertNotEquals(null, rows);
    }
}
