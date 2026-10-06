/** Resolves default permission sets and provisions their MessagingSession FLS. */
public with sharing class SessionFieldPermissionProvisioner {
    public static void provision(Map<String, Object> input) {
        logs(input).add('\n--- STEP 2: Targeting Designated Permission Sets ---');
        Map<String, PermissionSet> existingByName = loadPermissionSets(input);
        Id aiPermissionSetId = getOrCreatePermissionSet(input, existingByName, 'aiPermSetName');
        Id agentPermissionSetId = getOrCreatePermissionSet(input, existingByName, 'agentPermSetName');
        input.put('aiPermSetId', aiPermissionSetId);
        input.put('agentPermSetId', agentPermissionSetId);
        addPermissionSetSummary(input, aiPermissionSetId, agentPermissionSetId);
        Integer fieldCount = ((List<SessionFieldsProvisioningService.FieldDefinitionSpec>) input.get('specs')).size();
        logs(input).add('\n--- STEP 3: Provisioning FieldPermissions (' + (fieldCount * 2) + ' Mappings) ---');
        Map<String, Object> plan = SessionFieldPermissionPlanBuilder.build(input);
        SessionFieldPermissionRestService.apply(plan);
        result(input).put('step3FieldPermissions', plan.get('summary'));
    }

    private static Map<String, PermissionSet> loadPermissionSets(Map<String, Object> input) {
        String aiName = (String) input.get('aiPermSetName');
        String agentName = (String) input.get('agentPermSetName');
        Map<String, PermissionSet> byName = new Map<String, PermissionSet>();
        for (PermissionSet permissionSet : [
            SELECT Id, Name, Label
            FROM PermissionSet
            WHERE Name IN (:aiName, :agentName)
            WITH USER_MODE
        ]) {
            byName.put(permissionSet.Name, permissionSet);
        }
        return byName;
    }

    private static Id getOrCreatePermissionSet(
        Map<String, Object> input,
        Map<String, PermissionSet> existingByName,
        String nameKey
    ) {
        String permissionSetName = (String) input.get(nameKey);
        List<String> logs = (List<String>) input.get('logs');
        String roleName = nameKey == 'aiPermSetName' ? 'AI Integration' : 'Service Agent Messaging';
        if (existingByName.containsKey(permissionSetName)) {
            Id resolvedId = existingByName.get(permissionSetName).Id;
            logs.add('  ✔ [Step 2] Resolved ' + roleName + ' Permission Set: ' + permissionSetName + ' (Id: ' + resolvedId + ')');
            return resolvedId;
        }
        PermissionSet permissionSet = new PermissionSet(
            Name = permissionSetName,
            Label = permissionSetName.replace('_', ' ')
        );
        Database.insert(permissionSet, AccessLevel.USER_MODE);
        logs.add('  ✔ [Step 2] Created ' + roleName + ' Permission Set: ' + permissionSetName + ' (Id: ' + permissionSet.Id + ')');
        return permissionSet.Id;
    }

    private static void addPermissionSetSummary(Map<String, Object> input, Id aiId, Id agentId) {
        result(input).put('step2PermSets', new Map<String, Object>{
            'aiPermSet' => new Map<String, Object>{ 'name' => input.get('aiPermSetName'), 'id' => aiId },
            'agentPermSet' => new Map<String, Object>{ 'name' => input.get('agentPermSetName'), 'id' => agentId }
        });
    }

    private static Map<String, Object> result(Map<String, Object> input) {
        return (Map<String, Object>) input.get('result');
    }

    private static List<String> logs(Map<String, Object> input) {
        return (List<String>) input.get('logs');
    }
}
