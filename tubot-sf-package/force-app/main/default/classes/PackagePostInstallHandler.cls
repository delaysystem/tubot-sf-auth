/**
 * @description Post-install script executed during package installation/upgrade.
 * Declared without sharing to perform system-level setup of org defaults and permissions.
 */
public without sharing class PackagePostInstallHandler implements System.InstallHandler {
    
    /**
     * @description Executed automatically by Salesforce whenever the package is deployed or installed.
     * Automatically initializes Messaging_Config__c org defaults and assigns permission sets.
     */
    public void onInstall(System.InstallContext context) {
        initializeOrgDefaults();
        setupExternalCredentials();
        Id installerId = context == null ? null : context.installerId();
        if (installerId != null) {
            assignAdminPermissionSet(installerId);
        }
    }

    /**
     * @description Ensures External Credentials and Named Credentials framework is automatically
     * initialized upon installation, assigns Panel_Settings_Admin_Access with principal access,
     * and seeds MCP_Config__c defaults.
     */
    @TestVisible
    private static void setupExternalCredentials() {
        try {
            MCP_Config__c mcpConfig = MCP_Config__c.getOrgDefaults();
            if (mcpConfig == null) {
                mcpConfig = new MCP_Config__c();
            }
            Boolean isModified = false;
            if (String.isBlank(mcpConfig.Panel_Base_URL__c)) {
                mcpConfig.Panel_Base_URL__c = PanelAuthSupportService.DEFAULT_PANEL_URL;
                isModified = true;
            }
            if (String.isBlank(mcpConfig.Panel_Client_Id__c)) {
                mcpConfig.Panel_Client_Id__c = PanelAuthSupportService.DEFAULT_CLIENT_ID;
                isModified = true;
            }
            if (isModified || mcpConfig.Id == null) {
                Database.upsert(mcpConfig, AccessLevel.USER_MODE);
                System.debug('>>> [PackagePostInstallHandler] Initialized MCP_Config__c defaults for External Credentials.');
            }
        } catch (Exception ex) {
            System.debug('>>> [PackagePostInstallHandler] External Credentials setup note: ' + ex.getMessage());
        }
    }

    /**
     * @description Initializes Messaging_Config__c Custom Setting org defaults.
     */
    @TestVisible
    private static void initializeOrgDefaults() {
        Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
        if (config == null) {
            config = new Messaging_Config__c();
        }
        Boolean isModified = PackagePostInstallDefaultsService.applyMessagingDefaults(config);
        if (isModified || config.Id == null) { saveMessagingDefaults(config); }
    }

    private static void saveMessagingDefaults(Messaging_Config__c config) {
        Database.upsert(config, AccessLevel.USER_MODE);
        System.debug('>>> [PackagePostInstallHandler] Successfully initialized Messaging_Config__c org defaults.');
    }

    /**
     * @description Assigns Panel_Settings_Admin_Access permission set to the user who installed the package.
     */
    @TestVisible
    private static void assignAdminPermissionSet(Id installerId) {
        // Keep setup-object DML out of the install transaction, which also updates custom settings.
        PackageAdminPermissionAssignmentService.assignToInstaller(installerId);
    }

}
