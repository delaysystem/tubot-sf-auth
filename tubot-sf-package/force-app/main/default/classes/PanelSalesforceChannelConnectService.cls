/** Registers a prepared Salesforce API channel with Panel. Panel uses the
 * packaged JWT execution client and verifies the pre-authorized user's
 * org and identity before storing the channel. No ECA secrets cross Apex.
 */
public with sharing class PanelSalesforceChannelConnectService {
    private class ConnectionContext {
        private Id channelId;
        private Id userId;
        private String channelIdText;
        private String userIdText;
        private Boolean permissionAssigned;
    }

    public static void connect(String requestJson) {
        PanelSalesforceChannelSupportService.requireAdmin();
        ConnectionContext context = parseRequest(requestJson);
        validateSalesforceTargets(context);
        verifyPreparedChannel(context);
        registerConnection(context);
    }

    private static ConnectionContext parseRequest(String requestJson) {
        Map<String, Object> request = (Map<String, Object>) JSON.deserializeUntyped(requestJson);
        ConnectionContext context = new ConnectionContext();
        String channelId = (String) request.get('channelId');
        String userIdentifier = (String) request.get('integrationUserId');
        validateRequiredConnectionValues(channelId, userIdentifier);
        context.channelId = parseChannelId(channelId);
        context.userId = requireIntegrationUser(userIdentifier);
        context.channelIdText = String.valueOf(context.channelId);
        context.userIdText = String.valueOf(context.userId);
        return context;
    }

    private static void validateRequiredConnectionValues(String channelId, String userIdentifier) {
        if (String.isBlank(channelId) || String.isBlank(userIdentifier)) {
            throw PanelSalesforceChannelSupportService.newException('Channel and integration user are required.');
        }
    }

    private static Id parseChannelId(String channelId) {
        try {
            return (Id) channelId;
        } catch (Exception invalidId) {
            throw PanelSalesforceChannelSupportService.newException('Enter a valid Salesforce channel ID.');
        }
    }

    private static Id requireIntegrationUser(String identifier) {
        Id userId = PanelSalesforceChannelSupportService.resolveUserId(identifier);
        if (userId == null) {
            throw PanelSalesforceChannelSupportService.newException('Enter a valid Salesforce integration user ID or username.');
        }
        return userId;
    }

    private static void validateSalesforceTargets(ConnectionContext context) {
        if (!PanelSalesforceChannelSupportService.messagingChannelExists(context.channelId)) {
            throw PanelSalesforceChannelSupportService.newException('The Messaging Channel does not exist in this Salesforce org.');
        }
        List<User> users = [SELECT Id, IsActive FROM User WHERE Id = :context.userId WITH USER_MODE LIMIT 1];
        if (users.isEmpty() || !users[0].IsActive) {
            throw PanelSalesforceChannelSupportService.newException('Select an active integration user in this org.');
        }
        Id apiPsId = PanelSalesforceChannelSupportService.resolveApiPermissionSetId();
        if (apiPsId == null) { throw PanelSalesforceChannelSupportService.newException('Tubot API permission set is missing from this org.'); }
        context.permissionAssigned = [
            SELECT COUNT() FROM PermissionSetAssignment
            WHERE AssigneeId = :context.userId AND PermissionSetId = :apiPsId WITH USER_MODE
        ] > 0;
    }

    private static void verifyPreparedChannel(ConnectionContext context) {
        String activeTeamId = PanelAuthSupportService.getConfig().Panel_Team_Id__c;
        List<Tubot_API_Channel__c> sameChannel = [
            SELECT Team_Id__c FROM Tubot_API_Channel__c
            WHERE Channel_Id__c = :context.channelIdText WITH USER_MODE
        ];
        for (Tubot_API_Channel__c row : sameChannel) {
            if (row.Team_Id__c != activeTeamId) {
                throw PanelSalesforceChannelSupportService.newException('This channel is already connected to a different Panel team.');
            }
        }
        List<Tubot_API_Channel__c> prepared = [
            SELECT Id FROM Tubot_API_Channel__c
            WHERE Channel_Id__c = :context.channelIdText AND Integration_User_Id__c = :context.userIdText
            WITH USER_MODE LIMIT 1
        ];
        if (prepared.isEmpty()) {
            throw PanelSalesforceChannelSupportService.newException('Prepare the channel API permission before connecting.');
        }
        if (!context.permissionAssigned) {
            throw PanelSalesforceChannelSupportService.newException('API permission assignment is still being prepared. Retry in a moment.');
        }
    }

    private static void registerConnection(ConnectionContext context) {
        User integrationUser = [SELECT Username FROM User WHERE Id = :context.userId WITH USER_MODE LIMIT 1];
        Organization org = [SELECT IsSandbox FROM Organization WITH USER_MODE LIMIT 1];
        Map<String, Object> payload = new Map<String, Object>{
            'orgId' => UserInfo.getOrganizationId(), 'channelId' => context.channelIdText,
            'instanceUrl' => URL.getOrgDomainUrl().toExternalForm(),
            'integrationUserId' => context.userIdText,
            'integrationUsername' => integrationUser.Username,
            'isSandbox' => org.IsSandbox
        };
        HttpResponse response = PanelAuthSupportService.executePanelCallout(
            '/api/v1/salesforce/channels', 'POST', JSON.serialize(payload)
        );
        if (response.getStatusCode() < 200 || response.getStatusCode() >= 300) {
            throw PanelSalesforceChannelSupportService.newException(
                PanelSalesforceChannelSupportService.panelFailure(response, 'Salesforce channel connection failed')
            );
        }
    }
}
