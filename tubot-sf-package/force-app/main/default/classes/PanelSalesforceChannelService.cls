/** Channel-scoped API grant registration. Salesforce credentials are sent once to Panel. */
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
    public static void connectExecutionUser(String requestJson) {
        PanelSalesforceExecutionUserService.connect(requestJson);
    }

    @AuraEnabled
    public static void disconnectExecutionUser(String channelId, String integrationUserId) {
        PanelSalesforceExecutionUserService.disconnect(channelId, integrationUserId);
    }

    @AuraEnabled
    public static void disconnectChannel(String channelId) {
        PanelSalesforceChannelCleanupService.disconnectChannel(channelId);
    }

    public static void clearLocalConnections(String teamId) {
        PanelSalesforceChannelCleanupService.clearLocalConnections(teamId);
    }

}
