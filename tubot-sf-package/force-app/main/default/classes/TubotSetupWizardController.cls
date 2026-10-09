/**
 * @description Provides user discovery and permission assignment for Simple Setup.
 */
public with sharing class TubotSetupWizardController {

    public static final String API_READ_PERMISSION_SET = 'Tubot_Salesforce_API_Read';
    // Subscriber-side pre-authorization membership for the packaged execution
    // client (JWT bearer flow). Created by the policies CLI command (unpackaged:
    // managed permsets cannot be pre-auth members) and assigned here by DML.
    public static final String PERMISSION_SET_NAME = 'Tubot_JWT_PreAuth';
    /**
     * @description Discovers active integration users and standard users in the org,
     * including whether the required Tubot API Read permission set is assigned.
     */
    @AuraEnabled
    public static List<Map<String, Object>> getIntegrationCandidates() {
        PanelAuthSupportService.requireSettingsAdmin();

        Id apiPsId = resolvePermissionSetId(API_READ_PERMISSION_SET);
        Set<Id> assignedUserIds = new Set<Id>();
        if (apiPsId != null) {
            for (PermissionSetAssignment psa : [
                SELECT AssigneeId FROM PermissionSetAssignment
                WHERE PermissionSetId = :apiPsId
                WITH USER_MODE
            ]) {
                assignedUserIds.add(psa.AssigneeId);
            }
        }

        List<Map<String, Object>> candidates = new List<Map<String, Object>>();
        for (User u : [
            SELECT Id, Name, Username, Email, Profile.Name, UserType, IsActive
            FROM User
            WHERE IsActive = true
                AND UserType IN ('Standard', 'CsnOnly', 'CloudIntegrationUser')
            WITH USER_MODE
            ORDER BY Name ASC
            LIMIT 100
        ]) {
            Boolean isIntegration = (u.Profile != null && (
                u.Profile.Name.containsIgnoreCase('Integration') ||
                u.Profile.Name.containsIgnoreCase('API')
            ));
            candidates.add(new Map<String, Object>{
                'id' => u.Id,
                'name' => u.Name,
                'username' => u.Username,
                'email' => u.Email,
                'profileName' => u.Profile != null ? u.Profile.Name : u.UserType,
                'isIntegrationProfile' => isIntegration,
                'hasApiPermission' => assignedUserIds.contains(u.Id)
            });
        }
        return candidates;
    }

    /**
     * @description Assigns API access to a selected user: the packaged API Read
     * permission set (required) plus the subscriber-side JWT pre-authorization
     * membership (when the policies CLI command has created it). Skips the
     * pre-auth assignment with a flag when absent so setup can guide the admin
     * to run the policies command first.
     */
    @AuraEnabled
    public static Map<String, Object> assignApiPermissionSet(String userIdentifier) {
        PanelAuthSupportService.requireSettingsAdmin();

        Id targetUserId = PanelSalesforceChannelSupportService.resolveUserId(userIdentifier);
        if (targetUserId == null) {
            throw new AuraHandledException('Invalid or non-existent user identifier: ' + userIdentifier);
        }

        Id psId = resolvePermissionSetId(API_READ_PERMISSION_SET);
        if (psId == null) {
            throw new AuraHandledException('Permission Set ' + API_READ_PERMISSION_SET + ' is missing from this org.');
        }
        ensurePermissionSetAssigned(targetUserId, psId);

        Id preAuthId = resolveSubscriberPermissionSetId(PERMISSION_SET_NAME);
        Boolean preAuthAssigned = false;
        if (preAuthId != null) {
            ensurePermissionSetAssigned(targetUserId, preAuthId);
            preAuthAssigned = true;
        }

        return new Map<String, Object>{
            'success' => true,
            'userId' => String.valueOf(targetUserId),
            'permissionSet' => API_READ_PERMISSION_SET,
            'isAssigned' => true,
            'preAuthAssigned' => preAuthAssigned
        };
    }

    private static void ensurePermissionSetAssigned(Id targetUserId, Id psId) {
        List<PermissionSetAssignment> existing = [
            SELECT Id FROM PermissionSetAssignment
            WHERE AssigneeId = :targetUserId AND PermissionSetId = :psId
            WITH USER_MODE
            LIMIT 1
        ];
        if (existing.isEmpty()) {
            insert as user new PermissionSetAssignment(
                AssigneeId = targetUserId,
                PermissionSetId = psId
            );
        }
    }

    private static Id resolveSubscriberPermissionSetId(String baseName) {
        String className = TubotSetupWizardController.class.getName();
        String namespace = className.contains('.') ? className.substringBefore('.') : null;
        String qualifiedName = String.isBlank(namespace) ? baseName : namespace + '__' + baseName;
        List<PermissionSet> sets = [
            SELECT Id, NamespacePrefix FROM PermissionSet
            WHERE Name = :baseName OR Name = :qualifiedName
            WITH USER_MODE
        ];
        for (PermissionSet candidate : sets) {
            Boolean belongsToPackage = String.isBlank(namespace)
                ? String.isBlank(candidate.NamespacePrefix)
                : candidate.NamespacePrefix == namespace;
            if (belongsToPackage) {
                return candidate.Id;
            }
        }
        return null;
    }

    // Resolve the permission set matching this code's own namespace. Dev orgs
    // can hold both the packaged and unpackaged copies; a bare LIMIT 1 lookup
    // may assign one copy while connect/prepare checks the other, deadlocking
    // setup with "still being prepared". Mirrors resolveApiPermissionSetId.
    private static Id resolvePermissionSetId(String baseName) {
        String here = TubotSetupWizardController.class.getName();
        String wantNs = here.contains('.') ? here.substringBefore('.') : null;
        List<PermissionSet> sets = [
            SELECT Id, NamespacePrefix FROM PermissionSet
            WHERE Name = :baseName
            WITH USER_MODE
        ];
        for (PermissionSet ps : sets) {
            if (ps.NamespacePrefix == wantNs) {
                return ps.Id;
            }
        }
        return sets.isEmpty() ? null : sets[0].Id;
    }
}
