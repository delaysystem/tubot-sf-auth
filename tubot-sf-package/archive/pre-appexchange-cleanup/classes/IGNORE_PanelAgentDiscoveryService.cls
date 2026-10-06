/** Discovers only deployments, bots, and Agent Select mappings present in the active Salesforce org. */
public with sharing class IGNORE_PanelAgentDiscoveryService {
    public static Map<String, Object> getAvailableDeploymentsAndAgents() {
        Map<String, Object> status = PanelAuthController.getPanelAuthStatus();
        return new Map<String, Object>{
            'authStatus' => status,
            'deployments' => discoverDeployments(),
            'agents' => discoverAgents(),
            'mappings' => readMappings((String) status.get('teamId'))
        };
    }

    private static List<Map<String, String>> discoverDeployments() {
        List<Map<String, String>> deployments = new List<Map<String, String>>();
        for (MessagingChannel channel : [
            SELECT DeveloperName, MasterLabel, MessageType
            FROM MessagingChannel WITH USER_MODE LIMIT 50
        ]) {
            deployments.add(new Map<String, String>{
                'name' => channel.DeveloperName, 'label' => channel.MasterLabel + ' (' + channel.MessageType + ')'
            });
        }
        return deployments;
    }

    private static List<Map<String, String>> discoverAgents() {
        List<Map<String, String>> agents = new List<Map<String, String>>();
        List<SObject> bots = queryBotsWithType();
        if (bots == null) { return agents; }
        for (SObject bot : bots) {
            String developerName = String.valueOf(bot.get('DeveloperName'));
            String label = String.valueOf(bot.get('MasterLabel'));
            agents.add(new Map<String, String>{
                'id' => String.valueOf(bot.get('Id')),
                'name' => String.isNotBlank(label) ? label : developerName,
                'developerName' => developerName
            });
        }
        return agents;
    }

    private static List<SObject> queryBotsWithType() {
        try {
            return Database.query('SELECT Id, DeveloperName, MasterLabel, Type FROM BotDefinition WITH USER_MODE LIMIT 50');
        } catch (Exception unavailableType) {
            try { return Database.query('SELECT Id, DeveloperName, MasterLabel FROM BotDefinition WITH USER_MODE LIMIT 50'); }
            catch (Exception unavailableObject) { return null; }
        }
    }

    private static List<Map<String, Object>> readMappings(String teamId) {
        List<Map<String, Object>> mappings = new List<Map<String, Object>>();
        for (Agentforce_Agent_Select__c record : Agentforce_Agent_Select__c.getAll().values()) {
            if (String.isBlank(teamId) || record.Tenant_Id__c != teamId) { continue; }
            mappings.add(new Map<String, Object>{
                'deploymentName' => record.Name,
                'deploymentLabel' => String.isNotBlank(record.Deployment_Label__c) ? record.Deployment_Label__c : record.Name,
                'agentId' => record.Agent_Id__c, 'agentName' => record.Agent_Name__c,
                'tenantId' => record.Tenant_Id__c, 'lastSynced' => record.Last_Synced__c
            });
        }
        return mappings;
    }
}
