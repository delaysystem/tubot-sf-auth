/** Validates, synchronizes, and saves Agent Select mappings scoped to the connected Panel team. */
public with sharing class IGNORE_PanelAgentMappingService {
    public static Map<String, Object> save(String mappingsJson) {
        Map<String, Object> status = PanelAuthController.getPanelAuthStatus();
        ensureCanEdit(status);
        List<Object> mappings = parseMappings(mappingsJson);
        List<Agentforce_Agent_Select__c> records = buildRecords(mappings, (String) status.get('teamId'));
        Map<String, Object> sync = synchronize(mappings, status);
        if (!records.isEmpty()) { Database.upsert(records, AccessLevel.USER_MODE); }
        return syncResult(sync, records.size());
    }

    public static String getAgentIdForDeployment(String deploymentName) {
        if (String.isBlank(deploymentName)) { return null; }
        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        String teamId = config == null ? null : config.Panel_Team_Id__c;
        if (String.isBlank(teamId)) { return null; }
        Agentforce_Agent_Select__c mapping = Agentforce_Agent_Select__c.getInstance(deploymentName);
        return mapping != null && mapping.Tenant_Id__c == teamId ? mapping.Agent_Id__c : null;
    }

    private static void ensureCanEdit(Map<String, Object> status) {
        if (!(Boolean) status.get('canEditSettings')) {
            throw new AuraHandledException('The connected Panel account must have edit-salesforce-settings permission.');
        }
    }

    private static List<Object> parseMappings(String mappingsJson) {
        if (String.isBlank(mappingsJson)) { throw new AuraHandledException('No deployment mappings provided.'); }
        List<Object> mappings = (List<Object>) JSON.deserializeUntyped(mappingsJson);
        if (mappings.isEmpty()) { throw new AuraHandledException('No deployment mappings provided.'); }
        return mappings;
    }

    private static List<Agentforce_Agent_Select__c> buildRecords(List<Object> mappings, String teamId) {
        List<Agentforce_Agent_Select__c> records = new List<Agentforce_Agent_Select__c>();
        Datetime syncedAt = Datetime.now();
        for (Object value : mappings) {
            Agentforce_Agent_Select__c record = recordFrom((Map<String, Object>) value, teamId, syncedAt);
            if (record != null) { records.add(record); }
        }
        return records;
    }

    private static Agentforce_Agent_Select__c recordFrom(Map<String, Object> mapping, String teamId, Datetime syncedAt) {
        String name = (String) mapping.get('deploymentName');
        String agentId = (String) mapping.get('agentId');
        String agentName = (String) mapping.get('agentName');
        if (String.isBlank(name) || String.isBlank(agentId) || String.isBlank(agentName)) { return null; }
        Agentforce_Agent_Select__c record = Agentforce_Agent_Select__c.getInstance(name);
        if (record == null) { record = new Agentforce_Agent_Select__c(Name = name); }
        record.Agent_Id__c = agentId.trim();
        record.Agent_Name__c = agentName.trim();
        record.Deployment_Label__c = String.isNotBlank((String) mapping.get('deploymentLabel'))
            ? (String) mapping.get('deploymentLabel') : name;
        record.Tenant_Id__c = teamId;
        record.Last_Synced__c = syncedAt;
        return record;
    }

    private static Map<String, Object> synchronize(List<Object> mappings, Map<String, Object> status) {
        Map<String, Object> outcome = new Map<String, Object>{ 'synced' => false, 'message' => 'Saved to Salesforce Custom Settings.' };
        if (!(Boolean) status.get('hasAccessToken')) { return outcome; }
        try {
            HttpResponse response = PanelAuthSupportService.executePanelCallout('/api/v1/salesforce/deployments', 'POST', JSON.serialize(new Map<String, Object>{
                'mappings' => mappings, 'orgId' => UserInfo.getOrganizationId()
            }));
            if (response.getStatusCode() == 200) {
                outcome.put('synced', true);
                outcome.put('message', 'Saved to Salesforce Custom Settings and synchronized with Panel.');
            } else {
                outcome.put('message', 'Saved locally, but Panel synchronization returned HTTP ' + response.getStatusCode());
            }
        } catch (Exception ex) {
            outcome.put('message', 'Saved locally, but Panel synchronization failed.');
        }
        return outcome;
    }

    private static Map<String, Object> syncResult(Map<String, Object> sync, Integer count) {
        return new Map<String, Object>{
            'success' => true, 'message' => sync.get('message'), 'panelSynced' => sync.get('synced'), 'savedCount' => count
        };
    }
}
