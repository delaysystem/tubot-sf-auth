/** Orchestrates MessagingSession custom field, permission, and access provisioning. */
public with sharing class SessionFieldProvisioningPipelineService {
    public static Map<String, Object> create(String requestJson) {
        Map<String, Object> context = initialize(requestJson);
        Map<String, Object> result = response(context);
        try {
            provisionMetadataFields(context);
            SessionFieldPermissionProvisioner.provision(context);
            verifyAccess(context);
            complete(context);
        } catch (Exception ex) {
            fail(context, ex);
        }
        return result;
    }

    private static Map<String, Object> initialize(String requestJson) {
        Map<String, Object> supplied = String.isBlank(requestJson)
            ? new Map<String, Object>() : (Map<String, Object>) JSON.deserializeUntyped(requestJson);
        String aiName = nonBlankValue(supplied.get('aiPermSetDevName'), SessionFieldsProvisioningService.DEFAULT_AI_PERM_SET);
        String agentName = nonBlankValue(supplied.get('agentPermSetDevName'), SessionFieldsProvisioningService.DEFAULT_AGENT_PERM_SET);
        String targetUser = (String) supplied.get('targetUserIdentifier');
        String baseUrl = Url.getOrgDomainUrl().toExternalForm();
        List<String> logs = new List<String>{
            '=== STARTING SESSION FIELDS PROVISIONING PIPELINE ===',
            '[Init] Org Domain: ' + baseUrl,
            '[Init] AI Integration PermSet: ' + aiName,
            '[Init] Service Agent Messaging PermSet: ' + agentName
        };
        return new Map<String, Object>{
            'result' => new Map<String, Object>{ 'logs' => logs, 'success' => false },
            'logs' => logs,
            'aiPermSetName' => aiName,
            'agentPermSetName' => agentName,
            'targetUserIdentifier' => targetUser,
            'baseUrl' => baseUrl
        };
    }

    private static String nonBlankValue(Object value, String fallback) {
        String text = value == null ? null : String.valueOf(value);
        return String.isBlank(text) ? fallback : text;
    }

    private static void provisionMetadataFields(Map<String, Object> context) {
        List<String> logs = logs(context);
        logs.add('\n--- STEP 1: Creating Custom Fields on MessagingSession via Tooling API ---');
        context.put('specs', SessionFieldsProvisioningService.getRequiredFieldSpecs());
        context.put('fieldMap', Schema.sObjectType.MessagingSession.fields.getMap());
        List<Map<String, Object>> fields = SessionFieldMetadataProvisioner.createFields(context);
        response(context).put('step1Fields', fields);
    }

    private static void verifyAccess(Map<String, Object> context) {
        List<String> logs = logs(context);
        logs.add('\n--- STEP 4: Verifying Assignment & Access ---');
        Map<String, Object> verification = SessionFieldAccessVerifier.verify(new Map<String, Object>{
            'aiPermSetDevName' => context.get('aiPermSetName'),
            'agentPermSetDevName' => context.get('agentPermSetName'),
            'targetUserIdentifier' => context.get('targetUserIdentifier'),
            'logs' => logs
        });
        List<String> verificationLogs = (List<String>) verification.remove('logs');
        if (verificationLogs != null) { logs.addAll(verificationLogs); }
        verification.put('success', true);
        response(context).put('step4Verification', verification);
    }

    private static void complete(Map<String, Object> context) {
        Map<String, Object> result = response(context);
        List<String> logs = logs(context);
        Integer fieldCount = ((List<SessionFieldsProvisioningService.FieldDefinitionSpec>) context.get('specs')).size();
        result.put('success', true);
        result.put('message', 'Successfully provisioned ' + fieldCount +
            ' MessagingSession custom fields and ' + (fieldCount * 2) + ' FieldPermissions FLS rules.');
        logs.add('\n=== PIPELINE EXECUTION COMPLETED SUCCESSFULLY ===');
    }

    private static void fail(Map<String, Object> context, Exception ex) {
        response(context).put('success', false);
        response(context).put('message', 'Provisioning error: ' + ex.getMessage());
        logs(context).add('\n✖ [PIPELINE ERROR] ' + ex.getMessage() + ' | Line: ' + ex.getLineNumber());
        logs(context).add(ex.getStackTraceString());
    }

    private static Map<String, Object> response(Map<String, Object> context) {
        return (Map<String, Object>) context.get('result');
    }

    private static List<String> logs(Map<String, Object> context) {
        return (List<String>) context.get('logs');
    }
}
