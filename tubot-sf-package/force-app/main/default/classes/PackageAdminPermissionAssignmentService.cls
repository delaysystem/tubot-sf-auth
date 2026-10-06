/** Assigns the package admin permission after the install transaction commits. */
public without sharing class PackageAdminPermissionAssignmentService {
    private static final String ADMIN_PERMISSION_SET_NAME = 'Panel_Settings_Admin_Access';

    private class AssignmentException extends Exception {}

    @future
    public static void assignToInstaller(Id installerUserId) {
        if (installerUserId == null) {
            throw new AssignmentException('Installer user is required.');
        }

        List<PermissionSet> permissionSets = [
            SELECT Id
            FROM PermissionSet
            WHERE Name = :ADMIN_PERMISSION_SET_NAME
            WITH SYSTEM_MODE
            LIMIT 1
        ];
        if (permissionSets.isEmpty()) {
            throw new AssignmentException('The package admin permission set is missing.');
        }

        List<PermissionSetAssignment> assignments = [
            SELECT Id
            FROM PermissionSetAssignment
            WHERE AssigneeId = :installerUserId AND PermissionSetId = :permissionSets[0].Id
            WITH SYSTEM_MODE
            LIMIT 1
        ];
        if (assignments.isEmpty()) {
            Database.insert(new PermissionSetAssignment(
                AssigneeId = installerUserId,
                PermissionSetId = permissionSets[0].Id
            ), AccessLevel.SYSTEM_MODE);
        }
    }
}
