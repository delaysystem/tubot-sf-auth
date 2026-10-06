/** Restores Messaging Channel routing and QueueSobject links. */
public with sharing class MessagingBackupRestoreRoutingService {
    private class FieldChange {
        private String field;
        private Object currentValue;
        private Object savedValue;

        private FieldChange(String field, Object currentValue, Object savedValue) {
            this.field = field;
            this.currentValue = currentValue;
            this.savedValue = savedValue;
        }
    }

    @TestVisible
    private class ChannelContext {
        @TestVisible
        private String baseUrl;
        @TestVisible
        private List<String> logs;
        @TestVisible
        private Map<String, SObject> current = new Map<String, SObject>();
    }

    public static void restoreMessagingChannels(List<Object> snapshots, String baseUrl, List<String> logs) {
        ChannelContext context = new ChannelContext();
        context.baseUrl = baseUrl;
        context.logs = logs;
        context.current = loadCurrentChannels();
        for (Object value : snapshots) { restoreChannel(context, (Map<String, Object>) value); }
    }

    private static Map<String, SObject> loadCurrentChannels() {
        Map<String, SObject> current = new Map<String, SObject>();
        Map<String, Schema.SObjectField> fields = Schema.SObjectType.MessagingChannel.fields.getMap();
        Boolean hasRoutingConfiguration = fields.containsKey('RoutingConfigurationId');
        String query = 'SELECT Id, DeveloperName, SessionHandlerId, FallbackQueueId, RoutingType, TargetQueueId';
        if (hasRoutingConfiguration) { query += ', RoutingConfigurationId'; }
        query += ' FROM MessagingChannel';
        for (SObject channel : Database.query(query, AccessLevel.USER_MODE)) {
            current.put(((String) channel.get('DeveloperName')).toLowerCase(), channel);
        }
        return current;
    }

    @TestVisible
    private static void restoreChannel(ChannelContext context, Map<String, Object> snapshot) {
        String developerName = (String) snapshot.get('developerName');
        SObject current = String.isBlank(developerName) ? null : context.current.get(developerName.toLowerCase());
        if (current == null) { return; }
        Map<String, Object> patch = routingPatch(current, snapshot);
        if (patch.isEmpty()) {
            context.logs.add('Channel ' + current.get('DeveloperName') + ' already matches the saved routing state.');
            return;
        }
        sendChannelPatch(context, current, patch);
    }

    @TestVisible
    private static Map<String, Object> routingPatch(SObject current, Map<String, Object> snapshot) {
        Map<String, Object> patch = new Map<String, Object>();
        addChangedValue(patch, new FieldChange('SessionHandlerId', current.get('SessionHandlerId'), snapshot.get('sessionHandlerId')));
        addChangedValue(patch, new FieldChange('FallbackQueueId', current.get('FallbackQueueId'), snapshot.get('fallbackQueueId')));
        addChangedValue(patch, new FieldChange('RoutingType', current.get('RoutingType'), snapshot.get('routingType')));
        addChangedValue(patch, new FieldChange('TargetQueueId', current.get('TargetQueueId'), snapshot.get('targetQueueId')));
        if (current.getSObjectType().getDescribe().fields.getMap().containsKey('RoutingConfigurationId')) {
            addChangedValue(patch, new FieldChange('RoutingConfigurationId', current.get('RoutingConfigurationId'), snapshot.get('routingConfigurationId')));
        } else if (snapshot.get('routingConfigurationId') != null) {
            throw new AuraHandledException('This org does not expose MessagingChannel routing configurations required by this backup.');
        }
        if (patch.containsKey('SessionHandlerId') && patch.get('SessionHandlerId') == null) {
            patch.put('FallbackQueueId', null);
        } else if (String.isBlank((String) snapshot.get('sessionHandlerId'))) {
            patch.put('FallbackQueueId', null);
        }
        return patch;
    }

    private static void addChangedValue(Map<String, Object> patch, FieldChange change) {
        if (change.currentValue != change.savedValue) { patch.put(change.field, change.savedValue); }
    }

    @TestVisible
    private static void sendChannelPatch(ChannelContext context, SObject channel, Map<String, Object> patch) {
        String developerName = (String) channel.get('DeveloperName');
        try {
            HttpRequest request = new HttpRequest();
            request.setEndpoint(context.baseUrl + '/services/data/v67.0/sobjects/MessagingChannel/' + channel.get('Id'));
            request.setMethod('PATCH');
            request.setHeader('Content-Type', 'application/json');
            request.setBody(JSON.serialize(patch));
            request.setTimeout(25000);
            HttpResponse response = TuBotSelfOrgApiCallout.send(request);
            if (response.getStatusCode() != 200 && response.getStatusCode() != 204) {
                throw new AuraHandledException('Channel routing restore was rejected (HTTP ' + response.getStatusCode() + ').');
            }
            context.logs.add('Channel ' + developerName + ' routing restored.');
        } catch (Exception ex) {
            context.logs.add('Channel ' + developerName + ' routing restore failed: ' + ex.getMessage());
            throw ex;
        }
    }

    public static void restoreQueues(List<Object> queueObjs, List<Object> queueSobjects, List<String> logs) {
        try {
            Set<String> existing = existingQueueIds();
            List<QueueSobject> pending = missingMessagingSessionQueueLinks(queueSobjects, existing);
            if (!pending.isEmpty()) {
                Database.insert(pending, AccessLevel.USER_MODE);
                logs.add('Restored ' + pending.size() + ' MessagingSession queue links.');
            }
        } catch (Exception ex) {
            logs.add('Queue restore failed: ' + ex.getMessage());
            throw ex;
        }
    }

    private static Set<String> existingQueueIds() {
        Set<String> existing = new Set<String>();
        for (QueueSobject link : [
            SELECT QueueId FROM QueueSobject WHERE SobjectType = 'MessagingSession' WITH USER_MODE
        ]) { existing.add(String.valueOf(link.QueueId)); }
        return existing;
    }

    @TestVisible
    private static List<QueueSobject> missingMessagingSessionQueueLinks(List<Object> snapshots, Set<String> existing) {
        List<QueueSobject> pending = new List<QueueSobject>();
        if (snapshots == null) { return pending; }
        for (Object value : snapshots) {
            Map<String, Object> item = (Map<String, Object>) value;
            String queueId = (String) item.get('queueId');
            if (item.get('sobjectType') == 'MessagingSession' && String.isNotBlank(queueId) && !existing.contains(queueId)) {
                pending.add(new QueueSobject(QueueId = queueId, SobjectType = 'MessagingSession'));
            }
        }
        return pending;
    }
}
