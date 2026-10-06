/**
 * @description Autonomous service orchestrating supervisor capability provisioning,
 * Public Group assignment, Service Cloud User licensing, and permission assignments
 * for Salesforce Omni Supervisor.
 */
public with sharing class OmniSupervisorSetupService {

    public class SetupResult {
        @AuraEnabled public Boolean success;
        @AuraEnabled public String message;
        @AuraEnabled public String userId;
        @AuraEnabled public String username;
        @AuraEnabled public String userEmail;
        @AuraEnabled public String groupId;
        @AuraEnabled public String groupDevName;
        @AuraEnabled public String permissionSetId;
        @AuraEnabled public List<String> logs;

        public SetupResult() {
            this.success = false;
            this.logs = new List<String>();
        }
    }

    /**
     * @description Resolves multiple users given a comma- or semicolon-separated identifier string.
     * Supports matching by Full Name, Username, Email, 15/18-character Id, or 'default'/'current'.
     */
    public static List<User> resolveTargetUsers(String userIdentifiers) {
        List<User> resolvedUsers = TargetSalesforceUserResolver.resolve(userIdentifiers);
        Set<Id> userIds = new Map<Id, User>(resolvedUsers).keySet();
        Map<Id, User> usersWithSupportPermission = new Map<Id, User>([
            SELECT Id, UserPermissionsSupportUser
            FROM User
            WHERE Id IN :userIds
            WITH USER_MODE
        ]);
        for (User resolvedUser : resolvedUsers) {
            resolvedUser.UserPermissionsSupportUser = usersWithSupportPermission.get(resolvedUser.Id).UserPermissionsSupportUser;
        }
        return resolvedUsers;
    }

    /**
     * @description Ensures the user has UserPermissionsSupportUser (Service Cloud User) enabled.
     */
    public static void ensureSupportUserLicenses(List<User> users, List<String> logs) {
        if (logs == null) { logs = new List<String>(); }
        List<User> toUpdate = new List<User>();

        for (User u : users) {
            if (!u.UserPermissionsSupportUser) {
                u.UserPermissionsSupportUser = true;
                toUpdate.add(u);
                logs.add('Enabling Service Cloud User (UserPermissionsSupportUser=true) for ' + u.Name + ' (' + u.Username + ')');
            } else {
                logs.add('User ' + u.Name + ' already has Service Cloud User enabled.');
            }
        }

        if (!toUpdate.isEmpty()) {
            Database.update(toUpdate, AccessLevel.USER_MODE);
        }
    }

    /**
     * @description Creates or resolves a Public Group for Omni Supervisors.
     */
    public static Group ensureSupervisorGroup(String groupDevName, String groupLabel, List<String> logs) {
        if (String.isBlank(groupDevName)) { groupDevName = 'Omni_Supervisors'; }
        if (String.isBlank(groupLabel)) { groupLabel = 'Omni Supervisors'; }
        if (logs == null) { logs = new List<String>(); }

        List<Group> existing = [
            SELECT Id, Name, DeveloperName, Type 
            FROM Group 
            WHERE Type = 'Regular' AND DeveloperName = :groupDevName 
            WITH USER_MODE LIMIT 1
        ];

        if (!existing.isEmpty()) {
            logs.add('Resolved existing Supervisor Public Group: ' + existing[0].Name + ' (' + existing[0].DeveloperName + ', Id: ' + existing[0].Id + ')');
            return existing[0];
        }

        Group newGrp = new Group(
            Name = groupLabel,
            DeveloperName = groupDevName,
            Type = 'Regular'
        );
        Database.insert(newGrp, AccessLevel.USER_MODE);
        logs.add('Created new Supervisor Public Group: ' + groupLabel + ' (' + groupDevName + ', Id: ' + newGrp.Id + ')');
        return newGrp;
    }

    /**
     * @description Adds target users to the Supervisor Public Group.
     */
    public static void addUsersToSupervisorGroup(Group grp, List<User> users, List<String> logs) {
        if (logs == null) { logs = new List<String>(); }
        Set<Id> userIds = new Set<Id>();
        for (User u : users) {
            userIds.add(u.Id);
        }

        Map<Id, GroupMember> existingMembers = new Map<Id, GroupMember>();
        for (GroupMember gm : [
            SELECT Id, GroupId, UserOrGroupId 
            FROM GroupMember 
            WHERE GroupId = :grp.Id AND UserOrGroupId IN :userIds
            WITH USER_MODE
        ]) {
            existingMembers.put(gm.UserOrGroupId, gm);
        }

        List<GroupMember> toInsert = new List<GroupMember>();
        for (User u : users) {
            if (!existingMembers.containsKey(u.Id)) {
                toInsert.add(new GroupMember(
                    GroupId = grp.Id,
                    UserOrGroupId = u.Id
                ));
                logs.add('Added user ' + u.Name + ' to Supervisor Group ' + grp.Name);
            } else {
                logs.add('User ' + u.Name + ' is already a member of Supervisor Group ' + grp.Name);
            }
        }

        if (!toInsert.isEmpty()) {
            Database.insert(toInsert, AccessLevel.USER_MODE);
        }
    }

    /**
     * @description Ensures the Supervisor Permission Set exists and assigns it to target users.
     */
    public static PermissionSet ensureAndAssignPermissionSet(
        String permSetDevName,
        String permSetLabel,
        List<User> users,
        List<String> logs
    ) {
        if (String.isBlank(permSetDevName)) { permSetDevName = 'Omni_Supervisor_Access'; }
        if (String.isBlank(permSetLabel)) { permSetLabel = 'Omni Supervisor Access'; }
        if (logs == null) { logs = new List<String>(); }

        List<PermissionSet> existingPS = [
            SELECT Id, Name, Label 
            FROM PermissionSet 
            WHERE Name = :permSetDevName 
            WITH USER_MODE LIMIT 1
        ];

        PermissionSet ps;
        if (!existingPS.isEmpty()) {
            ps = existingPS[0];
            logs.add('Resolved existing PermissionSet: ' + ps.Label + ' (' + ps.Name + ', Id: ' + ps.Id + ')');
        } else {
            ps = new PermissionSet(
                Name = permSetDevName,
                Label = permSetLabel
            );
            Database.insert(ps, AccessLevel.USER_MODE);
            logs.add('Created new PermissionSet: ' + permSetLabel + ' (' + permSetDevName + ', Id: ' + ps.Id + ')');
        }

        Set<Id> userIds = new Set<Id>();
        for (User u : users) {
            userIds.add(u.Id);
        }

        Map<Id, PermissionSetAssignment> existingAssignments = new Map<Id, PermissionSetAssignment>();
        for (PermissionSetAssignment psa : [
            SELECT Id, AssigneeId 
            FROM PermissionSetAssignment 
            WHERE PermissionSetId = :ps.Id AND AssigneeId IN :userIds
            WITH USER_MODE
        ]) {
            existingAssignments.put(psa.AssigneeId, psa);
        }

        List<PermissionSetAssignment> psasToInsert = new List<PermissionSetAssignment>();
        for (User u : users) {
            if (!existingAssignments.containsKey(u.Id)) {
                psasToInsert.add(new PermissionSetAssignment(
                    PermissionSetId = ps.Id,
                    AssigneeId = u.Id
                ));
                logs.add('Assigned PermissionSet "' + ps.Label + '" to user ' + u.Name);
            } else {
                logs.add('User ' + u.Name + ' already has PermissionSet "' + ps.Label + '" assigned.');
            }
        }

        if (!psasToInsert.isEmpty()) {
            Database.insert(psasToInsert, AccessLevel.USER_MODE);
        }

        return ps;
    }

    /**
     * @description Complete supervisor setup orchestration.
     */
    @AuraEnabled
    public static SetupResult setupSupervisorUser(Map<String, String> config) {
        requireSettingsAdmin();
        if (config == null) { config = new Map<String, String>(); }

        String userIdentifier = config.containsKey('userIdentifier') ? config.get('userIdentifier') : 'John Swanson';
        String groupDevName = config.containsKey('groupDevName') ? config.get('groupDevName') : 'Omni_Supervisors';
        String groupLabel = config.containsKey('groupLabel') ? config.get('groupLabel') : 'Omni Supervisors';
        String permSetDevName = config.containsKey('permSetDevName') ? config.get('permSetDevName') : 'Omni_Supervisor_Access';
        String permSetLabel = config.containsKey('permSetLabel') ? config.get('permSetLabel') : 'Omni Supervisor Access';

        List<String> logs = new List<String>();
        SetupResult result = new SetupResult();
        result.logs = logs;

        try {
            logs.add('Starting Omni Supervisor provisioning for: ' + userIdentifier);
            List<User> targetUsers = resolveTargetUsers(userIdentifier);
            logs.add('Resolved ' + targetUsers.size() + ' target supervisor user(s)');

            // 1. Service Cloud User License
            ensureSupportUserLicenses(targetUsers, logs);

            // 2. Supervisor Public Group
            Group supGroup = ensureSupervisorGroup(groupDevName, groupLabel, logs);
            addUsersToSupervisorGroup(supGroup, targetUsers, logs);
            result.groupId = supGroup.Id;
            result.groupDevName = supGroup.DeveloperName;

            // 3. Permission Set Assignment
            PermissionSet ps = ensureAndAssignPermissionSet(permSetDevName, permSetLabel, targetUsers, logs);
            result.permissionSetId = ps.Id;

            if (!targetUsers.isEmpty()) {
                result.userId = targetUsers[0].Id;
                result.username = targetUsers[0].Username;
                result.userEmail = targetUsers[0].Email;
            }

            result.success = true;
            result.message = 'Successfully provisioned ' + targetUsers.size() + ' user(s) with Omni Supervisor capabilities in group ' + supGroup.Name;
        } catch (Exception ex) {
            result.success = false;
            result.message = 'Error executing supervisor setup: ' + ex.getMessage();
            logs.add('ERROR: ' + ex.getMessage() + '\n' + ex.getStackTraceString());
        }

        return result;
    }

    /**
     * @description Helper invoked via `sf apex run` to return structured JSON output to CLI scripts.
     */
    public static void executeSetupScript(String jsonConfig) {
        requireSettingsAdmin();
        Map<String, String> config = new Map<String, String>();
        if (String.isNotBlank(jsonConfig)) {
            try {
                Map<String, Object> raw = (Map<String, Object>) JSON.deserializeUntyped(jsonConfig);
                for (String key : raw.keySet()) {
                    config.put(key, String.valueOf(raw.get(key)));
                }
            } catch (Exception e) {
                System.debug('JSON config parse note: ' + e.getMessage());
            }
        }
        SetupResult res = setupSupervisorUser(config);
        System.debug('<<<OMNI_SUPERVISOR_SETUP_RESULT>>>' + JSON.serialize(res) + '<<<END_OMNI_SUPERVISOR_SETUP_RESULT>>>');
    }

    private static void requireSettingsAdmin() {
        PanelAuthSupportService.requireSettingsAdmin();
    }
}
