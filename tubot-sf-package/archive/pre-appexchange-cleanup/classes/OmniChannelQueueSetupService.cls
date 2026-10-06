/** Creates queues and their MessagingSession routing association. */
public with sharing class OmniChannelQueueSetupService {
    public class QueueSetupRequest {
        public String queueDeveloperName;
        public String queueLabel;
        public String routingConfigDeveloperName;
        public List<String> logs;
    }

    public static Group setup(QueueSetupRequest request) {
        if (request == null) {
            throw new IllegalArgumentException('Queue setup details are required.');
        }
        List<String> logs = request.logs == null ? new List<String>() : request.logs;
        String queueDeveloperName = String.isBlank(request.queueDeveloperName) ? 'Chat_Queue' : request.queueDeveloperName;
        String queueLabel = String.isBlank(request.queueLabel) ? 'Chat Queue' : request.queueLabel;
        Id routingConfigId = resolveRoutingConfig(request.routingConfigDeveloperName, logs);
        request.queueDeveloperName = queueDeveloperName;
        request.queueLabel = queueLabel;
        request.logs = logs;
        Group queue = resolveOrCreateQueue(request, routingConfigId);
        ensureMessagingSessionAssociation(queue, logs);
        return queue;
    }

    private static Id resolveRoutingConfig(String developerName, List<String> logs) {
        if (String.isBlank(developerName)) {
            return null;
        }
        Schema.SObjectType routingConfigType = Schema.getGlobalDescribe().get('QueueRoutingConfig');
        if (routingConfigType == null) {
            logs.add('Notice: QueueRoutingConfig is not available in this org.');
            return null;
        }
        List<SObject> configs = Database.queryWithBinds(
            'SELECT Id FROM QueueRoutingConfig WHERE DeveloperName = :developerName LIMIT 1',
            new Map<String, Object>{ 'developerName' => developerName },
            AccessLevel.USER_MODE
        );
        if (configs.isEmpty()) {
            logs.add('Notice: QueueRoutingConfig "' + developerName + '" not found in org.');
            return null;
        }
        return (Id) configs[0].get('Id');
    }

    private static Group resolveOrCreateQueue(QueueSetupRequest request, Id routingConfigId) {
        Map<String, Schema.SObjectField> groupFields = Schema.SObjectType.Group.fields.getMap();
        Boolean hasRoutingConfigField = groupFields.containsKey('QueueRoutingConfigId');
        ensureRoutingConfigurationField(routingConfigId, hasRoutingConfigField);
        Group existingQueue = findExistingQueue(request, routingConfigId, hasRoutingConfigField);
        return existingQueue == null ? createQueue(request, routingConfigId, hasRoutingConfigField) : existingQueue;
    }

    private static void ensureRoutingConfigurationField(Id routingConfigId, Boolean hasRoutingConfigField) {
        if (routingConfigId != null && !hasRoutingConfigField) {
            throw new AuraHandledException('This org cannot associate a queue with a routing configuration.');
        }
    }

    private static Group findExistingQueue(QueueSetupRequest request, Id routingConfigId, Boolean hasRoutingConfigField) {
        List<SObject> queues = Database.queryWithBinds(buildQueueQuery(hasRoutingConfigField), new Map<String, Object>{
            'queueType' => 'Queue',
            'queueDeveloperName' => request.queueDeveloperName
        }, AccessLevel.USER_MODE);
        if (queues.isEmpty()) { return null; }
        Group queue = (Group) queues[0];
        request.logs.add('Resolved existing Queue: ' + queue.Name + ' (' + queue.DeveloperName + ', Id: ' + queue.Id + ')');
        updateQueueRoutingConfiguration(queue, request, routingConfigId);
        return queue;
    }

    private static String buildQueueQuery(Boolean hasRoutingConfigField) {
        String queueQuery = 'SELECT Id, Name, DeveloperName, Type';
        if (hasRoutingConfigField) { queueQuery += ', QueueRoutingConfigId'; }
        return queueQuery + ' FROM Group WHERE Type = :queueType AND DeveloperName = :queueDeveloperName LIMIT 1';
    }

    private static void updateQueueRoutingConfiguration(Group queue, QueueSetupRequest request, Id routingConfigId) {
        if (routingConfigId == null || (Id) queue.get('QueueRoutingConfigId') == routingConfigId) { return; }
        queue.put('QueueRoutingConfigId', routingConfigId);
        Database.update(queue, AccessLevel.USER_MODE);
        request.logs.add('Linked Queue to QueueRoutingConfig ' + request.routingConfigDeveloperName + ' (Id: ' + routingConfigId + ')');
    }

    private static Group createQueue(QueueSetupRequest request, Id routingConfigId, Boolean hasRoutingConfigField) {
        Group newQueue = new Group(
            Name = request.queueLabel,
            DeveloperName = request.queueDeveloperName,
            Type = 'Queue'
        );
        if (hasRoutingConfigField) { newQueue.put('QueueRoutingConfigId', routingConfigId); }
        Database.insert(newQueue, AccessLevel.USER_MODE);
        String routingNote = routingConfigId == null ? '' : ' with QueueRoutingConfig ' + request.routingConfigDeveloperName;
        request.logs.add('Created new Queue: ' + request.queueLabel + ' (' + request.queueDeveloperName + ', Id: ' + newQueue.Id + ')' + routingNote);
        return newQueue;
    }

    private static void ensureMessagingSessionAssociation(Group queue, List<String> logs) {
        List<QueueSobject> existingAssociations = [
            SELECT Id
            FROM QueueSobject
            WHERE QueueId = :queue.Id AND SobjectType = 'MessagingSession'
            WITH USER_MODE
            LIMIT 1
        ];
        if (!existingAssociations.isEmpty()) {
            logs.add('Queue is already bound to MessagingSession (QueueSobject Id: ' + existingAssociations[0].Id + ')');
            return;
        }
        try {
            QueueSobject association = new QueueSobject(QueueId = queue.Id, SobjectType = 'MessagingSession');
            Database.insert(association, AccessLevel.USER_MODE);
            logs.add('Bound Queue to MessagingSession via QueueSobject (Id: ' + association.Id + ')');
        } catch (Exception ex) {
            logs.add('QueueSobject association notice: ' + ex.getMessage());
        }
    }
}
