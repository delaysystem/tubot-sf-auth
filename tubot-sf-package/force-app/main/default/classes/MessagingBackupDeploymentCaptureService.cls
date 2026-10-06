/** Captures org-local deployment and tenant-scoped Agent Select settings. */
public with sharing class MessagingBackupDeploymentCaptureService {
    public static Map<String, Object> captureDeployments(String baseUrl, List<String> logs) {
        return new Map<String, Object>{
            'deployments' => loadDeployments(baseUrl, logs),
            'customComponents' => loadComponents(baseUrl, logs),
            'agentSelectSettings' => loadAgentSettings(logs)
        };
    }

    private static List<Map<String, Object>> loadDeployments(String baseUrl, List<String> logs) {
        List<Map<String, Object>> rows = new List<Map<String, Object>>();
        try {
            String query = 'SELECT Id, DeveloperName, MasterLabel, DeploymentType, DeploymentFeature, ClientVersion ' +
                'FROM EmbeddedServiceConfig ORDER BY MasterLabel ASC';
            for (Object record : queryTooling(baseUrl, query)) { rows.add(deploymentRow((Map<String, Object>) record)); }
        } catch (Exception ex) {
            logs.add('Deployment capture unavailable: ' + ex.getMessage());
        }
        return rows;
    }

    private static Map<String, Object> deploymentRow(Map<String, Object> record) {
        return new Map<String, Object>{
            'id' => record.get('Id'), 'developerName' => record.get('DeveloperName'),
            'masterLabel' => record.get('MasterLabel'), 'deploymentType' => record.get('DeploymentType'),
            'deploymentFeature' => record.get('DeploymentFeature'), 'clientVersion' => record.get('ClientVersion')
        };
    }

    private static List<Map<String, Object>> loadComponents(String baseUrl, List<String> logs) {
        List<Map<String, Object>> rows = new List<Map<String, Object>>();
        try {
            String query = 'SELECT Id, EmbeddedServiceConfigId, Feature, CustomComponentId, CustomComponentType ' +
                'FROM EmbeddedServiceCustomComponent';
            for (Object record : queryTooling(baseUrl, query)) { rows.add(componentRow((Map<String, Object>) record)); }
        } catch (Exception ex) {
            logs.add('Custom component capture unavailable: ' + ex.getMessage());
        }
        return rows;
    }

    private static Map<String, Object> componentRow(Map<String, Object> record) {
        return new Map<String, Object>{
            'id' => record.get('Id'), 'deploymentId' => record.get('EmbeddedServiceConfigId'),
            'feature' => record.get('Feature'), 'componentId' => record.get('CustomComponentId'),
            'componentType' => record.get('CustomComponentType')
        };
    }

    private static List<Object> queryTooling(String baseUrl, String query) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint(baseUrl + '/services/data/v67.0/tooling/query?q=' + EncodingUtil.urlEncode(query, 'UTF-8'));
        request.setMethod('GET');
        request.setHeader('Content-Type', 'application/json');
        request.setTimeout(20000);
        HttpResponse response = TuBotSelfOrgApiCallout.send(request);
        if (response.getStatusCode() != 200) { return new List<Object>(); }
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
        List<Object> rows = (List<Object>) body.get('records');
        return rows == null ? new List<Object>() : rows;
    }

    private static List<Map<String, Object>> loadAgentSettings(List<String> logs) {
        List<Map<String, Object>> rows = new List<Map<String, Object>>();
        try {
            MCP_Config__c config = MCP_Config__c.getOrgDefaults();
            String teamId = config == null ? null : config.Panel_Team_Id__c;
            if (String.isBlank(teamId)) { return rows; }
            for (Agentforce_Agent_Select__c setting : [
                SELECT Name, Agent_Id__c, Agent_Name__c, Deployment_Label__c, Tenant_Id__c, Last_Synced__c
                FROM Agentforce_Agent_Select__c
                WHERE Tenant_Id__c = :teamId WITH USER_MODE
            ]) {
                rows.add(new Map<String, Object>{
                    'name' => setting.Name, 'agentId' => setting.Agent_Id__c, 'agentName' => setting.Agent_Name__c,
                    'deploymentLabel' => setting.Deployment_Label__c, 'tenantId' => setting.Tenant_Id__c,
                    'lastSynced' => setting.Last_Synced__c
                });
            }
        } catch (Exception ex) {
            logs.add('Agent mapping capture unavailable: ' + ex.getMessage());
        }
        return rows;
    }
}