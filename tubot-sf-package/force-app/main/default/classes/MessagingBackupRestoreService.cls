/** Coordinates callout-first restores from a user-owned messaging backup. */
public with sharing class MessagingBackupRestoreService {
    private class RestoreContext {
        private String backupId;
        private String sessionTokenOverride;
        private String baseUrl;
        private Messaging_Backup__c backup;
        private Map<String, Object> snapshot;
        private List<String> logs = new List<String>();
        private Map<String, Object> result = new Map<String, Object>();
    }

    public static Map<String, Object> restoreBackup(String backupId, String sessionTokenOverride) {
        PanelAuthSupportService.requireSettingsAdmin();
        RestoreContext context = initialize(backupId, sessionTokenOverride);
        if (String.isBlank(context.backupId)) { return invalidBackup(context); }
        try {
            context.backup = loadBackup(context.backupId);
            context.snapshot = parseSnapshot(context.backup);
            context.baseUrl = Url.getOrgDomainUrl().toExternalForm();
            logSnapshot(context);
            restoreFlowAndFieldMetadata(context);
            restoreWebComponentsAndChannels(context);
            restoreDatabaseSettings(context);
            completeRestore(context);
        } catch (Exception ex) {
            recordFailure(context, ex);
        }
        return context.result;
    }

    private static RestoreContext initialize(String backupId, String sessionTokenOverride) {
        RestoreContext context = new RestoreContext();
        context.backupId = backupId;
        context.sessionTokenOverride = sessionTokenOverride;
        context.result.put('logs', context.logs);
        return context;
    }

    private static Map<String, Object> invalidBackup(RestoreContext context) {
        context.result.put('success', false);
        context.result.put('error', 'Backup ID cannot be blank.');
        return context.result;
    }

    private static Messaging_Backup__c loadBackup(String backupId) {
        return [
            SELECT Id, Name, Backup_Name__c, Trigger_Type__c, Deployment_Name__c, Status__c,
                Item_Summary__c, CreatedDate, Backup_Data__c, Backup_Data_Part2__c
            FROM Messaging_Backup__c
            WHERE Id = :backupId WITH USER_MODE LIMIT 1
        ];
    }

    private static Map<String, Object> parseSnapshot(Messaging_Backup__c backup) {
        String data = (backup.Backup_Data__c == null ? '' : backup.Backup_Data__c) +
            (backup.Backup_Data_Part2__c == null ? '' : backup.Backup_Data_Part2__c);
        return (Map<String, Object>) JSON.deserializeUntyped(data);
    }

    private static void logSnapshot(RestoreContext context) {
        context.logs.add('[Init] Loaded backup ' + context.backup.Name + ' (' + context.backup.Item_Summary__c + ').');
    }

    private static void restoreFlowAndFieldMetadata(RestoreContext context) {
        List<Object> flows = (List<Object>) context.snapshot.get('flows');
        if (flows != null && !flows.isEmpty()) {
            MessagingBackupRestoreFlowService.restoreFlows(flows, context.sessionTokenOverride, context.logs);
        }
        List<Object> fields = (List<Object>) context.snapshot.get('messagingSessionFields');
        if (fields != null && !fields.isEmpty()) {
            MessagingBackupRestoreToolingService.restoreSessionFields(fields, context.sessionTokenOverride, context.logs);
        }
    }

    private static void restoreWebComponentsAndChannels(RestoreContext context) {
        List<Object> components = (List<Object>) context.snapshot.get('customComponents');
        if (components == null || components.isEmpty()) {
            context.logs.add('No embedded custom component assignments were present in this backup.');
        } else {
            MessagingBackupRestoreToolingService.restoreCustomComponents(components, context.logs);
        }
        List<Object> channels = (List<Object>) context.snapshot.get('channels');
        if (channels == null || channels.isEmpty()) {
            context.logs.add('No Messaging Channel routing records were present in this backup.');
        } else {
            MessagingBackupRestoreRoutingService.restoreMessagingChannels(channels, context.baseUrl, context.logs);
        }
    }

    private static void restoreDatabaseSettings(RestoreContext context) {
        List<Object> mappings = (List<Object>) context.snapshot.get('agentSelectSettings');
        if (mappings != null && !mappings.isEmpty()) {
            MessagingBackupRestoreSettingsService.restoreAgentSelectSettings(mappings, context.logs);
        }
        List<Object> queues = (List<Object>) context.snapshot.get('queues');
        List<Object> queueTypes = (List<Object>) context.snapshot.get('queueSobjects');
        if (queues != null || queueTypes != null) {
            MessagingBackupRestoreRoutingService.restoreQueues(queues, queueTypes, context.logs);
        }
        Map<String, Object> settings = (Map<String, Object>) context.snapshot.get('tubotSettings');
        if (settings != null) {
            MessagingBackupRestoreSettingsService.restoreTubotSettings(settings, context.logs);
        }
        Map<String, Object> messaging = (Map<String, Object>) context.snapshot.get('messagingConfig');
        if (messaging != null) {
            MessagingBackupRestoreSettingsService.restoreMessagingSettings(messaging, context.logs);
        }
    }

    private static void completeRestore(RestoreContext context) {
        context.backup.Status__c = MessagingBackupService.STATUS_RESTORED;
        context.backup.Restored_At__c = System.now();
        Database.update(context.backup, AccessLevel.USER_MODE);
        context.logs.add('Messaging configuration restore completed for backup ' + context.backup.Name + '.');
        context.result.put('success', true);
        context.result.put('message', 'Successfully restored messaging configuration from backup ' +
            context.backup.Name + ' (' + context.backup.Item_Summary__c + ').');
        context.result.put('restoredBackupReference', context.backup.Name);
        context.result.put('restoredAt', context.backup.Restored_At__c);
    }

    private static void recordFailure(RestoreContext context, Exception error) {
        context.logs.add('Restore execution failed: ' + error.getMessage());
        context.result.put('success', false);
        context.result.put('error', error.getMessage());
    }
}