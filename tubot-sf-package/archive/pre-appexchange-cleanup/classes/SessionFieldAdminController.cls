/** Apex actions for provisioning and reviewing MessagingSession fields and actions. */
public with sharing class SessionFieldAdminController {
    @AuraEnabled
    public static Map<String, Object> createSessionFields(String requestJson) {
        TubotPackageFeatureGate.reject('Embedded Messaging setup');
        PanelAuthSupportService.requireSettingsAdmin();
        return SessionFieldsProvisioningService.createSessionFields(requestJson);
    }

    @AuraEnabled
    public static Map<String, Object> verifySessionFieldsAccess(String aiPermSetDevName, String agentPermSetDevName, String targetUserIdentifier) {
        TubotPackageFeatureGate.reject('Embedded Messaging setup');
        PanelAuthSupportService.requireSettingsAdmin();
        return SessionFieldsProvisioningService.verifySessionFieldsAccess(aiPermSetDevName, agentPermSetDevName, targetUserIdentifier);
    }

    @AuraEnabled
    public static Map<String, Object> getSessionFieldsStatus(String aiPermSetDevName, String agentPermSetDevName) {
        TubotPackageFeatureGate.reject('Embedded Messaging setup');
        PanelAuthSupportService.requireSettingsAdmin();
        return SessionFieldsProvisioningService.getSessionFieldsStatus(aiPermSetDevName, agentPermSetDevName);
    }

    @AuraEnabled
    public static Map<String, Object> addEscalateButtonToMessagingSessionPage(String sessionTokenOverride) {
        TubotPackageFeatureGate.reject('Chat handling and human escalation');
        PanelAuthSupportService.requireSettingsAdmin();
        return SessionFieldsProvisioningService.addEscalateButtonToMessagingSessionPage(sessionTokenOverride);
    }

    @AuraEnabled
    public static Map<String, Object> getEscalateButtonStatus(String sessionTokenOverride) {
        TubotPackageFeatureGate.reject('Chat handling and human escalation');
        PanelAuthSupportService.requireSettingsAdmin();
        return SessionFieldsProvisioningService.getEscalateButtonStatus(sessionTokenOverride);
    }

    @AuraEnabled
    public static Map<String, Object> escalateSessionRecord(String requestJson) {
        TubotPackageFeatureGate.reject('Chat handling and human escalation');
        return SessionFieldsProvisioningService.escalateSessionRecord(requestJson);
    }
}
