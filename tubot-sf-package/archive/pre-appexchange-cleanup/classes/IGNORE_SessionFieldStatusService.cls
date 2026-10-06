/** Returns the deployed field, permission set, and FLS status for setup screens. */
public with sharing class IGNORE_SessionFieldStatusService {
    public static Map<String, Object> getStatus(Map<String, Object> request) {
        String aiName = nonBlank((String) request.get('aiPermSetName'), SessionFieldsProvisioningService.DEFAULT_AI_PERM_SET);
        String agentName = nonBlank((String) request.get('agentPermSetName'), SessionFieldsProvisioningService.DEFAULT_AGENT_PERM_SET);
        List<SessionFieldsProvisioningService.FieldDefinitionSpec> specs = SessionFieldsProvisioningService.getRequiredFieldSpecs();
        Map<String, Schema.SObjectField> fieldMap = Schema.sObjectType.MessagingSession.fields.getMap();
        Map<String, Object> fields = fieldStatus(specs, fieldMap);
        Map<String, Object> permissionSets = permissionSetStatus(aiName, agentName);
        Map<String, Object> fls = flsStatus(specs, fieldMap, permissionSets);
        Map<String, Object> result = new Map<String, Object>();
        result.putAll(fields);
        result.putAll(permissionSets);
        result.putAll(fls);
        result.put('skillsRoutingActive', Schema.getGlobalDescribe().containsKey('skill'));
        result.put('secondaryPriorityActive', true);
        result.put('statusCapModelActive', true);
        return result;
    }

    private static String nonBlank(String value, String fallback) {
        return String.isBlank(value) ? fallback : value;
    }

    private static Map<String, Object> fieldStatus(
        List<SessionFieldsProvisioningService.FieldDefinitionSpec> specs,
        Map<String, Schema.SObjectField> fieldMap
    ) {
        List<Map<String, Object>> rows = new List<Map<String, Object>>();
        Integer deployedCount = 0;
        for (SessionFieldsProvisioningService.FieldDefinitionSpec spec : specs) {
            Boolean exists = SessionFieldsProvisioningService.isFieldInSchema(spec.apiName, fieldMap);
            if (exists) { deployedCount++; }
            rows.add(new Map<String, Object>{
                'apiName' => spec.apiName,
                'resolvedApiName' => SessionFieldsProvisioningService.resolveFieldApiName(spec.apiName, fieldMap),
                'label' => spec.label,
                'type' => spec.type,
                'deployed' => exists,
                'details' => fieldDetails(spec)
            });
        }
        return new Map<String, Object>{
            'fields' => rows,
            'allFieldsDeployed' => deployedCount == specs.size(),
            'deployedCount' => deployedCount,
            'totalFields' => specs.size()
        };
    }

    private static String fieldDetails(SessionFieldsProvisioningService.FieldDefinitionSpec spec) {
        if (spec.precision != null) { return spec.type + ' (' + spec.precision + ', ' + spec.scale + ')'; }
        return spec.length == null ? spec.type : spec.type + ' (' + spec.length + ')';
    }

    private static Map<String, Object> permissionSetStatus(String aiName, String agentName) {
        Id aiId;
        Id agentId;
        for (PermissionSet permissionSet : [
            SELECT Id, Name, Label FROM PermissionSet WHERE Name IN (:aiName, :agentName) WITH USER_MODE
        ]) {
            if (permissionSet.Name == aiName) { aiId = permissionSet.Id; }
            if (permissionSet.Name == agentName) { agentId = permissionSet.Id; }
        }
        return new Map<String, Object>{
            'aiPermSetExists' => aiId != null,
            'agentPermSetExists' => agentId != null,
            'aiPermSetId' => aiId,
            'agentPermSetId' => agentId
        };
    }

    private static Map<String, Object> flsStatus(
        List<SessionFieldsProvisioningService.FieldDefinitionSpec> specs,
        Map<String, Schema.SObjectField> fieldMap,
        Map<String, Object> permissionSets
    ) {
        Set<Id> permissionSetIds = new Set<Id>{ (Id) permissionSets.get('aiPermSetId'), (Id) permissionSets.get('agentPermSetId') };
        Set<String> fields = new Set<String>();
        for (SessionFieldsProvisioningService.FieldDefinitionSpec spec : specs) {
            fields.add('MessagingSession.' + SessionFieldsProvisioningService.resolveFieldApiName(spec.apiName, fieldMap));
        }
        Integer activeCount = [
            SELECT COUNT() FROM FieldPermissions
            WHERE SobjectType = 'MessagingSession' AND ParentId IN :permissionSetIds AND Field IN :fields
            WITH USER_MODE
        ];
        Integer total = specs.size() * 2;
        return new Map<String, Object>{
            'activeFlsCount' => activeCount,
            'flsFullyProvisioned' => activeCount == total,
            'totalFls' => total
        };
    }
}
