/** Plans idempotent MessagingSession FieldPermissions insertions and updates. */
public with sharing class SessionFieldPermissionPlanBuilder {
    public static Map<String, Object> build(Map<String, Object> input) {
        Map<String, Object> plan = new Map<String, Object>{
            'baseUrl' => input.get('baseUrl'), 'logs' => input.get('logs'),
            'aiPermSetId' => input.get('aiPermSetId'), 'agentPermSetId' => input.get('agentPermSetId'),
            'aiPermSetName' => input.get('aiPermSetName'), 'agentPermSetName' => input.get('agentPermSetName'),
            'restInsertRecords' => new List<Map<String, Object>>(),
            'dmlInsertRecords' => new List<FieldPermissions>(),
            'dmlUpdateRecords' => new List<FieldPermissions>(),
            'summary' => new List<Map<String, Object>>()
        };
        plan.put('qualifiedFields', qualifiedFields(input));
        plan.put('existingPermissions', existingPermissions(plan));
        addPlannedPermissions(plan);
        return plan;
    }

    private static Set<String> qualifiedFields(Map<String, Object> input) {
        Set<String> fields = new Set<String>();
        List<SessionFieldsProvisioningService.FieldDefinitionSpec> specs =
            (List<SessionFieldsProvisioningService.FieldDefinitionSpec>) input.get('specs');
        Map<String, Schema.SObjectField> fieldMap = (Map<String, Schema.SObjectField>) input.get('fieldMap');
        for (SessionFieldsProvisioningService.FieldDefinitionSpec spec : specs) {
            fields.add('MessagingSession.' + SessionFieldsProvisioningService.resolveFieldApiName(spec.apiName, fieldMap));
        }
        return fields;
    }

    private static Map<String, FieldPermissions> existingPermissions(Map<String, Object> plan) {
        Map<String, FieldPermissions> byKey = new Map<String, FieldPermissions>();
        Set<Id> permissionSetIds = new Set<Id>{ (Id) plan.get('aiPermSetId'), (Id) plan.get('agentPermSetId') };
        Set<String> fields = (Set<String>) plan.get('qualifiedFields');
        for (FieldPermissions permission : [
            SELECT Id, ParentId, SobjectType, Field, PermissionsRead, PermissionsEdit
            FROM FieldPermissions
            WHERE SobjectType = 'MessagingSession' AND ParentId IN :permissionSetIds AND Field IN :fields
            WITH USER_MODE
        ]) {
            byKey.put(key(permission.ParentId, permission.Field), permission);
        }
        return byKey;
    }

    private static void addPlannedPermissions(Map<String, Object> plan) {
        Set<String> fields = (Set<String>) plan.get('qualifiedFields');
        Map<String, FieldPermissions> existing = (Map<String, FieldPermissions>) plan.get('existingPermissions');
        for (Id permissionSetId : new Set<Id>{ (Id) plan.get('aiPermSetId'), (Id) plan.get('agentPermSetId') }) {
            plan.put('permissionSetId', permissionSetId);
            plan.put('permissionSetName', permissionSetName(plan, permissionSetId));
            for (String fieldName : fields) {
                plan.put('fieldName', fieldName);
                plan.put('existingPermission', existing.get(key(permissionSetId, fieldName)));
                addFieldPermission(plan);
            }
        }
    }

    private static String permissionSetName(Map<String, Object> input, Id permissionSetId) {
        return permissionSetId == (Id) input.get('aiPermSetId')
            ? (String) input.get('aiPermSetName') : (String) input.get('agentPermSetName');
    }

    private static void addFieldPermission(Map<String, Object> plan) {
        String permissionSetName = (String) plan.get('permissionSetName');
        String fieldName = (String) plan.get('fieldName');
        FieldPermissions permission = (FieldPermissions) plan.get('existingPermission');
        if (permission == null) {
            addMissingPermission(plan);
        } else {
            addExistingPermission(plan);
        }
        ((List<Map<String, Object>>) plan.get('summary')).add(new Map<String, Object>{
            'permSet' => permissionSetName, 'field' => fieldName, 'read' => true, 'edit' => true
        });
    }

    private static void addMissingPermission(Map<String, Object> plan) {
        Id permissionSetId = (Id) plan.get('permissionSetId');
        String permissionSetName = (String) plan.get('permissionSetName');
        String fieldName = (String) plan.get('fieldName');
        ((List<Map<String, Object>>) plan.get('restInsertRecords')).add(new Map<String, Object>{
            'attributes' => new Map<String, Object>{ 'type' => 'FieldPermissions' },
            'ParentId' => permissionSetId, 'SobjectType' => 'MessagingSession', 'Field' => fieldName,
            'PermissionsRead' => true, 'PermissionsEdit' => true
        });
        ((List<FieldPermissions>) plan.get('dmlInsertRecords')).add(new FieldPermissions(
            ParentId = permissionSetId, SobjectType = 'MessagingSession', Field = fieldName,
            PermissionsRead = true, PermissionsEdit = true
        ));
        ((List<String>) plan.get('logs')).add('  ✔ [Step 3] Queued FLS Insert (Read=true, Edit=true) for ' + permissionSetName + ' -> ' + fieldName);
    }

    private static void addExistingPermission(Map<String, Object> plan) {
        FieldPermissions permission = (FieldPermissions) plan.get('existingPermission');
        String permissionSetName = (String) plan.get('permissionSetName');
        String fieldName = (String) plan.get('fieldName');
        if (permission.PermissionsRead && permission.PermissionsEdit) {
            ((List<String>) plan.get('logs')).add('  ✔ [Step 3] FLS already active (Read=true, Edit=true) for ' + permissionSetName + ' -> ' + fieldName);
            return;
        }
        permission.PermissionsRead = true;
        permission.PermissionsEdit = true;
        ((List<FieldPermissions>) plan.get('dmlUpdateRecords')).add(permission);
        ((List<String>) plan.get('logs')).add('  ✔ [Step 3] Queued FLS Update (Read=true, Edit=true) for ' + permissionSetName + ' -> ' + fieldName);
    }

    private static String key(Id permissionSetId, String fieldName) {
        return String.valueOf(permissionSetId) + ':' + fieldName;
    }
}
