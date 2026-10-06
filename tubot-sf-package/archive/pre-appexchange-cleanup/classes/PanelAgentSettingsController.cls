/** Actions for discovering org-local agent mappings and syncing them with Panel. */
public with sharing class PanelAgentSettingsController {
    @AuraEnabled
    public static Map<String, Object> getAvailableDeploymentsAndAgents() {
        TubotPackageFeatureGate.reject('Agentforce settings and grounding');
        return null;
    }

    @AuraEnabled
    public static Map<String, Object> saveAgentSelectSettings(String mappingsJson) {
        TubotPackageFeatureGate.reject('Agentforce settings and grounding');
        return null;
    }

    @AuraEnabled
    public static Map<String, Object> forceSyncAgentforceTools() {
        TubotPackageFeatureGate.reject('Agentforce settings and grounding');
        return null;
    }
}
