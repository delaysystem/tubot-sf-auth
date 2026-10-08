/** Channel-scoped API grant registration. The org never handles ECA secrets:
 * Panel mints tokens with the packaged universal execution client and
 * verifies the subscriber-configured Run As user during registration.
 */
public with sharing class PanelSalesforceChannelService {
    public static final String PERMISSION_SET = PanelSalesforceChannelSupportService.PERMISSION_SET;

    @AuraEnabled
    public static List<Map<String, String>> listConnections() {
        return PanelSalesforceChannelQueryService.listConnections();
    }

    @AuraEnabled
    public static List<String> getToolProxyList(String channelId) {
        return PanelSalesforceChannelQueryService.getToolProxyList(channelId);
    }

    @AuraEnabled
    public static void prepareChannel(String channelId, String integrationUserId) {
        PanelSalesforceChannelPreparationService.prepare(channelId, integrationUserId);
    }

    @AuraEnabled
    public static Boolean isApiPermissionReady(String integrationUserId) {
        PanelSalesforceChannelSupportService.requireAdmin();
        if (String.isBlank(integrationUserId)) { return false; }
        Id selectedUserId = PanelSalesforceChannelSupportService.resolveUserId(integrationUserId);
        if (selectedUserId == null) { return false; }
        Id apiPsId = PanelSalesforceChannelSupportService.resolveApiPermissionSetId();
        if (apiPsId == null) { return false; }
        return [SELECT COUNT() FROM PermissionSetAssignment WHERE AssigneeId = :selectedUserId
            AND PermissionSetId = :apiPsId WITH USER_MODE ] != 0;
    }

    @AuraEnabled
    public static void connectChannel(String requestJson) {
        PanelSalesforceChannelConnectService.connect(requestJson);
    }

    @AuraEnabled
    public static void disconnectChannel(String channelId) {
        PanelSalesforceChannelCleanupService.disconnectChannel(channelId);
    }

    public static void clearLocalConnections(String teamId) {
        PanelSalesforceChannelCleanupService.clearLocalConnections(teamId);
    }

}
