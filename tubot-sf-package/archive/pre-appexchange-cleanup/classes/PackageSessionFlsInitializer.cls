/** Provisions the package session fields on the default permission sets. */
public with sharing class PackageSessionFlsInitializer {
    private class PermissionPlan {
        private List<FieldPermissions> toInsert = new List<FieldPermissions>();
        private List<FieldPermissions> toUpdate = new List<FieldPermissions>();
    }

    public static void initialize() {
        try {
            Set<Id> permissionSetIds = targetPermissionSetIds();
            if (permissionSetIds.isEmpty()) {
                return;
            }
            Set<String> fields = requiredFields();
            PermissionPlan plan = buildPlan(permissionSetIds, fields, existingPermissions(permissionSetIds, fields));
            persist(plan);
            System.debug('>>> [PackagePostInstallHandler] Provisioned ' + plan.toInsert.size() +
                ' inserts and ' + plan.toUpdate.size() + ' updates for MessagingSession FLS.');
        } catch (Exception ex) {
            System.debug('>>> [PackagePostInstallHandler] FLS initialization note: ' + ex.getMessage());
        }
    }

    private static Set<Id> targetPermissionSetIds() {
        Set<Id> ids = new Set<Id>();
        for (PermissionSet permissionSet : [
            SELECT Id
            FROM PermissionSet
            WHERE Name IN (:SessionFieldsProvisioningService.DEFAULT_AI_PERM_SET,
                :SessionFieldsProvisioningService.DEFAULT_AGENT_PERM_SET, 'Panel_Settings_Admin_Access')
            WITH USER_MODE
        ]) {
            ids.add(permissionSet.Id);
        }
        return ids;
    }

    private static Set<String> requiredFields() {
        Set<String> fields = new Set<String>();
        for (SessionFieldsProvisioningService.FieldDefinitionSpec spec : SessionFieldsProvisioningService.getRequiredFieldSpecs()) {
            fields.add('MessagingSession.' + spec.apiName);
        }
        return fields;
    }

    private static Map<String, FieldPermissions> existingPermissions(Set<Id> permissionSetIds, Set<String> fields) {
        Map<String, FieldPermissions> byKey = new Map<String, FieldPermissions>();
        for (FieldPermissions permission : [
            SELECT Id, ParentId, Field, PermissionsRead, PermissionsEdit
            FROM FieldPermissions
            WHERE SobjectType = 'MessagingSession' AND ParentId IN :permissionSetIds AND Field IN :fields
            WITH USER_MODE
        ]) {
            byKey.put(permissionKey(permission.ParentId, permission.Field), permission);
        }
        return byKey;
    }

    private static PermissionPlan buildPlan(
        Set<Id> permissionSetIds,
        Set<String> fields,
        Map<String, FieldPermissions> existingByKey
    ) {
        PermissionPlan plan = new PermissionPlan();
        for (Id permissionSetId : permissionSetIds) {
            for (String fieldName : fields) {
                String key = permissionKey(permissionSetId, fieldName);
                if (existingByKey.containsKey(key)) {
                    addPermissionUpdate(existingByKey.get(key), plan);
                } else {
                    plan.toInsert.add(new FieldPermissions(
                        ParentId = permissionSetId,
                        SobjectType = 'MessagingSession',
                        Field = fieldName,
                        PermissionsRead = true,
                        PermissionsEdit = true
                    ));
                }
            }
        }
        return plan;
    }

    private static void addPermissionUpdate(FieldPermissions permission, PermissionPlan plan) {
        if (permission.PermissionsRead && permission.PermissionsEdit) {
            return;
        }
        permission.PermissionsRead = true;
        permission.PermissionsEdit = true;
        plan.toUpdate.add(permission);
    }

    private static String permissionKey(Id parentId, String fieldName) {
        return String.valueOf(parentId) + ':' + fieldName;
    }

    private static void persist(PermissionPlan plan) {
        if (!plan.toInsert.isEmpty()) {
            Database.insert(plan.toInsert, false, AccessLevel.USER_MODE);
        }
        if (!plan.toUpdate.isEmpty()) {
            Database.update(plan.toUpdate, false, AccessLevel.USER_MODE);
        }
    }
}
