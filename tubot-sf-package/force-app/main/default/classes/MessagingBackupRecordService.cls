/** Persists captured snapshots as user-owned Messaging_Backup__c records. */
public with sharing class MessagingBackupRecordService {
    public static Map<String, Object> save(Map<String, Object> request) {
        PanelAuthSupportService.requireSettingsAdmin();
        Map<String, Object> snapshot = (Map<String, Object>) request.get('snapshotRes');
        List<String> logs = snapshot == null ? new List<String>() : (List<String>) snapshot.get('logs');
        if (logs == null) { logs = new List<String>(); }
        try {
            Messaging_Backup__c pending = buildRecord(request, snapshot);
            Database.insert(pending, AccessLevel.USER_MODE);
            Messaging_Backup__c saved = loadRecord(pending.Id);
            return successResult(saved, snapshot, logs);
        } catch (Exception ex) {
            return failureResult(logs, ex);
        }
    }

    private static Messaging_Backup__c buildRecord(Map<String, Object> request, Map<String, Object> snapshot) {
        Messaging_Backup__c record = new Messaging_Backup__c();
        record.Backup_Name__c = valueOrSnapshot(request, snapshot, 'backupName');
        record.Trigger_Type__c = valueOrSnapshot(request, snapshot, 'triggerType');
        record.Deployment_Name__c = valueOrSnapshot(request, snapshot, 'deploymentName');
        record.Status__c = MessagingBackupService.STATUS_ACTIVE;
        record.Item_Summary__c = snapshot == null ? null : (String) snapshot.get('itemSummary');
        record.Backup_Data__c = snapshot == null ? null : (String) snapshot.get('chunk1');
        String chunk2 = snapshot == null ? null : (String) snapshot.get('chunk2');
        if (String.isNotBlank(chunk2)) { record.Backup_Data_Part2__c = chunk2; }
        String notes = (String) request.get('notes');
        record.Notes__c = String.isNotBlank(notes) ? notes.abbreviate(255) :
            (snapshot == null ? null : (String) snapshot.get('notes'));
        return record;
    }

    private static String valueOrSnapshot(Map<String, Object> request, Map<String, Object> snapshot, String key) {
        String value = (String) request.get(key);
        if (String.isNotBlank(value)) { return value; }
        return snapshot == null ? null : (String) snapshot.get(key);
    }

    private static Messaging_Backup__c loadRecord(Id recordId) {
        return [
            SELECT Id, Name, Backup_Name__c, Trigger_Type__c, Deployment_Name__c, Status__c, Item_Summary__c, CreatedDate
            FROM Messaging_Backup__c
            WHERE Id = :recordId WITH USER_MODE
        ];
    }

    private static Map<String, Object> successResult(
        Messaging_Backup__c saved,
        Map<String, Object> snapshot,
        List<String> logs
    ) {
        logs.add('Messaging configuration backup saved: ' + saved.Name + ' (' + saved.Item_Summary__c + ').');
        return new Map<String, Object>{
            'success' => true, 'logs' => logs, 'backupId' => saved.Id, 'backupReference' => saved.Name,
            'backupName' => saved.Backup_Name__c, 'triggerType' => saved.Trigger_Type__c,
            'deploymentName' => saved.Deployment_Name__c, 'status' => saved.Status__c,
            'itemSummary' => saved.Item_Summary__c, 'timestamp' => snapshot == null ? null : snapshot.get('timestamp'),
            'counts' => snapshot == null ? null : snapshot.get('counts'),
            'message' => 'Backup "' + saved.Name + '" captured successfully (' + saved.Item_Summary__c + ').'
        };
    }

    private static Map<String, Object> failureResult(List<String> logs, Exception error) {
        logs.add('Backup persistence failed: ' + error.getMessage());
        return new Map<String, Object>{ 'success' => false, 'logs' => logs, 'error' => error.getMessage() };
    }
}