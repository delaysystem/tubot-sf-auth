/** Apex actions for creating, restoring, inspecting, and deleting messaging backups. */
public with sharing class MessagingBackupController {
    @AuraEnabled
    public static List<Map<String, Object>> getMessagingBackups() {
        PanelAuthSupportService.requireSettingsAdmin();
        return MessagingBackupService.getBackups();
    }

    @AuraEnabled
    public static Map<String, Object> createManualBackup(String requestJson) {
        PanelAuthSupportService.requireSettingsAdmin();
        Map<String, Object> request = (Map<String, Object>) JSON.deserializeUntyped(requestJson);
        request.put('triggerType', MessagingBackupService.TRIGGER_MANUAL);
        return MessagingBackupService.createBackup(JSON.serialize(request));
    }

    @AuraEnabled
    public static Map<String, Object> restoreMessagingBackup(String backupId, String sessionTokenOverride) {
        PanelAuthSupportService.requireSettingsAdmin();
        return MessagingBackupService.restoreBackup(backupId, sessionTokenOverride);
    }

    @AuraEnabled
    public static Map<String, Object> getMessagingBackupDetails(String backupId) {
        PanelAuthSupportService.requireSettingsAdmin();
        return MessagingBackupService.getBackupDetails(backupId);
    }

    @AuraEnabled
    public static Map<String, Object> deleteMessagingBackup(String backupId) {
        PanelAuthSupportService.requireSettingsAdmin();
        if (!Schema.sObjectType.Messaging_Backup__c.isDeletable()) {
            throw new AuraHandledException('You do not have permission to delete messaging backups.');
        }
        return MessagingBackupService.deleteBackup(backupId);
    }
}
