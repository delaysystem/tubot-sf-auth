/** Discovers the installed Tubot custom metadata and its namespaced field API names. */
public with sharing class TubotSettingsSchemaResolver {
    private static final List<String> LOGICAL_FIELDS = new List<String>{
        'Fallback_Queue_Api_Name__c', 'AI_Routing__c', 'Queues_and_Skills__c', 'varFlowHuman__c'
    };
    private static final String FALLBACK_FIELD = 'Fallback_Queue_Api_Name__c';
    private static final String AI_ROUTING_FIELD = 'AI_Routing__c';
    private static final String QUEUES_FIELD = 'Queues_and_Skills__c';

    public static Map<String, Object> describeSettings() {
        Map<String, Object> result = new Map<String, Object>();
        Map<String, Schema.SObjectType> globalDescribe = Schema.getGlobalDescribe();
        String objectName = findObjectName(globalDescribe);
        result.put('objectName', objectName);
        Map<String, String> apiNames = new Map<String, String>();
        result.put('apiNames', apiNames);
        if (objectName == null) { return result; }
        Map<String, Schema.SObjectField> fields = globalDescribe.get(objectName.toLowerCase()).getDescribe().fields.getMap();
        result.put('fields', fields);
        for (String fieldName : LOGICAL_FIELDS) {
            apiNames.put(outputName(fieldName), resolveFieldName(fields, fieldName));
        }
        return result;
    }

    public static Map<String, String> resolveWriteFields(Map<String, String> discoveredNames) {
        Map<String, String> fields = new Map<String, String>(discoveredNames);
        if (String.isBlank(fields.get('fallbackQueueApiName'))) { fields.put('fallbackQueueApiName', FALLBACK_FIELD); }
        if (String.isBlank(fields.get('aiRouting'))) { fields.put('aiRouting', AI_ROUTING_FIELD); }
        if (String.isBlank(fields.get('queuesAndSkills'))) { fields.put('queuesAndSkills', QUEUES_FIELD); }
        return fields;
    }

    private static String findObjectName(Map<String, Schema.SObjectType> globalDescribe) {
        if (globalDescribe.containsKey('tubot_setting__mdt')) { return 'Tubot_Setting__mdt'; }
        if (globalDescribe.containsKey('tubot__tubot_setting__mdt')) { return 'tubot__Tubot_Setting__mdt'; }
        for (String key : globalDescribe.keySet()) {
            if (key.endsWith('tubot_setting__mdt')) { return key; }
        }
        return null;
    }

    private static String resolveFieldName(Map<String, Schema.SObjectField> fieldMap, String logicalName) {
        String key = logicalName.toLowerCase();
        if (fieldMap.containsKey(key)) { return fieldMap.get(key).getDescribe().getName(); }
        for (String candidate : fieldMap.keySet()) {
            if (candidate.endsWith(key)) { return fieldMap.get(candidate).getDescribe().getName(); }
        }
        return null;
    }

    private static String outputName(String fieldName) {
        if (fieldName == 'Fallback_Queue_Api_Name__c') { return 'fallbackQueueApiName'; }
        if (fieldName == 'AI_Routing__c') { return 'aiRouting'; }
        if (fieldName == 'Queues_and_Skills__c') { return 'queuesAndSkills'; }
        return 'varFlowHuman';
    }
}
