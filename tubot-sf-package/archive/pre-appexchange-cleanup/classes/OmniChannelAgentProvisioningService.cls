/** Assigns Omni-Channel queue membership, presence access, and permissions to target users. */
public with sharing class OmniChannelAgentProvisioningService {
    public class ProvisionRequest {
        public Group queue;
        public List<User> targetUsers;
        public String presenceStatusDeveloperName;
        public String permissionSetDeveloperName;
        public String permissionSetLabel;
        public List<String> logs;
    }

    private class ProvisioningContext {
        private Group queue;
        private List<User> targetUsers;
        private PermissionSet permissionSet;
        private List<String> logs;
        private Map<Id, GroupMember> membersByUser;
        private Map<Id, PermissionSetAssignment> assignmentsByUser;
        private List<GroupMember> membersToInsert = new List<GroupMember>();
        private List<PermissionSetAssignment> assignmentsToInsert = new List<PermissionSetAssignment>();
        private List<String> summaries = new List<String>();
    }

    private class PresenceContext {
        private Id permissionSetId;
        private String developerName;
        private OmniChannelSetupService.SetupResult result;
        private List<String> logs;
    }

    public static OmniChannelSetupService.SetupResult provision(ProvisionRequest request) {
        validateRequest(request);
        List<String> logs = request.logs == null ? new List<String>() : request.logs;
        List<User> targetUsers = request.targetUsers == null ? new List<User>() : request.targetUsers;
        String presenceName = String.isBlank(request.presenceStatusDeveloperName)
            ? 'Available_Messaging' : request.presenceStatusDeveloperName;
        String permissionName = String.isBlank(request.permissionSetDeveloperName)
            ? 'Omni_Channel_Messaging_Agent' : request.permissionSetDeveloperName;
        String permissionLabel = String.isBlank(request.permissionSetLabel)
            ? 'Omni-Channel Messaging Agent' : request.permissionSetLabel;

        OmniChannelSetupService.SetupResult result = new OmniChannelSetupService.SetupResult();
        result.logs = logs;
        result.queueId = request.queue.Id;
        result.queueDevName = request.queue.DeveloperName;
        PermissionSet permissionSet = resolvePermissionSet(permissionName, permissionLabel, logs);
        result.permissionSetId = permissionSet.Id;
        PresenceContext presenceContext = new PresenceContext();
        presenceContext.permissionSetId = permissionSet.Id;
        presenceContext.developerName = presenceName;
        presenceContext.result = result;
        presenceContext.logs = logs;
        linkPresenceStatus(presenceContext);
        ProvisioningContext context = new ProvisioningContext();
        context.queue = request.queue;
        context.targetUsers = targetUsers;
        context.permissionSet = permissionSet;
        context.logs = logs;
        List<String> summaries = addUsersToQueueAndPermissionSet(context);
        populatePrimaryUser(result, targetUsers);

        result.success = true;
        result.message = 'Successfully provisioned ' + targetUsers.size() + ' agent(s) [' + String.join(summaries, ', ') +
            '] for queue ' + request.queue.Name + ' and status ' + presenceName;
        return result;
    }

    private static void validateRequest(ProvisionRequest request) {
        if (request == null || request.queue == null || request.queue.Id == null) {
            throw new IllegalArgumentException('A saved queue is required for agent provisioning.');
        }
    }

    private static PermissionSet resolvePermissionSet(String developerName, String label, List<String> logs) {
        List<PermissionSet> existingSets = [
            SELECT Id, Name, Label
            FROM PermissionSet
            WHERE Name = :developerName
            WITH USER_MODE
            LIMIT 1
        ];
        if (!existingSets.isEmpty()) {
            PermissionSet existing = existingSets[0];
            logs.add('Resolved existing PermissionSet: ' + existing.Label + ' (' + existing.Name + ', Id: ' + existing.Id + ')');
            return existing;
        }
        PermissionSet created = new PermissionSet(Name = developerName, Label = label);
        Database.insert(created, AccessLevel.USER_MODE);
        logs.add('Created new PermissionSet: ' + label + ' (' + developerName + ', Id: ' + created.Id + ')');
        return created;
    }

    private static void linkPresenceStatus(PresenceContext context) {
        Schema.SObjectType statusType = Schema.getGlobalDescribe().get('ServicePresenceStatus');
        if (statusType == null) {
            context.logs.add('Notice: ServicePresenceStatus is not available in this org.');
            return;
        }
        List<SObject> statuses = Database.queryWithBinds(
            'SELECT Id, DeveloperName, MasterLabel FROM ServicePresenceStatus WHERE DeveloperName = :developerName LIMIT 1',
            new Map<String, Object>{ 'developerName' => context.developerName },
            AccessLevel.USER_MODE
        );
        if (statuses.isEmpty()) {
            context.logs.add('Warning: ServicePresenceStatus with DeveloperName "' + context.developerName + '" not yet compiled in org.');
            return;
        }
        SObject status = statuses[0];
        Id statusId = (Id) status.get('Id');
        context.result.presenceStatusId = String.valueOf(statusId);
        context.logs.add('Resolved ServicePresenceStatus: ' + status.get('MasterLabel') + ' (' + status.get('DeveloperName') + ', Id: ' + statusId + ')');
        attachPresenceStatus(context.permissionSetId, statusId, context.logs);
    }

    private static void attachPresenceStatus(Id permissionSetId, Id statusId, List<String> logs) {
        List<SetupEntityAccess> existingLinks = [
            SELECT Id
            FROM SetupEntityAccess
            WHERE ParentId = :permissionSetId AND SetupEntityId = :statusId
            WITH USER_MODE
            LIMIT 1
        ];
        if (!existingLinks.isEmpty()) {
            logs.add('ServicePresenceStatus is already linked to PermissionSet');
            return;
        }
        try {
            SetupEntityAccess link = new SetupEntityAccess(ParentId = permissionSetId, SetupEntityId = statusId);
            Database.insert(link, AccessLevel.USER_MODE);
            logs.add('Linked ServicePresenceStatus access to PermissionSet via SetupEntityAccess (Id: ' + link.Id + ')');
        } catch (Exception ex) {
            logs.add('SetupEntityAccess notice: ' + ex.getMessage());
        }
    }

    private static List<String> addUsersToQueueAndPermissionSet(ProvisioningContext context) {
        Set<Id> userIds = new Set<Id>();
        for (User targetUser : context.targetUsers) {
            userIds.add(targetUser.Id);
        }
        context.membersByUser = new Map<Id, GroupMember>();
        for (GroupMember member : [
            SELECT Id, UserOrGroupId
            FROM GroupMember
            WHERE GroupId = :context.queue.Id AND UserOrGroupId IN :userIds
            WITH USER_MODE
        ]) {
            context.membersByUser.put(member.UserOrGroupId, member);
        }
        context.assignmentsByUser = new Map<Id, PermissionSetAssignment>();
        for (PermissionSetAssignment assignment : [
            SELECT Id, AssigneeId
            FROM PermissionSetAssignment
            WHERE PermissionSetId = :context.permissionSet.Id AND AssigneeId IN :userIds
            WITH USER_MODE
        ]) {
            context.assignmentsByUser.put(assignment.AssigneeId, assignment);
        }
        for (User targetUser : context.targetUsers) {
            appendUserAccess(context, targetUser);
        }
        if (!context.membersToInsert.isEmpty()) {
            Database.insert(context.membersToInsert, AccessLevel.USER_MODE);
        }
        if (!context.assignmentsToInsert.isEmpty()) {
            Database.insert(context.assignmentsToInsert, AccessLevel.USER_MODE);
        }
        return context.summaries;
    }

    private static void appendUserAccess(ProvisioningContext context, User targetUser) {
        String displayName = targetUser.isSet(User.Name) && String.isNotBlank(targetUser.Name)
            ? targetUser.Name : (targetUser.isSet(User.Username) ? targetUser.Username : String.valueOf(targetUser.Id));
        String username = targetUser.isSet(User.Username) ? targetUser.Username : String.valueOf(targetUser.Id);
        context.summaries.add(displayName + ' (' + username + ')');
        if (context.membersByUser.containsKey(targetUser.Id)) {
            context.logs.add('User ' + displayName + ' (' + username + ') is already a member of Queue ' + context.queue.Name);
        } else {
            context.membersToInsert.add(new GroupMember(GroupId = context.queue.Id, UserOrGroupId = targetUser.Id));
            context.logs.add('Added user ' + displayName + ' (' + username + ') to Queue ' + context.queue.Name);
        }
        if (context.assignmentsByUser.containsKey(targetUser.Id)) {
            context.logs.add('User ' + displayName + ' already has PermissionSet "' + context.permissionSet.Label + '" assigned.');
        } else {
            context.assignmentsToInsert.add(new PermissionSetAssignment(PermissionSetId = context.permissionSet.Id, AssigneeId = targetUser.Id));
            context.logs.add('Assigned PermissionSet "' + context.permissionSet.Label + '" to user ' + displayName);
        }
    }

    private static void populatePrimaryUser(OmniChannelSetupService.SetupResult result, List<User> targetUsers) {
        if (targetUsers.isEmpty()) {
            return;
        }
        result.userId = targetUsers[0].Id;
        result.username = targetUsers[0].Username;
        result.userEmail = targetUsers[0].Email;
    }
}
