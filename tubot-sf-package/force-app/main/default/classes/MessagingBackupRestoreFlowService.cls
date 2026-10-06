/** Reinstates flow activation state recorded in the backup snapshot. */
public with sharing class MessagingBackupRestoreFlowService {
    public static void restoreFlows(List<Object> snapshots, String sessionTokenOverride, List<String> logs) {
        for (Object value : snapshots) {
            restoreFlow((Map<String, Object>) value, sessionTokenOverride, logs);
        }
    }

    private static void restoreFlow(Map<String, Object> snapshot, String sessionTokenOverride, List<String> logs) {
        String apiName = (String) snapshot.get('apiName');
        if (snapshot.get('isActive') != true || String.isBlank(apiName)) { return; }
        Object rawVersion = snapshot.get('activeVersionNumber');
        Map<String, Object> request = new Map<String, Object>{
            'apiName' => apiName, 'versionNumber' => rawVersion,
            'sessionTokenOverride' => sessionTokenOverride, 'logs' => logs
        };
        if (rawVersion == null) {
            EmbeddedDeploymentFlowActivationService.ensureFlowIsActive(request);
        } else {
            EmbeddedDeploymentFlowActivationService.activateFlowVersion(request);
        }
    }
}