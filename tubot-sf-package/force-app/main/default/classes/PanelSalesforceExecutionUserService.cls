/** Registers, removes, and validates secondary execution-user grants for a channel. */
public with sharing class PanelSalesforceExecutionUserService {
    private class UserConnectionContext {
        private Id channelId;
        private Id userId;
        private String channelIdText;
        private String userIdText;
        private String clientId;
        private String clientSecret;
    }

    public static void connect(String requestJson) {
        PanelSalesforceChannelSupportService.requireAdmin();
        UserConnectionContext context = parseConnection(requestJson);
        verifyPreparedUser(context);
        sendConnection(context);
    }

    public static void disconnect(String channelIdentifier, String userIdentifier) {
        PanelSalesforceChannelSupportService.requireAdmin();
        UserConnectionContext context = resolveIds(channelIdentifier, userIdentifier);
        Tubot_API_Channel__c channel = findConnectedUser(context);
        removeRemoteConnection(context);
        Database.delete(channel, AccessLevel.USER_MODE);
        PanelSalesforceChannelCleanupService.revokeUnusedAssignments(new List<Tubot_API_Channel__c>{ channel });
    }

    private static UserConnectionContext parseConnection(String requestJson) {
        Map<String, Object> request = (Map<String, Object>) JSON.deserializeUntyped(requestJson);
        String channelId = (String) request.get('channelId');
        String userId = (String) request.get('integrationUserId');
        String clientId = (String) request.get('clientId');
        String clientSecret = (String) request.get('clientSecret');
        if (String.isBlank(channelId) || String.isBlank(userId) || String.isBlank(clientId) || String.isBlank(clientSecret)) {
            throw PanelSalesforceChannelSupportService.newException('Channel, execution user, ECA consumer key, and ECA consumer secret are required.');
        }
        UserConnectionContext context = resolveIds(channelId, userId);
        context.clientId = clientId;
        context.clientSecret = clientSecret;
        return context;
    }

    private static UserConnectionContext resolveIds(String channelIdentifier, String userIdentifier) {
        UserConnectionContext context = new UserConnectionContext();
        try { context.channelId = (Id) channelIdentifier; } catch (Exception invalidId) {
            throw PanelSalesforceChannelSupportService.newException('Enter a valid Salesforce channel ID.');
        }
        context.userId = PanelSalesforceChannelSupportService.resolveUserId(userIdentifier);
        if (context.userId == null) {
            throw PanelSalesforceChannelSupportService.newException('Enter a valid Salesforce integration user ID.');
        }
        context.channelIdText = String.valueOf(context.channelId);
        context.userIdText = String.valueOf(context.userId);
        return context;
    }

    private static void verifyPreparedUser(UserConnectionContext context) {
        String teamId = PanelAuthSupportService.getConfig().Panel_Team_Id__c;
        List<Tubot_API_Channel__c> prepared = [
            SELECT Id, Team_Id__c FROM Tubot_API_Channel__c
            WHERE Channel_Id__c = :context.channelIdText AND Integration_User_Id__c = :context.userIdText
            WITH USER_MODE LIMIT 1
        ];
        if (prepared.isEmpty() || prepared[0].Team_Id__c != teamId) {
            throw PanelSalesforceChannelSupportService.newException('Prepare API permission for this execution user before connecting its ECA.');
        }
        Id apiPsId = PanelSalesforceChannelSupportService.resolveApiPermissionSetId();
        if (apiPsId == null || [
            SELECT COUNT() FROM PermissionSetAssignment
            WHERE AssigneeId = :context.userId AND PermissionSetId = :apiPsId WITH USER_MODE
        ] == 0) {
            throw PanelSalesforceChannelSupportService.newException('API permission assignment is still being prepared. Retry in a moment.');
        }
    }

    private static void sendConnection(UserConnectionContext context) {
        String path = executionUsersPath(context.channelIdText);
        Map<String, Object> payload = new Map<String, Object>{
            'integrationUserId' => context.userIdText, 'clientId' => context.clientId, 'clientSecret' => context.clientSecret
        };
        HttpResponse response = PanelAuthSupportService.executePanelCallout(path, 'POST', JSON.serialize(payload));
        if (response.getStatusCode() < 200 || response.getStatusCode() >= 300) {
            throw PanelSalesforceChannelSupportService.newException(
                PanelSalesforceChannelSupportService.panelFailure(response, 'Salesforce execution user connection failed')
            );
        }
    }

    private static Tubot_API_Channel__c findConnectedUser(UserConnectionContext context) {
        List<Tubot_API_Channel__c> rows = [
            SELECT Id, Channel_Id__c, Integration_User_Id__c, Assignment_Owned__c, Assignment_Id__c, Team_Id__c
            FROM Tubot_API_Channel__c
            WHERE Channel_Id__c = :context.channelIdText AND Integration_User_Id__c = :context.userIdText
            WITH USER_MODE LIMIT 1
        ];
        if (rows.isEmpty() || rows[0].Team_Id__c != PanelAuthSupportService.getConfig().Panel_Team_Id__c) {
            throw PanelSalesforceChannelSupportService.newException('This execution user is not connected to the active Panel team.');
        }
        return rows[0];
    }

    private static void removeRemoteConnection(UserConnectionContext context) {
        HttpResponse response = PanelAuthSupportService.executePanelCallout(
            executionUsersPath(context.channelIdText), 'DELETE', JSON.serialize(new Map<String, Object>{
                'integrationUserId' => context.userIdText
            })
        );
        if (response.getStatusCode() < 200 || response.getStatusCode() >= 300) {
            throw PanelSalesforceChannelSupportService.newException(
                PanelSalesforceChannelSupportService.panelFailure(response, 'Salesforce execution user disconnect failed')
            );
        }
    }

    private static String executionUsersPath(String channelId) {
        return '/api/v1/salesforce/channels/' + EncodingUtil.urlEncode(channelId, 'UTF-8') +
            '/execution-users?orgId=' + EncodingUtil.urlEncode(UserInfo.getOrganizationId(), 'UTF-8');
    }
}
