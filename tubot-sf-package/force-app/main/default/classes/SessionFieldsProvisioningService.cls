/**
 * @description Defines MessagingSession field metadata and reads current MessagingChannel settings.
 */
public with sharing class SessionFieldsProvisioningService {

    private static final String FIELD_ESCALATE_TO_HUMAN = 'Escalate_To_Human__c';
    private static final String FIELD_ESCALATION_REASON = 'Escalation_Reason__c';
    private static final String FIELD_AI_CONVERSATION_SUMMARY = 'AI_Conversation_Summary__c';
    private static final String FIELD_VAR_SKILL_LEVEL = 'varSkillLevel__c';
    private static final String FIELD_VAR_TARGET_SKILL_NAME = 'varTargetSkillName__c';
    private static final String FIELD_VAR_TARGET_QUEUE_NAME = 'varTargetQueueName__c';
    private static final String FIELD_VAR_ROUTING = 'varRouting__c';
    private static final String FIELD_VAR_FLOW_HUMAN = 'varFlowHuman__c';

    public static final String OMNI_FLOW_API_NAME = 't2';


    public static final String DEFAULT_AI_PERM_SET = 'AI_Integration_Permissions';
    public static final String DEFAULT_AGENT_PERM_SET = 'Omni_Channel_Messaging_Agent';

    public class FieldDefinitionSpec {
        public String apiName;
        public String label;
        public String type;
        public Object defaultValue;
        public Integer length;
        public Integer visibleLines;
        public Integer precision;
        public Integer scale;
        public String description;

        public FieldDefinitionSpec(Map<String, Object> definition) {
            this.apiName = (String) definition.get('apiName');
            this.label = (String) definition.get('label');
            this.type = (String) definition.get('type');
            this.defaultValue = definition.get('defaultValue');
            this.length = (Integer) definition.get('length');
            this.visibleLines = (Integer) definition.get('visibleLines');
            this.precision = (Integer) definition.get('precision');
            this.scale = (Integer) definition.get('scale');
            this.description = (String) definition.get('description');
        }
    }

    public static List<FieldDefinitionSpec> getRequiredFieldSpecs() {
        return new List<FieldDefinitionSpec>{
            new FieldDefinitionSpec(new Map<String, Object>{
                'apiName' => FIELD_ESCALATE_TO_HUMAN, 'label' => 'Escalate To Human', 'type' => 'Checkbox',
                'defaultValue' => false, 'description' => 'Indicates whether the AI conversation requested escalation to a human agent.'
            }),
            new FieldDefinitionSpec(new Map<String, Object>{
                'apiName' => FIELD_ESCALATION_REASON, 'label' => 'Escalation Reason', 'type' => 'Text',
                'length' => 255, 'description' => 'Reason for human agent escalation provided by AI.'
            }),
            new FieldDefinitionSpec(new Map<String, Object>{
                'apiName' => FIELD_AI_CONVERSATION_SUMMARY, 'label' => 'AI Conversation Summary', 'type' => 'LongTextArea',
                'length' => 32768, 'visibleLines' => 3,
                'description' => 'AI-generated summary of customer conversation prior to escalation.'
            }),
            new FieldDefinitionSpec(new Map<String, Object>{
                'apiName' => FIELD_VAR_SKILL_LEVEL, 'label' => 'varSkillLevel', 'type' => 'Number',
                'precision' => 4, 'scale' => 2, 'description' => 'Target skill level required for omni-channel routing.'
            }),
            new FieldDefinitionSpec(new Map<String, Object>{
                'apiName' => FIELD_VAR_TARGET_SKILL_NAME, 'label' => 'varTargetSkillName', 'type' => 'Text',
                'length' => 255, 'description' => 'Developer name or identifier of target skill for routing.'
            }),
            new FieldDefinitionSpec(new Map<String, Object>{
                'apiName' => FIELD_VAR_TARGET_QUEUE_NAME, 'label' => 'varTargetQueueName', 'type' => 'Text',
                'length' => 255, 'description' => 'Developer name or identifier of target queue for routing.'
            }),
            new FieldDefinitionSpec(new Map<String, Object>{
                'apiName' => FIELD_VAR_ROUTING, 'label' => 'varRouting', 'type' => 'Text',
                'defaultValue' => '"Chat_Routing_Config"', 'length' => 255,
                'description' => 'Developer name of target routing configuration or fallback routing configuration (fallback/placeholder: Chat_Routing_Config).'
            }),
            new FieldDefinitionSpec(new Map<String, Object>{
                'apiName' => FIELD_VAR_FLOW_HUMAN, 'label' => 'varFlowHuman', 'type' => 'Text',
                'length' => 255, 'description' => 'Developer name or identifier of target flow or human routing flow for MessagingSession.'
            })
        };
    }

    /**
     * @description Detects package namespace prefix if running inside a namespaced org.
     */
    public static String getNamespacePrefix() {
        String clsName = SessionFieldsProvisioningService.class.getName();
        if (clsName.contains('.')) {
            return clsName.substringBefore('.') + '__';
        }
        return '';
    }

    /**
     * @description Resolves qualified API name for standard or namespaced custom field.
     */
    public static String resolveFieldApiName(String baseFieldName, Map<String, Schema.SObjectField> fieldMap) {
        if (fieldMap == null) {
            fieldMap = Schema.sObjectType.MessagingSession.fields.getMap();
        }
        String lower = baseFieldName.toLowerCase();
        if (fieldMap.containsKey(lower)) {
            return fieldMap.get(lower).getDescribe().getName();
        }
        String ns = getNamespacePrefix().toLowerCase();
        if (String.isNotBlank(ns) && fieldMap.containsKey(ns + lower)) {
            return fieldMap.get(ns + lower).getDescribe().getName();
        }
        for (String key : fieldMap.keySet()) {
            if (key.endsWith('__' + lower)) {
                return fieldMap.get(key).getDescribe().getName();
            }
        }
        return (String.isNotBlank(ns) ? getNamespacePrefix() + baseFieldName : baseFieldName);
    }

    /**
     * @description Checks whether field is present in MessagingSession schema map (with or without namespace).
     */
    public static Boolean isFieldInSchema(String baseFieldName, Map<String, Schema.SObjectField> fieldMap) {
        if (fieldMap == null) {
            fieldMap = Schema.sObjectType.MessagingSession.fields.getMap();
        }
        String lower = baseFieldName.toLowerCase();
        if (fieldMap.containsKey(lower)) {
            return true;
        }
        String ns = getNamespacePrefix().toLowerCase();
        if (String.isNotBlank(ns) && fieldMap.containsKey(ns + lower)) {
            return true;
        }
        for (String key : fieldMap.keySet()) {
            if (key.endsWith('__' + lower)) {
                return true;
            }
        }
        return false;
    }

    /**
     * @description Returns all MessagingChannels and whether each uses the package's
     * Omni-Flow configuration: flow t2 with AI_Bot_Holding_Queue_100 as fallback.
     */
    @AuraEnabled
    public static List<Map<String, Object>> getMessagingChannels() {
        requireSettingsAdmin();
        return MessagingChannelDiscoveryService.getChannels();
    }

    /** Handles asynchronous deployment results for packaged settings metadata. */
    public class TubotMetadataDeployCallback implements Metadata.DeployCallback {
        public void handleResult(Metadata.DeployResult result, Metadata.DeployCallbackContext context) {
            if (result != null && result.status == Metadata.DeployStatus.Succeeded) {
                System.debug('Tubot_Setting__mdt custom metadata deployment succeeded.');
            } else if (result != null) {
                System.debug('Tubot_Setting__mdt custom metadata deployment status: ' + result.status + ', error: ' + result.errorMessage);
                if (result.details != null && result.details.componentFailures != null) {
                    for (Metadata.DeployMessage failure : result.details.componentFailures) {
                        System.debug('Component failure: ' + failure.problem);
                    }
                }
            }
        }
    }

    private static void requireSettingsAdmin() {
        PanelAuthSupportService.requireSettingsAdmin();
    }

}
