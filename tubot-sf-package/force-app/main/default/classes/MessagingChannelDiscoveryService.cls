/** Builds the routing and fallback details shown for each Messaging Channel. */
public with sharing class MessagingChannelDiscoveryService {
    private static final String HOLDING_QUEUE_NAME = 'AI_Bot_Holding_Queue_100';

    @TestVisible
    private class DiscoveryContext {
        @TestVisible
        private List<MessagingChannel> channels = new List<MessagingChannel>();
        @TestVisible
        private Map<Id, Group> queuesById = new Map<Id, Group>();
        @TestVisible
        private Map<String, String> flowNamesById = new Map<String, String>();
        @TestVisible
        private Id targetFlowId;
        @TestVisible
        private String targetFlowName = SessionFieldsProvisioningService.OMNI_FLOW_API_NAME;
        @TestVisible
        private Id holdingQueueId;
        @TestVisible
        private String holdingQueueName = HOLDING_QUEUE_NAME;
    }

    public static List<Map<String, Object>> getChannels() {
        DiscoveryContext context = loadContext();
        return describeChannels(context);
    }

    @TestVisible
    private static List<Map<String, Object>> describeChannelsForTest(DiscoveryContext context) {
        return describeChannels(context);
    }

    private static DiscoveryContext loadContext() {
        DiscoveryContext context = new DiscoveryContext();
        context.channels = [
            SELECT Id, MasterLabel, DeveloperName, MessageType, RoutingType, SessionHandlerId, FallbackQueueId
            FROM MessagingChannel
            WITH USER_MODE ORDER BY MasterLabel ASC
        ];
        loadQueueNames(context);
        loadFlowNames(context);
        loadTargetFlow(context);
        loadHoldingQueue(context);
        return context;
    }

    private static void loadQueueNames(DiscoveryContext context) {
        Set<Id> queueIds = new Set<Id>();
        for (MessagingChannel channel : context.channels) {
            if (channel.FallbackQueueId != null) { queueIds.add(channel.FallbackQueueId); }
            if (isQueueId(channel.SessionHandlerId)) { queueIds.add(channel.SessionHandlerId); }
        }
        if (!queueIds.isEmpty()) {
            context.queuesById = new Map<Id, Group>([
                SELECT Id, Name, DeveloperName FROM Group WHERE Id IN :queueIds WITH USER_MODE
            ]);
        }
    }

    private static Boolean isQueueId(Id recordId) {
        return recordId != null && String.valueOf(recordId).startsWith('00G');
    }

    private static void loadFlowNames(DiscoveryContext context) {
        Set<String> flowIds = new Set<String>();
        for (MessagingChannel channel : context.channels) {
            if (isFlowId(channel.SessionHandlerId)) { flowIds.add(String.valueOf(channel.SessionHandlerId)); }
        }
        if (flowIds.isEmpty()) { return; }
        try {
            for (FlowDefinitionView flow : [
                SELECT DurableId, ApiName, Label FROM FlowDefinitionView WHERE DurableId IN :flowIds WITH USER_MODE
            ]) {
                context.flowNamesById.put(flow.DurableId, flow.Label + ' (' + flow.ApiName + ')');
            }
        } catch (Exception ex) {
            System.debug('FlowDefinitionView handler query note: ' + ex.getMessage());
        }
    }

    private static Boolean isFlowId(Id recordId) {
        return recordId != null && String.valueOf(recordId).startsWith('300');
    }

    private static void loadTargetFlow(DiscoveryContext context) {
        try {
            List<FlowDefinitionView> targetFlows = [
                SELECT DurableId, ApiName, Label
                FROM FlowDefinitionView
                WHERE ApiName = :SessionFieldsProvisioningService.OMNI_FLOW_API_NAME
                WITH USER_MODE LIMIT 1
            ];
            if (targetFlows.isEmpty()) { return; }
            FlowDefinitionView targetFlow = targetFlows[0];
            context.targetFlowId = targetFlow.DurableId;
            context.targetFlowName = targetFlow.Label + ' (' + targetFlow.ApiName + ')';
            context.flowNamesById.put(targetFlow.DurableId, context.targetFlowName);
        } catch (Exception ex) {
            System.debug('FlowDefinitionView target query note: ' + ex.getMessage());
        }
    }

    private static void loadHoldingQueue(DiscoveryContext context) {
        List<Group> holdingQueues = [
            SELECT Id, Name, DeveloperName
            FROM Group
            WHERE Type = 'Queue' AND DeveloperName = :HOLDING_QUEUE_NAME
            WITH USER_MODE LIMIT 1
        ];
        if (holdingQueues.isEmpty()) { return; }
        context.holdingQueueId = holdingQueues[0].Id;
        context.holdingQueueName = holdingQueues[0].Name + ' (' + holdingQueues[0].DeveloperName + ')';
    }

    private static List<Map<String, Object>> describeChannels(DiscoveryContext context) {
        List<Map<String, Object>> rows = new List<Map<String, Object>>();
        for (MessagingChannel channel : context.channels) {
            rows.add(describeChannel(channel, context));
        }
        return rows;
    }

    private static Map<String, Object> describeChannel(MessagingChannel channel, DiscoveryContext context) {
        Map<String, Object> row = new Map<String, Object>{
            'id' => channel.Id,
            'label' => channel.MasterLabel,
            'developerName' => channel.DeveloperName,
            'messageType' => channel.MessageType,
            'sessionHandlerId' => channel.SessionHandlerId,
            'fallbackQueueId' => channel.FallbackQueueId
        };
        Map<String, Object> handler = describeHandler(channel.SessionHandlerId, context);
        Group fallbackQueue = context.queuesById.get(channel.FallbackQueueId);
        row.put('routingTypeLabel', handler.get('routingTypeLabel'));
        row.put('handlerName', handler.get('handlerName'));
        row.put('isFlow', handler.get('isFlow'));
        row.put('fallbackQueueName', fallbackQueue == null ? 'None' : queueLabel(fallbackQueue));
        row.put('isTargetOmniFlow', context.targetFlowId != null &&
            String.valueOf(channel.SessionHandlerId) == String.valueOf(context.targetFlowId) &&
            channel.FallbackQueueId == context.holdingQueueId);
        row.put('holdingQueueAvailable', context.holdingQueueId != null);
        row.put('holdingQueueName', context.holdingQueueName);
        row.put('omniFlowAvailable', context.targetFlowId != null);
        row.put('omniFlowName', context.targetFlowName);
        return row;
    }

    private static Map<String, Object> describeHandler(Id handlerId, DiscoveryContext context) {
        if (handlerId == null) { return handlerDetails('Unassigned', 'None', false); }
        String key = String.valueOf(handlerId);
        if (isQueueId(handlerId)) {
            Group queue = context.queuesById.get(handlerId);
            return handlerDetails('Omni-Queue', queue == null ? 'Queue (' + key + ')' : queueLabel(queue), false);
        }
        if (isFlowId(handlerId)) {
            String flowName = context.flowNamesById.containsKey(key) ? context.flowNamesById.get(key) : 'Flow (' + key + ')';
            return handlerDetails('Omni-Flow', flowName, true);
        }
        return handlerDetails('Other (' + key + ')', key, false);
    }

    private static Map<String, Object> handlerDetails(String routingType, String name, Boolean isFlow) {
        return new Map<String, Object>{ 'routingTypeLabel' => routingType, 'handlerName' => name, 'isFlow' => isFlow };
    }

    private static String queueLabel(Group queue) {
        return queue.Name + ' (' + queue.DeveloperName + ')';
    }
}
