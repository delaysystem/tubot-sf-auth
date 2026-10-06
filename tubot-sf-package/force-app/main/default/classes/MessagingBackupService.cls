/**
 * @description Autonomous Backup and Restore Engine for all messaging-related configurations.
 * 
 * Captures point-in-time snapshots of:
 *  1. MessagingSession custom fields (Schema describe + Tooling API CustomField metadata + FieldPermissions).
 *  2. Embedded Service Web Chat deployments (EmbeddedServiceConfig, EmbeddedServiceCustomComponent, LWR sites).
 *  3. Messaging Channels (MessagingChannel records, routing handlers, fallback queues, routing types).
 *  4. Queues & Queue SObjects (Group records of Type 'Queue', QueueSobject mappings, group memberships).
 *  5. Skills & Skill routing (Skill records, SkillUser assignments, QueueRoutingConfig).
 *  6. Omni-Flow routing definitions (FlowDefinitionView, active versions, flow definitions).
 *  7. Custom Settings & Custom Metadata (Agentforce_Agent_Select__c, Tubot_Setting__mdt, Messaging_Config__c).
 * 
 * Supports automatic execution upon "Apply" in the Step-by-Step setup page and manual point-in-time backup/restore.
 */
public with sharing class MessagingBackupService {

    public static final String TRIGGER_AUTOMATIC_APPLY = 'Automatic (Apply)';
    public static final String TRIGGER_MANUAL = 'Manual';
    public static final String STATUS_ACTIVE = 'Active';
    public static final String STATUS_RESTORED = 'Restored';
    public static final Integer MAX_FIELD_LENGTH = 130000;

    /**
     * @description Captures a complete snapshot of all messaging configurations in memory without performing any DML.
     * Safe to invoke before subsequent HTTP callouts.
     */
    public static Map<String, Object> captureSnapshot(String requestJson) {
        return MessagingBackupCaptureService.captureSnapshot(requestJson);
    }

    public static Map<String, Object> saveBackupRecord(String requestJson) {
        requireSettingsAdmin();
        Map<String, Object> request = (Map<String, Object>) JSON.deserializeUntyped(requestJson);
        return MessagingBackupRecordService.save(request);
    }

    public static Map<String, Object> createBackup(String requestJson) {
        requireSettingsAdmin();
        Map<String, Object> request = (Map<String, Object>) JSON.deserializeUntyped(requestJson);
        Map<String, Object> snapshot = captureSnapshot(JSON.serialize(request));
        if (snapshot != null && snapshot.get('success') == true) {
            request.put('snapshotRes', snapshot);
            return MessagingBackupRecordService.save(request);
        }
        return snapshot;
    }

    /**
     * @description Returns all saved backups formatted for LWC presentation.
     */
    @AuraEnabled
    public static List<Map<String, Object>> getBackups() {
        requireSettingsAdmin();
        List<Map<String, Object>> listResult = new List<Map<String, Object>>();
        try {
            List<Messaging_Backup__c> records = [
                SELECT Id, Name, Backup_Name__c, Trigger_Type__c, Deployment_Name__c, Status__c, Item_Summary__c, Restored_At__c, Notes__c, CreatedDate
                FROM Messaging_Backup__c
                WITH USER_MODE
                ORDER BY CreatedDate DESC
                LIMIT 100
            ];

            for (Messaging_Backup__c r : records) {
                Boolean isAuto = (r.Trigger_Type__c != null && r.Trigger_Type__c.contains('Automatic'));
                Boolean isRestored = (r.Status__c == STATUS_RESTORED);

                String triggerBadgeClass = isAuto ? 'slds-badge slds-theme_alt-inverse font-bold' : 'slds-badge slds-theme_info font-bold';
                String statusBadgeClass = isRestored ? 'slds-badge slds-theme_success font-bold' : 'slds-badge slds-theme_default font-bold';

                listResult.add(new Map<String, Object>{
                    'id' => r.Id,
                    'name' => r.Name,
                    'backupName' => r.Backup_Name__c,
                    'triggerType' => r.Trigger_Type__c,
                    'deploymentName' => r.Deployment_Name__c,
                    'status' => r.Status__c,
                    'itemSummary' => r.Item_Summary__c,
                    'notes' => r.Notes__c,
                    'isAuto' => isAuto,
                    'isRestored' => isRestored,
                    'triggerBadgeClass' => triggerBadgeClass,
                    'statusBadgeClass' => statusBadgeClass,
                    'createdDate' => r.CreatedDate != null ? r.CreatedDate.format('yyyy-MM-dd HH:mm:ss') : '',
                    'restoredAt' => r.Restored_At__c != null ? r.Restored_At__c.format('yyyy-MM-dd HH:mm:ss') : null
                });
            }
        } catch (Exception ex) {
            System.debug('Error in getBackups: ' + ex.getMessage());
        }
        return listResult;
    }

    /**
     * @description Retrieves the full JSON payload and item breakdown for a specific backup.
     */
    @AuraEnabled
    public static Map<String, Object> getBackupDetails(String backupId) {
        requireSettingsAdmin();
        Map<String, Object> result = new Map<String, Object>();
        if (String.isBlank(backupId)) { return result; }

        try {
            Messaging_Backup__c rec = [
                SELECT Id, Name, Backup_Name__c, Trigger_Type__c, Deployment_Name__c, Status__c, Item_Summary__c, Restored_At__c, Notes__c, CreatedDate, Backup_Data__c, Backup_Data_Part2__c
                FROM Messaging_Backup__c
                WHERE Id = :backupId
                WITH USER_MODE
                LIMIT 1
            ];

            String fullJson = (rec.Backup_Data__c != null ? rec.Backup_Data__c : '') + (rec.Backup_Data_Part2__c != null ? rec.Backup_Data_Part2__c : '');
            Map<String, Object> parsed = (Map<String, Object>) JSON.deserializeUntyped(fullJson);

            result.put('id', rec.Id);
            result.put('name', rec.Name);
            result.put('backupName', rec.Backup_Name__c);
            result.put('triggerType', rec.Trigger_Type__c);
            result.put('deploymentName', rec.Deployment_Name__c);
            result.put('status', rec.Status__c);
            result.put('itemSummary', rec.Item_Summary__c);
            result.put('createdDate', rec.CreatedDate != null ? rec.CreatedDate.format('yyyy-MM-dd HH:mm:ss') : '');
            result.put('notes', rec.Notes__c);
            result.put('rawJson', fullJson);
            result.put('snapshot', parsed);
            result.put('metadata', parsed.get('metadata'));
            result.put('success', true);
        } catch (Exception ex) {
            result.put('success', false);
            result.put('error', ex.getMessage());
        }

        return result;
    }

    /**
     * @description Restores all messaging-related configurations from a saved backup snapshot.
     */
    @AuraEnabled
    public static Map<String, Object> restoreBackup(String backupId, String sessionTokenOverride) {
        return MessagingBackupRestoreService.restoreBackup(backupId, sessionTokenOverride);
    }

    public static Map<String, Object> deleteBackup(String backupId) {
        requireSettingsAdmin();
        if (!Schema.sObjectType.Messaging_Backup__c.isDeletable()) {
            throw new AuraHandledException('You do not have permission to delete messaging backups.');
        }
        Map<String, Object> res = new Map<String, Object>();
        try {
            List<Messaging_Backup__c> records = [
                SELECT Id FROM Messaging_Backup__c WHERE Id = :backupId WITH USER_MODE LIMIT 1
            ];
            Database.delete(records, AccessLevel.USER_MODE);
            res.put('success', true);
            res.put('message', 'Backup deleted successfully.');
        } catch (Exception ex) {
            res.put('success', false);
            res.put('error', ex.getMessage());
        }
        return res;
    }

    private static void requireSettingsAdmin() {
        if (!PanelAuthSupportService.checkManageTubotPermission()) {
            throw new AuraHandledException('You do not have permission to manage TuBot messaging backups.');
        }
    }

    // =========================================================================
    // CAPTURE HELPERS
    // =========================================================================


}
