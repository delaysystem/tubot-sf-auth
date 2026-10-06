/** Removes remote/local channel grants and relinquishes permission assignments owned by this package. */
public with sharing class PanelSalesforceChannelCleanupService {
    private class AssignmentCleanupPlan {
        private Set<String> userIds = new Set<String>();
        private Map<String, Id> assignmentByUser = new Map<String, Id>();
    }

    public static void disconnectChannel(String channelIdentifier) {
        PanelSalesforceChannelSupportService.requireAdmin();
        Id channelId = parseChannelId(channelIdentifier);
        String channelIdText = String.valueOf(channelId);
        List<Tubot_API_Channel__c> channels = [
            SELECT Id, Channel_Id__c, Integration_User_Id__c, Assignment_Owned__c, Assignment_Id__c, Team_Id__c
            FROM Tubot_API_Channel__c WHERE Channel_Id__c = :channelIdText WITH USER_MODE
        ];
        ensureActiveTeam(channels);
        removeRemoteChannel(channelIdText);
        Database.delete(channels, AccessLevel.USER_MODE);
        revokeUnusedAssignments(channels);
    }

    public static void clearLocalConnections(String teamId) {
        PanelSalesforceChannelSupportService.requireSettingsAdmin();
        if (String.isBlank(teamId)) { return; }
        List<Tubot_API_Channel__c> channels = [
            SELECT Id, Integration_User_Id__c, Assignment_Owned__c, Assignment_Id__c
            FROM Tubot_API_Channel__c WHERE Team_Id__c = :teamId WITH USER_MODE
        ];
        List<PanelApiAssignmentQueueable.Request> requests = localRemovalRequests(channels);
        if (!channels.isEmpty()) { Database.delete(channels, AccessLevel.USER_MODE); }
        enqueueRemoval(requests);
    }

    public static void revokeUnusedAssignments(List<Tubot_API_Channel__c> channels) {
        AssignmentCleanupPlan plan = cleanupPlan(channels);
        if (plan.userIds.isEmpty()) { return; }
        Set<String> remainingUsers = usersWithConnections(plan.userIds);
        enqueueRemoval(unusedAssignmentRequests(plan, remainingUsers));
    }

    private static Id parseChannelId(String identifier) {
        try { return (Id) identifier; } catch (Exception invalidId) {
            throw PanelSalesforceChannelSupportService.newException('Enter a valid Salesforce channel ID.');
        }
    }

    private static void ensureActiveTeam(List<Tubot_API_Channel__c> channels) {
        String teamId = PanelAuthSupportService.getConfig().Panel_Team_Id__c;
        if (channels.isEmpty() || channels[0].Team_Id__c != teamId) {
            throw PanelSalesforceChannelSupportService.newException('This channel is not connected for the active Panel team.');
        }
    }

    private static void removeRemoteChannel(String channelId) {
        String path = '/api/v1/salesforce/channels/' + EncodingUtil.urlEncode(channelId, 'UTF-8') +
            '?orgId=' + EncodingUtil.urlEncode(UserInfo.getOrganizationId(), 'UTF-8');
        HttpResponse response = PanelAuthSupportService.executePanelCallout(path, 'DELETE', null);
        if (response.getStatusCode() == 404 || (response.getStatusCode() >= 200 && response.getStatusCode() < 300)) { return; }
        throw PanelSalesforceChannelSupportService.newException(
            PanelSalesforceChannelSupportService.panelFailure(response, 'Salesforce channel disconnect failed')
        );
    }

    private static AssignmentCleanupPlan cleanupPlan(List<Tubot_API_Channel__c> channels) {
        AssignmentCleanupPlan plan = new AssignmentCleanupPlan();
        for (Tubot_API_Channel__c channel : channels) {
            if (channel.Assignment_Owned__c && String.isNotBlank(channel.Assignment_Id__c)) {
                plan.userIds.add(channel.Integration_User_Id__c);
                plan.assignmentByUser.put(channel.Integration_User_Id__c, (Id) channel.Assignment_Id__c);
            }
        }
        return plan;
    }

    private static Set<String> usersWithConnections(Set<String> userIds) {
        Set<String> remaining = new Set<String>();
        for (Tubot_API_Channel__c channel : [
            SELECT Integration_User_Id__c FROM Tubot_API_Channel__c
            WHERE Integration_User_Id__c IN :userIds WITH USER_MODE
        ]) { remaining.add(channel.Integration_User_Id__c); }
        return remaining;
    }

    private static List<PanelApiAssignmentQueueable.Request> localRemovalRequests(List<Tubot_API_Channel__c> channels) {
        List<PanelApiAssignmentQueueable.Request> requests = new List<PanelApiAssignmentQueueable.Request>();
        for (Tubot_API_Channel__c channel : channels) {
            if (channel.Assignment_Owned__c && String.isNotBlank(channel.Assignment_Id__c)) {
                requests.add(new PanelApiAssignmentQueueable.Request(
                    (Id) channel.Integration_User_Id__c, 'REMOVE', (Id) channel.Assignment_Id__c
                ));
            }
        }
        return requests;
    }

    private static List<PanelApiAssignmentQueueable.Request> unusedAssignmentRequests(
        AssignmentCleanupPlan plan,
        Set<String> remainingUsers
    ) {
        List<PanelApiAssignmentQueueable.Request> requests = new List<PanelApiAssignmentQueueable.Request>();
        for (String userId : plan.userIds) {
            if (!remainingUsers.contains(userId)) {
                requests.add(new PanelApiAssignmentQueueable.Request((Id) userId, 'REMOVE', plan.assignmentByUser.get(userId)));
            }
        }
        return requests;
    }

    private static void enqueueRemoval(List<PanelApiAssignmentQueueable.Request> requests) {
        if (!requests.isEmpty()) { System.enqueueJob(new PanelApiAssignmentQueueable(requests)); }
    }
}
