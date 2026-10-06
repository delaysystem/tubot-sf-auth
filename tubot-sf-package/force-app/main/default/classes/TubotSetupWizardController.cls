/**
 * @description Controller for Administrator-Driven Setup Wizard.
 * Guides Salesforce System Administrators through org readiness health checks,
 * dedicated integration user discovery & assignment, External Client App (ECA)
 * OAuth policy guidance, and channel API verification.
 */
public with sharing class TubotSetupWizardController {

    public static final String API_READ_PERMISSION_SET = 'Tubot_Salesforce_API_Read';
    public static final String SETTINGS_ADMIN_PERMISSION_SET = 'Panel_Settings_Admin_Access';
    public static final String CHANNEL_ADMIN_PERMISSION_SET = 'Tubot_Channel_Connection_Admin_Access';

    /**
     * @description Returns complete prerequisites and health check status for tubot-sf-auth.
     */
    @AuraEnabled
    public static Map<String, Object> getSetupHealthCheck() {
        PanelAuthSupportService.requireSettingsAdmin();

        // 1. Integration User Licenses check
        Integer totalIntLicenses = 0;
        Integer usedIntLicenses = 0;
        for (UserLicense ul : [
            SELECT TotalLicenses, UsedLicenses
            FROM UserLicense
            WHERE MasterLabel LIKE '%Integration%' OR LicenseDefinitionKey LIKE '%INTEGRATION%'
            WITH USER_MODE
        ]) {
            totalIntLicenses += (ul.TotalLicenses != null ? ul.TotalLicenses : 0);
            usedIntLicenses += (ul.UsedLicenses != null ? ul.UsedLicenses : 0);
        }
        Integer availableIntLicenses = Math.max(0, totalIntLicenses - usedIntLicenses);

        // 2. Packaged Permission Sets check (supporting both unnamespaced and namespaced packaging)
        Map<String, Boolean> psExists = new Map<String, Boolean>{
            API_READ_PERMISSION_SET => false,
            SETTINGS_ADMIN_PERMISSION_SET => false,
            CHANNEL_ADMIN_PERMISSION_SET => false
        };

        for (PermissionSet ps : [
            SELECT Name FROM PermissionSet
            WHERE Name = :API_READ_PERMISSION_SET OR Name LIKE :('%__' + API_READ_PERMISSION_SET)
               OR Name = :SETTINGS_ADMIN_PERMISSION_SET OR Name LIKE :('%__' + SETTINGS_ADMIN_PERMISSION_SET)
               OR Name = :CHANNEL_ADMIN_PERMISSION_SET OR Name LIKE :('%__' + CHANNEL_ADMIN_PERMISSION_SET)
            WITH USER_MODE
        ]) {
            String baseName = ps.Name.contains('__') ? ps.Name.substringAfter('__') : ps.Name;
            if (psExists.containsKey(baseName)) {
                psExists.put(baseName, true);
            }
        }

        // 3. External Client Apps enabled in org
        Boolean isEcaAvailable = Type.forName('Schema.ExternalClientApplication') != null;

        // 4. Panel OAuth Connection status
        MCP_Config__c config = PanelAuthSupportService.getConfig();
        Boolean isPanelConnected = String.isNotBlank(config?.Panel_Team_Id__c);
        String panelTeamName = config?.Panel_Team_Name__c;
        String panelUserEmail = config?.Panel_User_Email__c;

        // 5. Active channel connections count
        Integer channelCount = [SELECT COUNT() FROM Tubot_API_Channel__c WITH USER_MODE];

        return new Map<String, Object>{
            'isPanelConnected' => isPanelConnected,
            'panelTeamName' => panelTeamName,
            'panelUserEmail' => panelUserEmail,
            'isEcaAvailable' => isEcaAvailable,
            'totalIntegrationLicenses' => totalIntLicenses,
            'usedIntegrationLicenses' => usedIntLicenses,
            'availableIntegrationLicenses' => availableIntLicenses,
            'hasApiReadPermissionSet' => psExists.get(API_READ_PERMISSION_SET),
            'hasSettingsAdminPermissionSet' => psExists.get(SETTINGS_ADMIN_PERMISSION_SET),
            'hasChannelAdminPermissionSet' => psExists.get(CHANNEL_ADMIN_PERMISSION_SET),
            'connectedChannelsCount' => channelCount,
            'panelBaseUrl' => PanelAuthSupportService.DEFAULT_PANEL_URL,
            'allPrerequisitesMet' => isPanelConnected && psExists.get(API_READ_PERMISSION_SET)
        };
    }

    /**
     * @description Discovers active integration users and standard users in the org,
     * including whether the required Tubot API Read permission set is assigned.
     */
    @AuraEnabled
    public static List<Map<String, Object>> getIntegrationCandidates() {
        PanelAuthSupportService.requireSettingsAdmin();

        Id apiPsId = resolvePermissionSetId(API_READ_PERMISSION_SET);
        Set<Id> assignedUserIds = new Set<Id>();
        if (apiPsId != null) {
            for (PermissionSetAssignment psa : [
                SELECT AssigneeId FROM PermissionSetAssignment
                WHERE PermissionSetId = :apiPsId
                WITH USER_MODE
            ]) {
                assignedUserIds.add(psa.AssigneeId);
            }
        }

        List<Map<String, Object>> candidates = new List<Map<String, Object>>();
        for (User u : [
            SELECT Id, Name, Username, Email, Profile.Name, UserType, IsActive
            FROM User
            WHERE IsActive = true
                AND UserType IN ('Standard', 'CsnOnly', 'CloudIntegrationUser')
            WITH USER_MODE
            ORDER BY Name ASC
            LIMIT 100
        ]) {
            Boolean isIntegration = (u.Profile != null && (
                u.Profile.Name.containsIgnoreCase('Integration') ||
                u.Profile.Name.containsIgnoreCase('API')
            ));
            candidates.add(new Map<String, Object>{
                'id' => u.Id,
                'name' => u.Name,
                'username' => u.Username,
                'email' => u.Email,
                'profileName' => u.Profile != null ? u.Profile.Name : u.UserType,
                'isIntegrationProfile' => isIntegration,
                'hasApiPermission' => assignedUserIds.contains(u.Id)
            });
        }
        return candidates;
    }

    /**
     * @description Assigns the packaged Tubot API Read permission set to a selected user.
     */
    @AuraEnabled
    public static Map<String, Object> assignApiPermissionSet(String userIdentifier) {
        PanelAuthSupportService.requireSettingsAdmin();

        Id targetUserId = PanelSalesforceChannelSupportService.resolveUserId(userIdentifier);
        if (targetUserId == null) {
            throw new AuraHandledException('Invalid or non-existent user identifier: ' + userIdentifier);
        }

        Id psId = resolvePermissionSetId(API_READ_PERMISSION_SET);
        if (psId == null) {
            throw new AuraHandledException('Permission Set ' + API_READ_PERMISSION_SET + ' is missing from this org.');
        }

        List<PermissionSetAssignment> existing = [
            SELECT Id FROM PermissionSetAssignment
            WHERE AssigneeId = :targetUserId AND PermissionSetId = :psId
            WITH USER_MODE
            LIMIT 1
        ];

        if (existing.isEmpty()) {
            PermissionSetAssignment psa = new PermissionSetAssignment(
                AssigneeId = targetUserId,
                PermissionSetId = psId
            );
            Database.insert(psa, AccessLevel.USER_MODE);
        }

        return new Map<String, Object>{
            'success' => true,
            'userId' => String.valueOf(targetUserId),
            'permissionSet' => API_READ_PERMISSION_SET,
            'isAssigned' => true
        };
    }

    /**
     * @description Returns ECA configuration details and guidelines for AppExchange compliance.
     */
    @AuraEnabled
    public static Map<String, Object> getEcaSetupGuidance() {
        PanelAuthSupportService.requireSettingsAdmin();

        return new Map<String, Object>{
            'recommendedAppName' => 'Tubot_SF_Channel_API',
            'recommendedAppLabel' => 'Tubot SF Channel API',
            'requiredScopes' => 'Api, OpenID, RefreshToken',
            'oauthFlow' => 'Client Credentials Flow',
            'callbackUrl' => PanelAuthSupportService.DEFAULT_PANEL_URL + '/oauth/callback',
            'setupUrl' => '/lightning/setup/ExternalClientApps/home'
        };
    }

    /**
     * @description Prepares a channel and enqueues API permission assignment.
     */
    @AuraEnabled
    public static Map<String, Object> prepareChannel(String channelId, String userIdentifier) {
        PanelSalesforceChannelService.prepareChannel(channelId, userIdentifier);
        return new Map<String, Object>{
            'success' => true,
            'channelId' => channelId,
            'userIdentifier' => userIdentifier
        };
    }

    /**
     * @description Connects and registers channel credentials with the Panel service.
     */
    @AuraEnabled
    public static Map<String, Object> connectChannel(String requestJson) {
        PanelSalesforceChannelService.connectChannel(requestJson);
        return new Map<String, Object>{
            'success' => true
        };
    }

    private static Id resolvePermissionSetId(String baseName) {
        List<PermissionSet> sets = [
            SELECT Id, Name FROM PermissionSet
            WHERE Name = :baseName OR Name LIKE :('%__' + baseName)
            WITH USER_MODE
            LIMIT 1
        ];
        return sets.isEmpty() ? null : sets[0].Id;
    }
}
