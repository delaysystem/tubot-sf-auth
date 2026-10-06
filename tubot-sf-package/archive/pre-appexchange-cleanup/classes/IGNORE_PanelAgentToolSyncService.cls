/** Requests a tenant-scoped tool index refresh through the configured Panel connection. */
public with sharing class IGNORE_PanelAgentToolSyncService {
    public static Map<String, Object> forceSync() {
        Map<String, Object> status = PanelAuthController.getPanelAuthStatus();
        if (!(Boolean) status.get('canEditSettings')) {
            throw new AuraHandledException('The connected Panel account must have edit-salesforce-settings permission.');
        }
        HttpResponse response = PanelAuthSupportService.executePanelCallout('/api/tools/sync', 'POST', JSON.serialize(new Map<String, Object>{
            'tenantId' => status.get('teamId'), 'orgId' => UserInfo.getOrganizationId()
        }));
        if (response.getStatusCode() != 200) {
            return new Map<String, Object>{ 'success' => false, 'statusCode' => response.getStatusCode(), 'message' => response.getBody() };
        }
        return (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
    }
}
