/** Identity and direct package permission check for Salesforce OAuth connections. */
@RestResource(urlMapping='/panel-settings-access/v1')
global with sharing class PanelSettingsAccessResource {
    @HttpGet
    global static void getAccess() {
        Boolean authorized = PanelAuthSupportService.checkManageTubotPermission();
        RestContext.response.statusCode = authorized ? 200 : 403;
        RestContext.response.addHeader('Content-Type', 'application/json');
        RestContext.response.addHeader('Cache-Control', 'no-store');
        RestContext.response.responseBody = Blob.valueOf(JSON.serialize(new Map<String, Object>{
            'organization_id' => UserInfo.getOrganizationId(),
            'user_id' => UserInfo.getUserId(),
            'authorized' => authorized
        }));
    }
}
