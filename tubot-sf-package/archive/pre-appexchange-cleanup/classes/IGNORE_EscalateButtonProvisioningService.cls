/** Coordinates creation of the Escalate quick action and its MessagingSession layouts. */
public with sharing class IGNORE_EscalateButtonProvisioningService {
    private static final String ACTION_LABEL = 'Escalate to Human';

    public static Map<String, Object> provision() {
        Map<String, Object> context = initialize();
        try {
            logFieldStatus(context);
            EscalateQuickActionService.provision(context);
            SessionLayoutActionService.assignToLayouts(context);
            complete(context);
        } catch (Exception ex) {
            fail(context, ex);
        }
        return (Map<String, Object>) context.get('result');
    }

    private static Map<String, Object> initialize() {
        String baseUrl = Url.getOrgDomainUrl().toExternalForm();
        String actionName = 'MessagingSession.' + SessionFieldsProvisioningService.getNamespacePrefix() + 'Escalate_To_Human';
        List<String> logs = new List<String>{
            '=== STARTING ADD ESCALATE BUTTON TO MESSAGING SESSION PAGE PIPELINE ===',
            '[Init] Org Domain: ' + baseUrl,
            '[Init] Target Action: ' + actionName
        };
        return new Map<String, Object>{
            'baseUrl' => baseUrl,
            'actionFullName' => actionName,
            'fieldMap' => Schema.sObjectType.MessagingSession.fields.getMap(),
            'logs' => logs,
            'result' => new Map<String, Object>{ 'logs' => logs }
        };
    }

    private static void logFieldStatus(Map<String, Object> context) {
        List<String> logs = (List<String>) context.get('logs');
        logs.add('\n--- STEP 1: Verifying Session Custom Fields on MessagingSession ---');
        Map<String, Schema.SObjectField> fieldMap = (Map<String, Schema.SObjectField>) context.get('fieldMap');
        Boolean allFieldsExist = SessionFieldsProvisioningService.isFieldInSchema('Escalate_To_Human__c', fieldMap) &&
            SessionFieldsProvisioningService.isFieldInSchema('Escalation_Reason__c', fieldMap) &&
            SessionFieldsProvisioningService.isFieldInSchema('AI_Conversation_Summary__c', fieldMap);
        logs.add(allFieldsExist
            ? '[Step 1] Verified: Escalate_To_Human__c, Escalation_Reason__c, and AI_Conversation_Summary__c are present in schema describe.'
            : '[Step 1] Notice: Required custom fields (Escalate_To_Human__c, Escalation_Reason__c, AI_Conversation_Summary__c) not yet detected in schema describe. Please run "Create Session Fields" pipeline if not already provisioned.');
        logs.add('\n--- STEP 2: Provisioning QuickActionDefinition via Tooling API ---');
    }

    private static void complete(Map<String, Object> context) {
        List<String> logs = (List<String>) context.get('logs');
        Map<String, Object> result = (Map<String, Object>) context.get('result');
        logs.add('\n=== ESCALATE BUTTON SUCCESSFULLY CONFIGURED ON MESSAGING SESSION PAGE ===');
        logs.add('Action Name: ' + context.get('actionFullName'));
        logs.add('Action Label: ' + ACTION_LABEL);
        logs.add('Behavior: Displays modal popup asking for optional Escalation Reason, Conversation Summary, and Omni-Channel routing parameters (varTargetQueueName, varRouting, varSkillLevel, varTargetSkillName), then sets Escalate_To_Human__c=true on the session.');
        result.put('success', true);
        result.put('actionName', context.get('actionFullName'));
        result.put('actionLabel', ACTION_LABEL);
        result.put('quickActionId', context.get('quickActionId'));
        result.put('layoutId', context.get('primaryLayoutId'));
    }

    private static void fail(Map<String, Object> context, Exception ex) {
        List<String> logs = (List<String>) context.get('logs');
        Map<String, Object> result = (Map<String, Object>) context.get('result');
        logs.add('[Error] Exception adding escalate button: ' + ex.getMessage() + '\n' + ex.getStackTraceString());
        result.put('success', false);
        result.put('error', ex.getMessage());
    }
}
