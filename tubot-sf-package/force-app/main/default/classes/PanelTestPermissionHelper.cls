/**
 * Test-only permission-set resolution. Dev and test orgs can hold both the
 * packaged (namespaced) and unpackaged copies of a permission set, so a bare
 * LIMIT 1 lookup may return the wrong one and grant FLS on the wrong
 * namespace. This helper always picks the copy matching the test's own
 * namespace context, so WITH USER_MODE queries and DML in tests see the
 * fields they expect on any org (scratch, verification, packaging build).
 */
@IsTest
public class PanelTestPermissionHelper {
    public static Id resolvePermissionSetId(String baseName) {
        String helperName = PanelTestPermissionHelper.class.getName();
        String wantNs = helperName.contains('.') ? helperName.substringBefore('.') : null;
        String namespacedPattern = '%__' + baseName;
        List<PermissionSet> all = [
            SELECT Id, NamespacePrefix FROM PermissionSet
            WHERE Name = :baseName OR Name LIKE :namespacedPattern
        ];
        for (PermissionSet ps : all) {
            if (ps.NamespacePrefix == wantNs) {
                return ps.Id;
            }
        }
        return all.isEmpty() ? null : all[0].Id;
    }

    public static void assignPermissionSet(Id userId, String baseName) {
        Id psId = resolvePermissionSetId(baseName);
        System.assertNotEquals(null, psId, 'Permission set ' + baseName + ' must be present.');
        List<PermissionSetAssignment> existing = [
            SELECT Id FROM PermissionSetAssignment
            WHERE AssigneeId = :userId AND PermissionSetId = :psId
            LIMIT 1
        ];
        if (existing.isEmpty()) {
            insert new PermissionSetAssignment(AssigneeId = userId, PermissionSetId = psId);
        }
    }
}
