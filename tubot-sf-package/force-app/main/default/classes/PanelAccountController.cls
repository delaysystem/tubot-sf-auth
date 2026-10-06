/** Reads account and team details for the connected Panel tenant. */
public with sharing class PanelAccountController {
    @AuraEnabled
    public static Map<String, Object> fetchPanelSubscriptionData() {
        PanelAuthSupportService.requireSettingsAdmin();
        requireConnectedPanel();
        HttpResponse response = PanelAuthSupportService.executePanelCallout('/api/v1/subscription', 'GET', null);
        if (response.getStatusCode() == 200) { return (Map<String, Object>) JSON.deserializeUntyped(response.getBody()); }
        throw new AuraHandledException('Failed to fetch subscription: ' + response.getBody());
    }

    @AuraEnabled
    public static Map<String, Object> fetchPanelTeamMembers() {
        PanelAuthSupportService.requireSettingsAdmin();
        requireConnectedPanel();
        HttpResponse response = PanelAuthSupportService.executePanelCallout('/api/v1/team/members', 'GET', null);
        if (response.getStatusCode() == 200) { return (Map<String, Object>) JSON.deserializeUntyped(response.getBody()); }
        throw new AuraHandledException('Failed to fetch team members: ' + response.getBody());
    }

    private static void requireConnectedPanel() {
        Map<String, Object> status = PanelAuthController.getPanelAuthStatus();
        if (!(Boolean) status.get('hasAccessToken')) {
            throw new AuraHandledException('Panel is not connected. Please log in first.');
        }
    }
}
