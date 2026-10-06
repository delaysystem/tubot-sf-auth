/** Applies optional routing details and requests human escalation for one session. */
public with sharing class IGNORE_MessagingSessionEscalationService {
    public static Map<String, Object> escalate(String requestJson) {
        Map<String, Object> context = initialize(requestJson);
        Map<String, Object> result = new Map<String, Object>();
        try {
            ensureSession(context, result);
            if (result.containsKey('error')) { return result; }
            normalizeRouting(context);
            applyFallbackQueue(context);
            updateSession(context);
            return successResult(context);
        } catch (Exception ex) {
            result.put('success', false);
            result.put('error', ex.getMessage());
            return result;
        }
    }

    private static Map<String, Object> initialize(String requestJson) {
        Map<String, Object> request = String.isBlank(requestJson)
            ? new Map<String, Object>() : (Map<String, Object>) JSON.deserializeUntyped(requestJson);
        return new Map<String, Object>{
            'sessionId' => request.get('sessionId'),
            'reason' => request.get('reason'),
            'summary' => request.get('summary'),
            'varTargetQueueName' => request.get('varTargetQueueName'),
            'varRouting' => request.get('varRouting'),
            'varSkillLevel' => request.get('varSkillLevel'),
            'varTargetSkillName' => request.get('varTargetSkillName'),
            'varFlowHuman' => request.get('varFlowHuman'),
            'usedFallbackQueue' => false
        };
    }

    private static void ensureSession(Map<String, Object> context, Map<String, Object> result) {
        if (context.get('sessionId') != null) { return; }
        List<MessagingSession> sessions = [
            SELECT Id, Status FROM MessagingSession WITH USER_MODE ORDER BY CreatedDate DESC LIMIT 1
        ];
        if (sessions.isEmpty()) {
            result.put('success', false);
            result.put('error', 'No MessagingSession record found to escalate.');
            return;
        }
        context.put('sessionId', sessions[0].Id);
    }

    private static void normalizeRouting(Map<String, Object> context) {
        context.put('varTargetQueueName', normalizedQueue((String) context.get('varTargetQueueName')));
        context.put('varRouting', normalizedValue((String) context.get('varRouting')));
        context.put('varTargetSkillName', normalizedValue((String) context.get('varTargetSkillName')));
        context.put('varFlowHuman', normalizedValue((String) context.get('varFlowHuman')));
    }

    private static String normalizedQueue(String value) {
        return String.isBlank(value) ? null : value.trim().replaceAll('\\s+', '_');
    }

    private static String normalizedValue(String value) {
        return String.isBlank(value) ? null : value.trim();
    }

    private static void applyFallbackQueue(Map<String, Object> context) {
        if (!allRoutingEmpty(context)) { return; }
        Map<String, Object> settings = SessionFieldsProvisioningService.getTubotSettings();
        String fallbackQueue = (String) settings.get('fallbackQueueApiName');
        if (String.isBlank(fallbackQueue) || 'AI_Bot_Holding_Queue_100'.equalsIgnoreCase(fallbackQueue.trim())) {
            fallbackQueue = 'Chat_Queue';
        }
        context.put('varTargetQueueName', normalizedQueue(fallbackQueue));
        context.put('usedFallbackQueue', true);
    }

    private static Boolean allRoutingEmpty(Map<String, Object> context) {
        return String.isBlank((String) context.get('varTargetQueueName')) &&
            String.isBlank((String) context.get('varRouting')) &&
            context.get('varSkillLevel') == null &&
            String.isBlank((String) context.get('varTargetSkillName')) &&
            String.isBlank((String) context.get('varFlowHuman'));
    }

    private static void updateSession(Map<String, Object> context) {
        Map<String, Schema.SObjectField> fieldMap = Schema.sObjectType.MessagingSession.fields.getMap();
        MessagingSession session = new MessagingSession(Id = (Id) context.get('sessionId'));
        session.put(fieldApiName('Escalate_To_Human__c', fieldMap), true);
        putWhenPresent(session, fieldApiName('Escalation_Reason__c', fieldMap), context.get('reason'));
        putWhenPresent(session, fieldApiName('AI_Conversation_Summary__c', fieldMap), context.get('summary'));
        putWhenPresent(session, fieldApiName('varTargetQueueName__c', fieldMap), context.get('varTargetQueueName'));
        putWhenPresent(session, fieldApiName('varRouting__c', fieldMap), context.get('varRouting'));
        putWhenPresent(session, fieldApiName('varSkillLevel__c', fieldMap), context.get('varSkillLevel'));
        putWhenPresent(session, fieldApiName('varTargetSkillName__c', fieldMap), context.get('varTargetSkillName'));
        putWhenPresent(session, fieldApiName('varFlowHuman__c', fieldMap), context.get('varFlowHuman'));
        Database.update(session, AccessLevel.USER_MODE);
    }

    private static String fieldApiName(String fieldName, Map<String, Schema.SObjectField> fieldMap) {
        return SessionFieldsProvisioningService.resolveFieldApiName(fieldName, fieldMap);
    }

    private static void putWhenPresent(MessagingSession session, String fieldName, Object value) {
        if (value != null && String.isNotBlank(String.valueOf(value))) { session.put(fieldName, value); }
    }

    private static Map<String, Object> successResult(Map<String, Object> context) {
        String sessionId = String.valueOf(context.get('sessionId'));
        Boolean usedFallback = (Boolean) context.get('usedFallbackQueue');
        String queueName = (String) context.get('varTargetQueueName');
        Map<String, Object> result = new Map<String, Object>{
            'success' => true,
            'sessionId' => sessionId,
            'varTargetQueueName' => queueName,
            'varRouting' => context.get('varRouting'),
            'varSkillLevel' => context.get('varSkillLevel'),
            'varTargetSkillName' => context.get('varTargetSkillName'),
            'varFlowHuman' => context.get('varFlowHuman'),
            'usedFallbackQueue' => usedFallback
        };
        if (usedFallback) {
            result.put('fallbackQueueUsed', queueName);
            result.put('message', 'Messaging Session ' + sessionId + ' escalated to human successfully using fallback queue (' + queueName + '). Flow t100 triggered.');
        } else {
            result.put('message', 'Messaging Session ' + sessionId + ' escalated to human successfully. Flow t100 triggered.');
        }
        return result;
    }
}
