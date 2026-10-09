/** Reads MessagingChannel configuration for the package settings screen. */
public with sharing class MessagingConfigurationController {
    @AuraEnabled
    public static List<Map<String, Object>> getMessagingChannels() {
        PanelAuthSupportService.requireSettingsAdmin();
        return SessionFieldsProvisioningService.getMessagingChannels();
    }

}
