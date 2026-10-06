/** Captures Salesforce messaging configuration by feature area for backup snapshots. */
public with sharing class MessagingBackupCaptureService {
    private class SnapshotContext {
        private String triggerType;
        private String notes;
        private String deploymentName;
        private String sessionTokenOverride;
        private String baseUrl;
        private String timestamp;
        private String backupName;
        private String itemSummary;
        private Map<String, Object> snapshot = new Map<String, Object>();
        private Map<String, Object> counts = new Map<String, Object>();
        private List<String> logs = new List<String>();
    }

    public static Map<String, Object> captureSnapshot(String requestJson) {
        PanelAuthSupportService.requireSettingsAdmin();
        SnapshotContext context = initializeContext(requestJson);
        Map<String, Object> result = new Map<String, Object>{ 'logs' => context.logs };
        try {
            captureIdentityAndDeployment(context);
            captureRoutingConfiguration(context);
            captureMessagingSettings(context);
            buildSnapshotMetadata(context);
            addSnapshotResults(result, context);
        } catch (Exception ex) {
            context.logs.add('Snapshot capture failed: ' + ex.getMessage());
            result.put('success', false);
            result.put('error', ex.getMessage());
        }
        return result;
    }

    private static SnapshotContext initializeContext(String requestJson) {
        Map<String, Object> request = (Map<String, Object>) JSON.deserializeUntyped(requestJson);
        SnapshotContext context = new SnapshotContext();
        context.triggerType = (String) request.get('triggerType');
        context.notes = (String) request.get('notes');
        context.deploymentName = (String) request.get('deploymentName');
        context.sessionTokenOverride = (String) request.get('sessionTokenOverride');
        if (String.isBlank(context.triggerType)) { context.triggerType = MessagingBackupService.TRIGGER_MANUAL; }
        context.baseUrl = Url.getOrgDomainUrl().toExternalForm();
        DateTime now = System.now();
        context.timestamp = now.formatGmt('yyyy-MM-dd\'T\'HH:mm:ss\'Z\'');
        context.backupName = 'Backup_' + now.formatGmt('yyyyMMdd_HHmmss') +
            (String.isNotBlank(context.deploymentName) ? '_' + context.deploymentName.replaceAll('[^a-zA-Z0-9_]', '') : '');
        context.logs.add('=== MESSAGING CONFIGURATION BACKUP ENGINE ===');
        context.logs.add('[Init] Trigger: ' + context.triggerType + ' | Deployment Scope: ' +
            (String.isNotBlank(context.deploymentName) ? context.deploymentName : 'Org-Wide'));
        context.logs.add('[Init] Org URL: ' + context.baseUrl);
        return context;
    }

    private static void captureIdentityAndDeployment(SnapshotContext context) {
        context.logs.add('[1/7] Capturing MessagingSession fields and field access...');
        List<Map<String, Object>> fields = MessagingBackupFieldCaptureService.captureMessagingSessionFields(
            context.baseUrl, context.logs
        );
        context.snapshot.put('messagingSessionFields', fields);
        context.logs.add('Captured ' + fields.size() + ' MessagingSession fields.');
        context.logs.add('[2/7] Capturing Embedded Service deployments and components...');
        Map<String, Object> deployments = MessagingBackupDeploymentCaptureService.captureDeployments(context.baseUrl, context.logs);
        context.snapshot.put('deployments', deployments.get('deployments'));
        context.snapshot.put('customComponents', deployments.get('customComponents'));
        context.snapshot.put('agentSelectSettings', deployments.get('agentSelectSettings'));
    }

    private static void captureRoutingConfiguration(SnapshotContext context) {
        context.logs.add('[3/7] Capturing Messaging Channels...');
        context.snapshot.put('channels', MessagingBackupOmniCaptureService.captureMessagingChannels(context.logs));
        context.logs.add('[4/7] Capturing queues and memberships...');
        Map<String, Object> queues = MessagingBackupOmniCaptureService.captureQueues(context.logs);
        context.snapshot.put('queues', queues.get('queues'));
        context.snapshot.put('queueSobjects', queues.get('queueSobjects'));
        context.snapshot.put('groupMembers', queues.get('groupMembers'));
        context.logs.add('[5/7] Capturing skills and routing configuration...');
        Map<String, Object> skills = MessagingBackupOmniCaptureService.captureSkills(context.logs);
        context.snapshot.put('skills', skills.get('skills'));
        context.snapshot.put('skillUsers', skills.get('skillUsers'));
        context.snapshot.put('routingConfigs', skills.get('routingConfigs'));
        context.logs.add('[6/7] Capturing routing flows...');
        context.snapshot.put('flows', MessagingBackupOmniCaptureService.captureFlows(context.logs));
    }

    private static void captureMessagingSettings(SnapshotContext context) {
        context.logs.add('[7/7] Capturing messaging and TuBot settings...');
        Map<String, Object> settings = MessagingBackupSettingsCaptureService.captureSettings(context.logs);
        context.snapshot.put('tubotSettings', settings.get('tubotSettings'));
        context.snapshot.put('messagingConfig', settings.get('messagingConfig'));
    }

    private static void buildSnapshotMetadata(SnapshotContext context) {
        Integer fields = ((List<Object>) context.snapshot.get('messagingSessionFields')).size();
        Integer deployments = countRows(context.snapshot.get('deployments'));
        Integer channels = ((List<Object>) context.snapshot.get('channels')).size();
        Integer queues = countRows(context.snapshot.get('queues'));
        Integer skills = countRows(context.snapshot.get('skills'));
        Integer flows = ((List<Object>) context.snapshot.get('flows')).size();
        context.itemSummary = fields + ' Fields, ' + deployments + ' Deployments, ' + channels +
            ' Channels, ' + queues + ' Queues, ' + skills + ' Skills, ' + flows + ' Flows';
        context.counts = new Map<String, Object>{
            'fields' => fields, 'deployments' => deployments, 'channels' => channels,
            'queues' => queues, 'skills' => skills, 'flows' => flows
        };
        context.snapshot.put('metadata', new Map<String, Object>{
            'version' => '1.0', 'backupName' => context.backupName, 'triggerType' => context.triggerType,
            'deploymentName' => context.deploymentName, 'timestamp' => context.timestamp,
            'itemSummary' => context.itemSummary, 'counts' => context.counts
        });
    }

    private static Integer countRows(Object value) {
        return value instanceof List<Object> ? ((List<Object>) value).size() : 0;
    }

    private static void addSnapshotResults(Map<String, Object> result, SnapshotContext context) {
        String fullJson = JSON.serialize(context.snapshot);
        String chunk1 = fullJson;
        String chunk2;
        if (fullJson.length() > MessagingBackupService.MAX_FIELD_LENGTH) {
            chunk1 = fullJson.substring(0, MessagingBackupService.MAX_FIELD_LENGTH);
            chunk2 = fullJson.substring(MessagingBackupService.MAX_FIELD_LENGTH);
        }
        result.put('success', true);
        result.put('backupName', context.backupName);
        result.put('triggerType', context.triggerType);
        result.put('deploymentName', String.isNotBlank(context.deploymentName) ? context.deploymentName : 'Org-Wide');
        result.put('itemSummary', context.itemSummary);
        result.put('timestamp', context.timestamp);
        result.put('chunk1', chunk1);
        result.put('chunk2', chunk2);
        result.put('notes', String.isNotBlank(context.notes) ? context.notes.abbreviate(255) :
            context.triggerType + ' snapshot captured at ' + context.timestamp);
        result.put('counts', context.counts);
        result.put('snapshot', context.snapshot);
    }

    /**
     * @description Persists a previously captured snapshot to the Messaging_Backup__c database.
     */


}
