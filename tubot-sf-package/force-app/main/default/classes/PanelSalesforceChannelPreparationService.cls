/** Validates a channel and prepares the API permission assignment before credential registration. */
public with sharing class PanelSalesforceChannelPreparationService {
    private class PreparationContext {
        private Id channelId;
        private Id userId;
        private String teamId;
        private String userIdText;
        private String channelIdText;
        private Tubot_API_Channel__c existing;
        private List<Tubot_API_Channel__c> siblings = new List<Tubot_API_Channel__c>();
        private Boolean assignmentExists;
        private Boolean assignmentOwned;
        private String assignmentId;
    }

    public static void prepare(String channelIdentifier, String userIdentifier) {
        PanelSalesforceChannelSupportService.requireAdmin();
        PreparationContext context = resolveInputs(channelIdentifier, userIdentifier);
        validateChannelAccess(context);
        loadPreparationState(context);
        savePreparation(context);
    }

    private static PreparationContext resolveInputs(String channelIdentifier, String userIdentifier) {
        if (String.isBlank(channelIdentifier) || String.isBlank(userIdentifier)) {
            throw PanelSalesforceChannelSupportService.newException('Channel and integration user are required.');
        }
        PreparationContext context = new PreparationContext();
        try { context.channelId = (Id) channelIdentifier; } catch (Exception invalidId) {
            throw PanelSalesforceChannelSupportService.newException('Enter a valid Salesforce channel ID.');
        }
        context.userId = PanelSalesforceChannelSupportService.resolveUserId(userIdentifier);
        if (context.userId == null) {
            throw PanelSalesforceChannelSupportService.newException('Enter a valid Salesforce integration user ID or username.');
        }
        context.channelIdText = String.valueOf(context.channelId);
        context.userIdText = String.valueOf(context.userId);
        context.teamId = PanelAuthSupportService.getConfig().Panel_Team_Id__c;
        return context;
    }

    private static void validateChannelAccess(PreparationContext context) {
        if (!PanelSalesforceChannelSupportService.messagingChannelExists(context.channelId)) {
            throw PanelSalesforceChannelSupportService.newException('The Messaging Channel does not exist in this Salesforce org.');
        }
        List<User> users = [SELECT Id, IsActive FROM User WHERE Id = :context.userId WITH USER_MODE LIMIT 1];
        if (users.isEmpty() || !users[0].IsActive) {
            throw PanelSalesforceChannelSupportService.newException('Select an active integration user in this org.');
        }
        Id apiPsId = PanelSalesforceChannelSupportService.resolveApiPermissionSetId();
        if (apiPsId == null) { throw PanelSalesforceChannelSupportService.newException('Tubot API permission set is missing from this org.'); }
        context.assignmentExists = [
            SELECT COUNT() FROM PermissionSetAssignment
            WHERE AssigneeId = :context.userId AND PermissionSetId = :apiPsId WITH USER_MODE
        ] > 0;
    }

    private static void loadPreparationState(PreparationContext context) {
        context.existing = findExistingChannel(context);
        context.siblings = [
            SELECT Id, Assignment_Owned__c, Assignment_Id__c
            FROM Tubot_API_Channel__c
            WHERE Integration_User_Id__c = :context.userIdText WITH USER_MODE
        ];
        context.assignmentOwned = !context.assignmentExists;
        for (Tubot_API_Channel__c sibling : context.siblings) {
            if (sibling.Assignment_Owned__c == true) { context.assignmentOwned = true; }
            if (String.isNotBlank(sibling.Assignment_Id__c)) { context.assignmentId = sibling.Assignment_Id__c; }
        }
    }

    private static Tubot_API_Channel__c findExistingChannel(PreparationContext context) {
        List<Tubot_API_Channel__c> rows = [
            SELECT Id, Team_Id__c, Integration_User_Id__c, Assignment_Owned__c, Assignment_Id__c
            FROM Tubot_API_Channel__c WHERE Channel_Id__c = :context.channelIdText WITH USER_MODE
        ];
        Tubot_API_Channel__c match;
        for (Tubot_API_Channel__c row : rows) {
            if (row.Team_Id__c != context.teamId) {
                throw PanelSalesforceChannelSupportService.newException('This channel is already connected to a different Panel team.');
            }
            if (row.Integration_User_Id__c == context.userIdText) { match = row; }
        }
        return match;
    }

    private static void savePreparation(PreparationContext context) {
        Tubot_API_Channel__c row = context.existing == null ? new Tubot_API_Channel__c() : context.existing;
        row.Connection_Key__c = context.channelIdText + ':' + context.userIdText;
        row.Channel_Id__c = context.channelIdText;
        row.Team_Id__c = context.teamId;
        row.Integration_User_Id__c = context.userIdText;
        row.Assignment_Owned__c = context.assignmentOwned;
        row.Assignment_Id__c = context.assignmentId;
        if (context.existing == null) {
            Database.upsert(row, Tubot_API_Channel__c.Connection_Key__c, true, AccessLevel.USER_MODE);
        } else {
            Database.update(row, AccessLevel.USER_MODE);
        }
        updateSiblingOwnership(context);
        enqueuePermissionAssignment(context);
    }

    private static void updateSiblingOwnership(PreparationContext context) {
        if (!context.assignmentOwned) { return; }
        List<Tubot_API_Channel__c> updates = new List<Tubot_API_Channel__c>();
        for (Tubot_API_Channel__c sibling : context.siblings) {
            if (sibling.Assignment_Owned__c != true) {
                sibling.Assignment_Owned__c = true;
                sibling.Assignment_Id__c = context.assignmentId;
                updates.add(sibling);
            }
        }
        if (!updates.isEmpty()) { Database.update(updates, AccessLevel.USER_MODE); }
    }

    private static void enqueuePermissionAssignment(PreparationContext context) {
        if (context.assignmentExists) { return; }
        System.enqueueJob(new PanelApiAssignmentQueueable(new List<PanelApiAssignmentQueueable.Request>{
            new PanelApiAssignmentQueueable.Request(context.userId, 'ASSIGN', null)
        }));
    }
}
