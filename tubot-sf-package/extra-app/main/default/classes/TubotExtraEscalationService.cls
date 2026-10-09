/** Applies escalation fields to an existing Messaging Session. */
public with sharing class TubotExtraEscalationService {
    private static final String DEFAULT_QUEUE = 'Chat_Queue';

    public static Map<String, Object> escalate(String requestJson) {
        Map<String, Object> result = new Map<String, Object>{ 'success' => false };
        try {
            Map<String, Object> request = parseRequest(requestJson);
            Id sessionId = parseSessionId(request.get('sessionId'));
            if (sessionId == null || sessionId.getSObjectType() != MessagingSession.SObjectType) {
                return errorResult('A valid Messaging Session ID is required.');
            }

            MessagingSession session = [
                SELECT Id
                FROM MessagingSession
                WHERE Id = :sessionId
                WITH USER_MODE
                LIMIT 1
            ];

            String queueName = normalizedQueue(request.get('varTargetQueueName'));
            String routing = normalizedText(request.get('varRouting'));
            String targetSkill = normalizedText(request.get('varTargetSkillName'));
            String flowHuman = normalizedText(request.get('varFlowHuman'));
            Boolean usedFallbackQueue = false;
            if (String.isBlank(queueName) && String.isBlank(routing) &&
                request.get('varSkillLevel') == null && String.isBlank(targetSkill) && String.isBlank(flowHuman)) {
                queueName = DEFAULT_QUEUE;
                usedFallbackQueue = true;
            }

            session.put('Escalate_To_Human__c', true);
            putWhenPresent(session, 'Escalation_Reason__c', normalizedText(request.get('reason')));
            putWhenPresent(session, 'AI_Conversation_Summary__c', normalizedText(request.get('summary')));
            putWhenPresent(session, 'varTargetQueueName__c', queueName);
            putWhenPresent(session, 'varRouting__c', routing);
            putWhenPresent(session, 'varSkillLevel__c', parseSkillLevel(request.get('varSkillLevel')));
            putWhenPresent(session, 'varTargetSkillName__c', targetSkill);
            putWhenPresent(session, 'varFlowHuman__c', flowHuman);

            Database.update(session, AccessLevel.USER_MODE);

            result.put('success', true);
            result.put('sessionId', String.valueOf(session.Id));
            result.put('varTargetQueueName', queueName);
            result.put('varRouting', routing);
            result.put('varTargetSkillName', targetSkill);
            result.put('varFlowHuman', flowHuman);
            result.put('usedFallbackQueue', usedFallbackQueue);
            result.put('message', usedFallbackQueue
                ? 'Messaging Session escalated to a human using the Chat_Queue fallback.'
                : 'Messaging Session escalated to a human.');
            return result;
        } catch (QueryException ex) {
            return errorResult('The Messaging Session could not be found or is not accessible.');
        } catch (Exception ex) {
            return errorResult(ex.getMessage());
        }
    }

    private static Map<String, Object> parseRequest(String requestJson) {
        if (String.isBlank(requestJson)) {
            return new Map<String, Object>();
        }
        Object parsed = JSON.deserializeUntyped(requestJson);
        if (!(parsed instanceof Map<String, Object>)) {
            throw new IllegalArgumentException('The escalation request must be a JSON object.');
        }
        return (Map<String, Object>) parsed;
    }

    private static Id parseSessionId(Object value) {
        if (value == null || String.isBlank(String.valueOf(value))) {
            return null;
        }
        try {
            return (Id) String.valueOf(value);
        } catch (Exception ex) {
            return null;
        }
    }

    private static String normalizedQueue(Object value) {
        String text = normalizedText(value);
        return String.isBlank(text) ? null : text.replaceAll('\\s+', '_');
    }

    private static String normalizedText(Object value) {
        if (value == null) {
            return null;
        }
        String text = String.valueOf(value).trim();
        return String.isBlank(text) ? null : text;
    }

    private static Decimal parseSkillLevel(Object value) {
        if (value == null || String.isBlank(String.valueOf(value))) {
            return null;
        }
        return Decimal.valueOf(String.valueOf(value));
    }

    private static void putWhenPresent(MessagingSession session, String fieldName, Object value) {
        if (value != null) {
            session.put(fieldName, value);
        }
    }

    private static Map<String, Object> errorResult(String message) {
        return new Map<String, Object>{ 'success' => false, 'error' => message };
    }
}
