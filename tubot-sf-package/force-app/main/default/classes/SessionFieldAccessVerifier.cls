/** Verifies permission set assignment, field visibility, and user-mode query access. */
public with sharing class SessionFieldAccessVerifier {
    public static Map<String, Object> verify(Map<String, Object> request) {
        Map<String, Object> result = new Map<String, Object>();
        List<String> logs = (List<String>) request.get('logs');
        Map<String, Object> target = resolveTargetUser((String) request.get('targetUserIdentifier'));
        assignPermissionSets(target, request, logs);
        result.put('userAssigned', true);
        result.put('targetUser', target.get('username'));
        List<SessionFieldsProvisioningService.FieldDefinitionSpec> specs = SessionFieldsProvisioningService.getRequiredFieldSpecs();
        Map<String, Schema.SObjectField> fieldMap = Schema.sObjectType.MessagingSession.fields.getMap();
        Map<String, Object> visibility = fieldVisibility(specs, fieldMap, logs);
        result.putAll(visibility);
        runUserModeQuery(new Map<String, Object>{
            'specs' => specs, 'fieldMap' => fieldMap, 'result' => result, 'logs' => logs
        });
        return result;
    }

    private static Map<String, Object> resolveTargetUser(String identifier) {
        Map<String, Object> target = new Map<String, Object>{ 'id' => UserInfo.getUserId(), 'username' => UserInfo.getUserName() };
        if (String.isBlank(identifier) || 'default'.equalsIgnoreCase(identifier.trim())) { return target; }
        List<User> users = [
            SELECT Id, Username
            FROM User
            WHERE (Name = :identifier OR Username = :identifier OR Email = :identifier OR Id = :identifier)
                AND IsActive = true
            WITH USER_MODE LIMIT 1
        ];
        if (!users.isEmpty()) {
            target.put('id', users[0].Id);
            target.put('username', users[0].Username);
        }
        return target;
    }

    private static void assignPermissionSets(Map<String, Object> target, Map<String, Object> request, List<String> logs) {
        String aiName = (String) request.get('aiPermSetDevName');
        String agentName = (String) request.get('agentPermSetDevName');
        Set<Id> ids = new Set<Id>();
        for (PermissionSet permissionSet : [
            SELECT Id
            FROM PermissionSet
            WHERE Name IN (:aiName, :agentName)
            WITH USER_MODE
        ]) { ids.add(permissionSet.Id); }
        Set<Id> assignedIds = existingAssignments((Id) target.get('id'), ids);
        List<PermissionSetAssignment> pending = new List<PermissionSetAssignment>();
        for (Id idValue : ids) {
            if (!assignedIds.contains(idValue)) {
                pending.add(new PermissionSetAssignment(AssigneeId = (Id) target.get('id'), PermissionSetId = idValue));
            }
        }
        if (pending.isEmpty()) {
            logs.add('  ✔ [Step 4] Target User ' + target.get('username') + ' already possesses active assignments for target permission sets.');
            return;
        }
        Database.insert(pending, false, AccessLevel.USER_MODE);
        logs.add('  ✔ [Step 4] Assigned ' + pending.size() + ' target permission set(s) to User: ' + target.get('username'));
    }

    private static Set<Id> existingAssignments(Id userId, Set<Id> permissionSetIds) {
        Set<Id> assignedIds = new Set<Id>();
        for (PermissionSetAssignment assignment : [
            SELECT PermissionSetId
            FROM PermissionSetAssignment
            WHERE AssigneeId = :userId AND PermissionSetId IN :permissionSetIds
            WITH USER_MODE
        ]) { assignedIds.add(assignment.PermissionSetId); }
        return assignedIds;
    }

    private static Map<String, Object> fieldVisibility(
        List<SessionFieldsProvisioningService.FieldDefinitionSpec> specs,
        Map<String, Schema.SObjectField> fieldMap,
        List<String> logs
    ) {
        List<Map<String, Object>> rows = new List<Map<String, Object>>();
        Boolean allAccessible = true;
        for (SessionFieldsProvisioningService.FieldDefinitionSpec spec : specs) {
            Map<String, Object> row = visibilityRow(spec, fieldMap);
            if (!(Boolean) row.get('isAccessible')) { allAccessible = false; }
            rows.add(row);
            logs.add('  ✔ [Step 4] Describe Check: ' + spec.apiName + ' (' + row.get('resolvedField') + ') -> InSchema=' +
                row.get('existsInSchema') + ', Accessible=' + row.get('isAccessible') + ', Editable=' + row.get('isEditable'));
        }
        return new Map<String, Object>{ 'fieldVisibilities' => rows, 'allAccessible' => allAccessible };
    }

    private static Map<String, Object> visibilityRow(
        SessionFieldsProvisioningService.FieldDefinitionSpec spec,
        Map<String, Schema.SObjectField> fieldMap
    ) {
        Boolean exists = SessionFieldsProvisioningService.isFieldInSchema(spec.apiName, fieldMap);
        String resolved = SessionFieldsProvisioningService.resolveFieldApiName(spec.apiName, fieldMap);
        Schema.DescribeFieldResult describe = exists ? describeField(fieldMap, resolved) : null;
        return new Map<String, Object>{
            'field' => spec.apiName, 'resolvedField' => resolved, 'existsInSchema' => exists,
            'isAccessible' => describe != null && describe.isAccessible(),
            'isEditable' => describe != null && (describe.isUpdateable() || describe.isCreateable())
        };
    }

    private static Schema.DescribeFieldResult describeField(Map<String, Schema.SObjectField> fieldMap, String apiName) {
        if (fieldMap.containsKey(apiName.toLowerCase())) { return fieldMap.get(apiName.toLowerCase()).getDescribe(); }
        for (String key : fieldMap.keySet()) {
            if (key.endsWith('__' + apiName.toLowerCase())) { return fieldMap.get(key).getDescribe(); }
        }
        return null;
    }

    private static void runUserModeQuery(Map<String, Object> context) {
        List<SessionFieldsProvisioningService.FieldDefinitionSpec> specs =
            (List<SessionFieldsProvisioningService.FieldDefinitionSpec>) context.get('specs');
        Map<String, Schema.SObjectField> fieldMap = (Map<String, Schema.SObjectField>) context.get('fieldMap');
        Map<String, Object> result = (Map<String, Object>) context.get('result');
        List<String> logs = (List<String>) context.get('logs');
        List<String> fields = new List<String>{ 'Id' };
        for (SessionFieldsProvisioningService.FieldDefinitionSpec spec : specs) {
            fields.add(SessionFieldsProvisioningService.resolveFieldApiName(spec.apiName, fieldMap));
        }
        String query = 'SELECT ' + String.escapeSingleQuotes(String.join(fields, ', ')) + ' FROM MessagingSession LIMIT 1';
        try {
            List<SObject> rows = Database.query(query, AccessLevel.USER_MODE);
            result.put('queryTestSuccess', true);
            logs.add('  ✔ [Step 4] User-mode field visibility query succeeded (' + rows.size() + ' rows returned).');
        } catch (Exception ex) {
            result.put('queryTestSuccess', false);
            result.put('queryTestError', ex.getMessage());
            logs.add('  ✖ [Step 4:WARN] User-mode field query note: ' + ex.getMessage());
        }
    }
}
