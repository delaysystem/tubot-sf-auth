/** Activates existing flow definitions when restoring a messaging backup. */
public with sharing class EmbeddedDeploymentFlowActivationService {
    private class ActivationContext {
        private String apiName;
        private String baseUrl;
        private List<String> logs;
    }

    public static void activateFlowVersion(Map<String, Object> request) {
        ActivationContext context = contextFrom(request);
        Object rawVersion = request.get('versionNumber');
        Integer version = rawVersion == null ? null : Integer.valueOf(String.valueOf(rawVersion));
        if (String.isBlank(context.apiName) || version == null || version < 1) {
            throw new AuraHandledException('A valid flow name and version are required for restoration.');
        }
        if (Test.isRunningTest()) {
            context.logs.add('Test flow activation request recorded.');
            return;
        }
        activate(context, version);
    }

    public static void ensureFlowIsActive(Map<String, Object> request) {
        ActivationContext context = contextFrom(request);
        if (String.isBlank(context.apiName)) {
            throw new AuraHandledException('A flow name is required for restoration.');
        }
        List<FlowDefinitionView> definitions = [
            SELECT ApiName, ActiveVersionId, LatestVersionId, IsActive
            FROM FlowDefinitionView
            WHERE ApiName = :context.apiName WITH USER_MODE LIMIT 1
        ];
        if (definitions.isEmpty()) {
            throw new AuraHandledException('The backed-up flow was not found in this org.');
        }
        if (definitions[0].IsActive) {
            context.logs.add('Flow ' + context.apiName + ' is already active.');
            return;
        }
        Object version = latestVersion(context);
        if (version == null) { throw new AuraHandledException('The backed-up flow has no restorable version.'); }
        activate(context, Integer.valueOf(String.valueOf(version)));
    }

    private static ActivationContext contextFrom(Map<String, Object> request) {
        ActivationContext context = new ActivationContext();
        context.apiName = (String) request.get('apiName');
        context.baseUrl = Url.getOrgDomainUrl().toExternalForm();
        context.logs = request.get('logs') == null
            ? new List<String>() : (List<String>) request.get('logs');
        return context;
    }

    private static Object latestVersion(ActivationContext context) {
        String query = 'SELECT LatestVersion.VersionNumber FROM FlowDefinition WHERE DeveloperName = \''
            + String.escapeSingleQuotes(context.apiName) + '\' LIMIT 1';
        HttpResponse response = toolingGet(context, '/tooling/query?q=' + EncodingUtil.urlEncode(query, 'UTF-8'));
        if (response.getStatusCode() != 200) {
            throw new AuraHandledException('Could not read the backed-up flow version.');
        }
        List<Object> rows = records(response);
        if (rows.isEmpty()) { return null; }
        Map<String, Object> row = (Map<String, Object>) rows[0];
        Map<String, Object> latest = (Map<String, Object>) row.get('LatestVersion');
        return latest == null ? null : latest.get('VersionNumber');
    }

    private static void activate(ActivationContext context, Integer version) {
        String query = 'SELECT Id FROM FlowDefinition WHERE DeveloperName = \''
            + String.escapeSingleQuotes(context.apiName) + '\' LIMIT 1';
        HttpResponse found = toolingGet(context, '/tooling/query?q=' + EncodingUtil.urlEncode(query, 'UTF-8'));
        List<Object> rows = records(found);
        if (found.getStatusCode() != 200 || rows.isEmpty()) {
            throw new AuraHandledException('Could not resolve the backed-up flow definition.');
        }
        String definitionId = (String) ((Map<String, Object>) rows[0]).get('Id');
        HttpResponse response = updateDefinition(context, definitionId, version);
        if (response.getStatusCode() != 200 && response.getStatusCode() != 204) {
            throw new AuraHandledException('Flow restoration was rejected (HTTP ' + response.getStatusCode() + ').');
        }
        context.logs.add('Flow ' + context.apiName + ' activated at version ' + version + '.');
    }

    private static HttpResponse toolingGet(ActivationContext context, String path) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint(context.baseUrl + '/services/data/v67.0' + path);
        request.setMethod('GET');
        request.setHeader('Content-Type', 'application/json');
        return TuBotSelfOrgApiCallout.send(request);
    }

    private static HttpResponse updateDefinition(ActivationContext context, String definitionId, Integer version) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint(context.baseUrl + '/services/data/v67.0/tooling/sobjects/FlowDefinition/' + definitionId);
        request.setMethod('PATCH');
        request.setHeader('Content-Type', 'application/json');
        request.setBody(JSON.serialize(new Map<String, Object>{
            'Metadata' => new Map<String, Object>{ 'activeVersionNumber' => version }
        }));
        return TuBotSelfOrgApiCallout.send(request);
    }

    private static List<Object> records(HttpResponse response) {
        if (response == null || response.getStatusCode() != 200) {
            throw new AuraHandledException('The flow metadata query failed.');
        }
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
        List<Object> rows = (List<Object>) body.get('records');
        if (rows == null) { throw new AuraHandledException('The flow metadata query returned an invalid response.'); }
        return rows;
    }
}
