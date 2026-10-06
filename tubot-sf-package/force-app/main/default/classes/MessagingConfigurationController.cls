/** Apex actions for routing metadata, MessagingChannel configuration, and t2 flow setup. */
public with sharing class MessagingConfigurationController {
    @AuraEnabled
    public static List<Map<String, Object>> getMessagingChannels() {
        PanelAuthSupportService.requireSettingsAdmin();
        return SessionFieldsProvisioningService.getMessagingChannels();
    }

    @AuraEnabled
    public static Map<String, Object> setChannelOmniFlow(Id channelId) {
        TubotPackageFeatureGate.reject('Omni-Channel routing settings');
        return null;
    }

    @AuraEnabled
    public static Map<String, Object> getTubotSettings() {
        TubotPackageFeatureGate.reject('Agentforce routing settings');
        return null;
    }

    @AuraEnabled
    public static Map<String, Object> saveTubotSettings(String settingsJson) {
        TubotPackageFeatureGate.reject('Agentforce routing settings');
        return null;
    }

    @AuraEnabled
    public static Map<String, Object> activateOmniChannelSkillsAndCapacitySettings() {
        TubotPackageFeatureGate.reject('Omni-Channel routing settings');
        return null;
    }

    @AuraEnabled
    public static Map<String, Object> getT2SubflowConfig(String sessionTokenOverride) {
        TubotPackageFeatureGate.reject('Agentforce routing settings');
        return null;
    }

    @AuraEnabled
    public static Map<String, Object> updateT2SubflowAndActivate(String targetFlowApiName, String sessionTokenOverride) {
        TubotPackageFeatureGate.reject('Agentforce routing settings');
        return null;
    }
}
