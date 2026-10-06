/** Restores deployment header assignments and required session fields through Tooling API. */
public with sharing class MessagingBackupRestoreToolingService {
    public static void restoreCustomComponents(List<Object> snapshots, List<String> logs) {
        for (Object value : snapshots) {
            restoreHeaderComponent((Map<String, Object>) value, logs);
        }
    }

    private static void restoreHeaderComponent(Map<String, Object> snapshot, List<String> logs) {
        if (!isHeaderComponent(snapshot)) { return; }
        String deploymentId = (String) snapshot.get('deploymentId');
        String componentId = (String) snapshot.get('componentId');
        try {
            Map<String, Object> existing = findHeaderComponent(deploymentId);
            if (existing == null) {
                createHeaderComponent(deploymentId, componentId);
            } else if (existing.get('CustomComponentId') != componentId) {
                updateHeaderComponent((String) existing.get('Id'), componentId);
            }
            logs.add('Restored header component for deployment ' + deploymentId + '.');
        } catch (Exception ex) {
            logs.add('Header component restore failed: ' + ex.getMessage());
            throw ex;
        }
    }

    private static Boolean isHeaderComponent(Map<String, Object> snapshot) {
        return snapshot.get('componentType') == 'MIAW_Header' &&
            String.isNotBlank((String) snapshot.get('componentId')) &&
            String.isNotBlank((String) snapshot.get('deploymentId'));
    }

    private static Map<String, Object> findHeaderComponent(String deploymentId) {
        String query = 'SELECT Id, CustomComponentId FROM EmbeddedServiceCustomComponent WHERE EmbeddedServiceConfigId = \'' +
            String.escapeSingleQuotes(deploymentId) + '\' AND CustomComponentType = \'MIAW_Header\' LIMIT 1';
        HttpResponse response = toolingRequest('/tooling/query?q=' + EncodingUtil.urlEncode(query, 'UTF-8'), 'GET', null);
        if (response.getStatusCode() != 200) { return null; }
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
        List<Object> records = (List<Object>) body.get('records');
        return records == null || records.isEmpty() ? null : (Map<String, Object>) records[0];
    }

    private static void createHeaderComponent(String deploymentId, String componentId) {
        Map<String, Object> body = new Map<String, Object>{
            'EmbeddedServiceConfigId' => deploymentId, 'CustomComponentId' => componentId,
            'CustomComponentType' => 'MIAW_Header'
        };
        toolingRequest('/tooling/sobjects/EmbeddedServiceCustomComponent', 'POST', JSON.serialize(body));
    }

    private static void updateHeaderComponent(String recordId, String componentId) {
        Map<String, Object> body = new Map<String, Object>{ 'CustomComponentId' => componentId };
        toolingRequest('/tooling/sobjects/EmbeddedServiceCustomComponent/' + recordId, 'PATCH', JSON.serialize(body));
    }

    private static HttpResponse toolingRequest(String path, String method, String body) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint(Url.getOrgDomainUrl().toExternalForm() + '/services/data/v67.0' + path);
        request.setMethod(method);
        request.setHeader('Content-Type', 'application/json');
        if (String.isNotBlank(body)) { request.setBody(body); }
        HttpResponse response = TuBotSelfOrgApiCallout.send(request);
        if (response.getStatusCode() < 200 || response.getStatusCode() >= 300) {
            throw new AuraHandledException('Restore metadata request was rejected (HTTP ' + response.getStatusCode() + ').');
        }
        return response;
    }

    public static void restoreSessionFields(List<Object> fieldObjs, String sessionTokenOverride, List<String> logs) {
        Map<String, Schema.SObjectField> fields = Schema.sObjectType.MessagingSession.fields.getMap();
        List<String> missing = missingFields(fieldObjs, fields, logs);
        if (missing.isEmpty()) {
            logs.add('All ' + fieldObjs.size() + ' backed-up MessagingSession fields are present.');
            return;
        }
        logs.add('Re-provisioning missing MessagingSession fields through the metadata pipeline.');
        Map<String, Object> result = SessionFieldProvisioningPipelineService.create(JSON.serialize(new Map<String, Object>{
            'targetUserIdentifier' => UserInfo.getUserId(), 'sessionTokenOverride' => sessionTokenOverride
        }));
        if (result.get('success') != true) {
            throw new AuraHandledException('Missing MessagingSession fields could not be restored.');
        }
    }

    private static List<String> missingFields(
        List<Object> snapshots,
        Map<String, Schema.SObjectField> fields,
        List<String> logs
    ) {
        List<String> missing = new List<String>();
        for (Object value : snapshots) {
            String name = (String) ((Map<String, Object>) value).get('apiName');
            if (String.isNotBlank(name) && !SessionFieldsProvisioningService.isFieldInSchema(name, fields)) {
                missing.add(name);
                logs.add('Backed-up MessagingSession field missing: ' + name);
            }
        }
        return missing;
    }
}
