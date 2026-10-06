/** Reads and deploys the package routing custom metadata using the live org schema. */
public with sharing class TubotSettingsMetadataService {
    private class SettingsSchema {
        private String objectName;
        private Map<String, Schema.SObjectField> fields = new Map<String, Schema.SObjectField>();
        private Map<String, String> apiNames = new Map<String, String>();
    }

    private class MetadataBuildContext {
        private SettingsSchema schema;
        private Map<String, String> fieldNames;
        private Map<String, String> values;
        private String recordName;
        private String recordLabel;
    }

    public static Map<String, Object> getSettings() {
        Map<String, Object> result = defaultSettings();
        try {
            SettingsSchema schema = describeSettings();
            if (schema.objectName != null) {
                SObject record = queryDefaultOrFirst(schema);
                if (record != null) { addRecordValues(result, schema, record); }
            }
            result.put('success', true);
        } catch (Exception ex) {
            result.put('success', false);
            result.put('error', ex.getMessage());
        }
        return result;
    }

    public static Map<String, Object> saveSettings(String settingsJson) {
        Map<String, Object> result = new Map<String, Object>();
        try {
            Map<String, Object> input = String.isBlank(settingsJson)
                ? new Map<String, Object>()
                : (Map<String, Object>) JSON.deserializeUntyped(settingsJson);
            Map<String, String> values = normalizeInput(input);
            SettingsSchema schema = describeSettings();
            Map<String, String> fieldNames = TubotSettingsSchemaResolver.resolveWriteFields(schema.apiNames);
            String recordName = existingRecordName(schema, 'DeveloperName', 'Default');
            String recordLabel = existingRecordName(schema, 'MasterLabel', 'Default');
            MetadataBuildContext context = new MetadataBuildContext();
            context.schema = schema;
            context.fieldNames = fieldNames;
            context.values = values;
            context.recordName = recordName;
            context.recordLabel = recordLabel;
            Metadata.CustomMetadata metadata = buildMetadata(context);
            Id jobId = enqueueDeployment(metadata);
            result.put('success', true);
            result.put('jobId', jobId);
            result.putAll(values);
            result.put('recordFullName', metadata.fullName);
            result.put('message', 'Successfully saved AI Routing and Tubot Settings Custom Metadata.');
        } catch (Exception ex) {
            result.put('success', false);
            result.put('error', ex.getMessage());
        }
        return result;
    }

    private static Map<String, Object> defaultSettings() {
        return new Map<String, Object>{
            'success' => false,
            'developerName' => 'Default',
            'label' => 'Default',
            'fallbackQueueApiName' => '',
            'aiRouting' => '',
            'queuesAndSkills' => '',
            'varFlowHuman' => '',
            'objectName' => 'Tubot_Setting__mdt'
        };
    }

    private static SettingsSchema describeSettings() {
        Map<String, Object> description = TubotSettingsSchemaResolver.describeSettings();
        SettingsSchema schema = new SettingsSchema();
        schema.objectName = (String) description.get('objectName');
        schema.apiNames = (Map<String, String>) description.get('apiNames');
        if (schema.objectName != null) {
            schema.fields = (Map<String, Schema.SObjectField>) description.get('fields');
        }
        return schema;
    }

    private static SObject queryDefaultOrFirst(SettingsSchema schema) {
        List<String> selectedFields = new List<String>{ 'Id', 'DeveloperName', 'MasterLabel' };
        addSelectField(selectedFields, schema.apiNames.get('fallbackQueueApiName'));
        addSelectField(selectedFields, schema.apiNames.get('aiRouting'));
        addSelectField(selectedFields, schema.apiNames.get('queuesAndSkills'));
        addSelectField(selectedFields, schema.apiNames.get('varFlowHuman'));
        String fields = String.escapeSingleQuotes(String.join(selectedFields, ', '));
        String objectName = String.escapeSingleQuotes(schema.objectName);
        List<SObject> records = Database.query('SELECT ' + fields + ' FROM ' + objectName + ' WHERE DeveloperName = \'Default\' LIMIT 1');
        if (!records.isEmpty()) { return records[0]; }
        records = Database.query('SELECT ' + fields + ' FROM ' + objectName + ' LIMIT 1');
        return records.isEmpty() ? null : records[0];
    }

    private static void addSelectField(List<String> selectedFields, String fieldName) {
        if (String.isNotBlank(fieldName) && !selectedFields.contains(fieldName)) { selectedFields.add(fieldName); }
    }

    private static void addRecordValues(Map<String, Object> result, SettingsSchema schema, SObject record) {
        result.put('developerName', record.get('DeveloperName'));
        result.put('label', record.get('MasterLabel'));
        result.put('fallbackQueueApiName', settingValue(record, schema.apiNames.get('fallbackQueueApiName')));
        result.put('aiRouting', settingValue(record, schema.apiNames.get('aiRouting')));
        result.put('queuesAndSkills', settingValue(record, schema.apiNames.get('queuesAndSkills')));
        result.put('varFlowHuman', settingValue(record, schema.apiNames.get('varFlowHuman')));
        result.put('objectName', schema.objectName);
    }

    private static Object settingValue(SObject record, String fieldName) {
        if (String.isBlank(fieldName)) { return ''; }
        Object value = record.get(fieldName);
        return value == null ? '' : value;
    }

    private static Map<String, String> normalizeInput(Map<String, Object> input) {
        Map<String, String> values = new Map<String, String>();
        for (String name : new List<String>{ 'fallbackQueueApiName', 'aiRouting', 'queuesAndSkills', 'varFlowHuman' }) {
            Object rawValue = input == null ? null : input.get(name);
            values.put(name, rawValue == null ? '' : String.valueOf(rawValue).trim());
        }
        return values;
    }

    private static String existingRecordName(SettingsSchema schema, String fieldName, String fallback) {
        if (schema.objectName == null) { return fallback; }
        try {
            String safeFieldName = String.escapeSingleQuotes(fieldName);
            String safeObjectName = String.escapeSingleQuotes(schema.objectName);
            List<SObject> records = Database.query('SELECT ' + safeFieldName + ' FROM ' + safeObjectName + ' LIMIT 1');
            if (!records.isEmpty() && String.isNotBlank((String) records[0].get(fieldName))) {
                return (String) records[0].get(fieldName);
            }
        } catch (Exception ex) {
            System.debug('Existing custom metadata record query note: ' + ex.getMessage());
        }
        return fallback;
    }

    private static Metadata.CustomMetadata buildMetadata(MetadataBuildContext context) {
        String entityName = context.schema.objectName == null ? 'Tubot_Setting' : context.schema.objectName.removeEndIgnoreCase('__mdt');
        Metadata.CustomMetadata metadata = new Metadata.CustomMetadata();
        metadata.fullName = entityName + '.' + context.recordName;
        metadata.label = String.isNotBlank(context.recordLabel) ? context.recordLabel : 'Default';
        addMetadataValue(metadata, context.fieldNames.get('fallbackQueueApiName'), context.values.get('fallbackQueueApiName'));
        addMetadataValue(metadata, context.fieldNames.get('aiRouting'), context.values.get('aiRouting'));
        addMetadataValue(metadata, context.fieldNames.get('queuesAndSkills'), context.values.get('queuesAndSkills'));
        addMetadataValue(metadata, context.fieldNames.get('varFlowHuman'), context.values.get('varFlowHuman'));
        return metadata;
    }

    private static void addMetadataValue(Metadata.CustomMetadata metadata, String fieldName, String value) {
        if (String.isBlank(fieldName)) { return; }
        Metadata.CustomMetadataValue fieldValue = new Metadata.CustomMetadataValue();
        fieldValue.field = fieldName;
        fieldValue.value = value;
        metadata.values.add(fieldValue);
    }

    private static Id enqueueDeployment(Metadata.CustomMetadata recordMetadata) {
        Metadata.DeployContainer container = new Metadata.DeployContainer();
        container.addMetadata(recordMetadata);
        if (Test.isRunningTest()) { return '0Af000000000001AAA'; }
        return Metadata.Operations.enqueueDeployment(container, new SessionFieldsProvisioningService.TubotMetadataDeployCallback());
    }
}
