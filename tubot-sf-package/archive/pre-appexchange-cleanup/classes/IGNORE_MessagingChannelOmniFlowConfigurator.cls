/** Applies the package Omni-Flow handler and fallback queue to MessagingChannel records. */
public with sharing class IGNORE_MessagingChannelOmniFlowConfigurator {
    private static final String FALLBACK_QUEUE = 'AI_Bot_Holding_Queue_100';
    private static final String FLOW_API_NAME = 't2';

    private class ConfigurationContext {
        private MessagingChannel channel;
        private FlowDefinitionView flow;
        private Group queue;
        private String previousHandlerId;
    }

    public static Map<String, Object> configure(Id channelId) {
        Map<String, Object> result = new Map<String, Object>{ 'success' => false };
        try {
            if (channelId == null) { return error(result, 'Channel ID cannot be null.'); }
            ConfigurationContext context = new ConfigurationContext();
            context.queue = findFallbackQueue();
            if (context.queue == null) { return error(result, 'Fallback queue ' + FALLBACK_QUEUE + ' does not exist in this org. Ensure package metadata is deployed.'); }
            context.flow = findFlow();
            if (context.flow == null) { return error(result, 'Omni-Flow ' + FLOW_API_NAME + ' does not exist in this org. Ensure package metadata is deployed and the flow is active.'); }
            context.channel = findChannel(channelId);
            if (context.channel == null) { return error(result, 'MessagingChannel record not found for Id: ' + channelId); }
            context.previousHandlerId = String.valueOf(context.channel.SessionHandlerId);
            applyRouting(context);
            return success(context);
        } catch (Exception ex) {
            return error(result, ex.getMessage());
        }
    }

    private static Group findFallbackQueue() {
        List<Group> queues = [
            SELECT Id, Name, DeveloperName
            FROM Group
            WHERE Type = 'Queue' AND DeveloperName = :FALLBACK_QUEUE
            WITH USER_MODE LIMIT 1
        ];
        return queues.isEmpty() ? null : queues[0];
    }

    private static FlowDefinitionView findFlow() {
        List<FlowDefinitionView> flows = [
            SELECT DurableId, ApiName, Label
            FROM FlowDefinitionView
            WHERE ApiName = :FLOW_API_NAME
            WITH USER_MODE LIMIT 1
        ];
        return flows.isEmpty() ? null : flows[0];
    }

    private static MessagingChannel findChannel(Id channelId) {
        List<MessagingChannel> channels = [
            SELECT Id, MasterLabel, DeveloperName, RoutingType, SessionHandlerId, FallbackQueueId
            FROM MessagingChannel WHERE Id = :channelId WITH USER_MODE LIMIT 1
        ];
        return channels.isEmpty() ? null : channels[0];
    }

    private static void applyRouting(ConfigurationContext context) {
        Boolean updated = false;
        try {
            updated = updateViaRest(JSON.serialize(new Map<String, Object>{
                'channelId' => context.channel.Id, 'flowId' => context.flow.DurableId, 'queueId' => context.queue.Id
            }));
        } catch (Exception ex) {
            System.debug('MessagingChannel REST update was unavailable; trying user-mode DML.');
        }
        if (updated) { return; }
        context.channel.RoutingType = null;
        context.channel.SessionHandlerId = (Id) context.flow.DurableId;
        context.channel.FallbackQueueId = context.queue.Id;
        Database.update(context.channel, AccessLevel.USER_MODE);
    }

    @TestVisible
    private static Boolean updateViaRest(String requestJson) {
        Map<String, Object> input = (Map<String, Object>) JSON.deserializeUntyped(requestJson);
        HttpRequest request = new HttpRequest();
        request.setEndpoint(Url.getOrgDomainUrl().toExternalForm() + '/services/data/v67.0/sobjects/MessagingChannel/' + input.get('channelId'));
        request.setMethod('PATCH');
        request.setHeader('Content-Type', 'application/json');
        request.setBody(JSON.serialize(new Map<String, Object>{
            'RoutingType' => null, 'SessionHandlerId' => input.get('flowId'), 'FallbackQueueId' => input.get('queueId')
        }));
        request.setTimeout(25000);
        HttpResponse response = TuBotSelfOrgApiCallout.send(request);
        return response.getStatusCode() == 200 || response.getStatusCode() == 204;
    }

    private static Map<String, Object> success(ConfigurationContext context) {
        MessagingChannel channel = context.channel;
        FlowDefinitionView flow = context.flow;
        Group queue = context.queue;
        return new Map<String, Object>{
            'success' => true, 'channelId' => channel.Id, 'channelLabel' => channel.MasterLabel,
            'channelDevName' => channel.DeveloperName, 'previousHandlerId' => context.previousHandlerId,
            'newRoutingType' => 'Omni-Flow', 'newHandlerId' => flow.DurableId,
            'newHandlerName' => flow.Label + ' (' + flow.ApiName + ')', 'fallbackQueueId' => queue.Id,
            'fallbackQueueName' => queue.Name + ' (' + queue.DeveloperName + ')',
            'message' => 'Configured Messaging Channel "' + channel.MasterLabel + '" for Omni-Flow ' + FLOW_API_NAME +
                ' with fallback queue ' + queue.DeveloperName + '.'
        };
    }

    private static Map<String, Object> error(Map<String, Object> result, String message) {
        result.put('success', false);
        result.put('error', message);
        return result;
    }
}
