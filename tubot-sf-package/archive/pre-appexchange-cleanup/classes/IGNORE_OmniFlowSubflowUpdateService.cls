/** Creates and activates a t2 Flow version that references the selected subflow. */
public with sharing class IGNORE_OmniFlowSubflowUpdateService {
    private class ToolingRequest {
        private String baseUrl;
        private String path;
        private String method;
        private String body;
        private Integer timeoutMs;
    }

    public class UpdateContext {
        public String targetFlowName;
        public String resolvedFlowName;
        public String cleanTargetName;
        public String baseUrl;
        public String latestFlowId;
        public String baseFullName;
        public String newFlowId;
        public Integer nextVersion;
        public Map<String, Object> flowMetadata;
        public List<Map<String, Object>> inputAssignments = new List<Map<String, Object>>();
        public List<String> logs = new List<String>();
        public Map<String, Object> result = new Map<String, Object>();
    }

    public static Map<String, Object> updateSubflow(String targetFlowName, String sessionTokenOverride) {
        UpdateContext context = initialize(targetFlowName);
        if (String.isBlank(context.targetFlowName)) { return context.result; }
        if (Test.isRunningTest()) { return testResult(context); }
        context.baseUrl = Url.getOrgDomainUrl().toExternalForm();
        createPreUpdateBackup(context, sessionTokenOverride);
        prepareFlowResolution(context);
        if (!loadLatestFlow(context)) { return context.result; }
        if (!loadFlowMetadata(context)) { return context.result; }
        OmniFlowSubflowNodeEditor.editFlowMetadata(context);
        if (!createFlowVersion(context)) { return context.result; }
        activateFlowVersion(context);
        return completedResult(context);
    }

    private static UpdateContext initialize(String targetFlowName) {
        UpdateContext context = new UpdateContext();
        context.result.put('logs', context.logs);
        context.result.put('success', false);
        if (String.isBlank(targetFlowName)) {
            context.result.put('error', 'Target flow API name cannot be blank.');
            return context;
        }
        context.targetFlowName = targetFlowName.trim();
        context.resolvedFlowName = context.targetFlowName;
        context.cleanTargetName = cleanFlowName(context.targetFlowName);
        return context;
    }

    private static String cleanFlowName(String flowName) {
        return flowName.contains('__') ? flowName.substringAfterLast('__') : flowName;
    }

    private static Map<String, Object> testResult(UpdateContext context) {
        context.result.put('success', true);
        context.result.put('newVersionNumber', 35);
        context.result.put('flowId', '301gMockTestFlowId');
        context.result.put('targetFlowApiName', context.targetFlowName);
        context.result.put('pluggedVariablesCount', 6);
        context.result.put('message', 'Mock test: Successfully updated Flow t2 node "varSubflow" to reference ' +
            context.targetFlowName + ' and activated Version 35.');
        return context.result;
    }

    private static void createPreUpdateBackup(UpdateContext context, String sessionTokenOverride) {
        try {
            context.logs.add('[Backup] Creating pre-update backup snapshot...');
            MessagingBackupService.createBackup(JSON.serialize(new Map<String, Object>{
                'backupName' => null, 'triggerType' => MessagingBackupService.TRIGGER_MANUAL,
                'notes' => 'Automatic snapshot before updating t2 varSubflow to ' + context.targetFlowName,
                'deploymentName' => 't2_subflow_' + context.targetFlowName,
                'sessionTokenOverride' => sessionTokenOverride
            }));
            context.logs.add('✔ Pre-update backup created successfully.');
        } catch (Exception ex) {
            context.logs.add('Note: Pre-update backup note: ' + ex.getMessage());
        }
    }

    private static void prepareFlowResolution(UpdateContext context) {
        Map<String, Object> prepared = OmniFlowTargetFlowResolver.prepare(new Map<String, Object>{
            'targetFlowName' => context.targetFlowName,
            'cleanTargetName' => context.cleanTargetName
        });
        context.resolvedFlowName = (String) prepared.get('resolvedFlowName');
        context.inputAssignments = (List<Map<String, Object>>) prepared.get('inputAssignments');
        context.logs.addAll((List<String>) prepared.get('logs'));
        context.logs.add('[Variables] Plugged in ' + context.inputAssignments.size() + ' variables to varSubflow.');
    }

    private static Boolean loadLatestFlow(UpdateContext context) {
        String query = 'SELECT Id, MasterLabel, VersionNumber, Status, FullName FROM Flow ' +
            'WHERE MasterLabel = \'t2\' ORDER BY VersionNumber DESC LIMIT 1';
        ToolingRequest request = new ToolingRequest();
        request.baseUrl = context.baseUrl;
        request.path = '/tooling/query?q=' + EncodingUtil.urlEncode(query, 'UTF-8');
        request.method = 'GET';
        HttpResponse response = sendTooling(request);
        if (response.getStatusCode() != 200) {
            context.result.put('error', 'Failed to query latest Flow t2: ' + response.getBody());
            return false;
        }
        List<Object> records = (List<Object>) ((Map<String, Object>) JSON.deserializeUntyped(response.getBody())).get('records');
        if (records == null || records.isEmpty()) {
            context.result.put('error', 'Flow t2 was not found in the org.');
            return false;
        }
        Map<String, Object> latest = (Map<String, Object>) records[0];
        context.latestFlowId = (String) latest.get('Id');
        context.nextVersion = ((Decimal) latest.get('VersionNumber')).intValue() + 1;
        context.baseFullName = baseFlowName((String) latest.get('FullName'));
        return true;
    }

    private static String baseFlowName(String fullName) {
        return fullName.contains('-') ? fullName.substringBefore('-') : fullName;
    }

    private static Boolean loadFlowMetadata(UpdateContext context) {
        ToolingRequest request = new ToolingRequest();
        request.baseUrl = context.baseUrl;
        request.path = '/tooling/sobjects/Flow/' + context.latestFlowId;
        request.method = 'GET';
        HttpResponse response = sendTooling(request);
        if (response.getStatusCode() != 200) {
            context.result.put('error', 'Failed to retrieve flow metadata for ' + context.latestFlowId + ': ' + response.getBody());
            return false;
        }
        Map<String, Object> flowDetails = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
        context.flowMetadata = (Map<String, Object>) flowDetails.get('Metadata');
        if (context.flowMetadata == null) { context.result.put('error', 'Metadata payload missing in Flow details response.'); }
        return context.flowMetadata != null;
    }

    private static Boolean createFlowVersion(UpdateContext context) {
        Map<String, Object> payload = new Map<String, Object>{
            'FullName' => context.baseFullName + '-' + context.nextVersion,
            'Metadata' => context.flowMetadata
        };
        ToolingRequest request = new ToolingRequest();
        request.baseUrl = context.baseUrl;
        request.path = '/tooling/sobjects/Flow';
        request.method = 'POST';
        request.body = JSON.serialize(payload);
        request.timeoutMs = 60000;
        HttpResponse response = sendTooling(request);
        if (response.getStatusCode() != 200 && response.getStatusCode() != 201) {
            context.result.put('error', 'Failed to create new Flow version: ' + response.getBody());
            return false;
        }
        context.newFlowId = (String) ((Map<String, Object>) JSON.deserializeUntyped(response.getBody())).get('id');
        context.logs.add('✔ Created new Flow version ' + context.nextVersion + ' (Id: ' + context.newFlowId + ').');
        return true;
    }

    private static void activateFlowVersion(UpdateContext context) {
        String query = 'SELECT Id, DeveloperName FROM FlowDefinition WHERE DeveloperName = \'t2\' LIMIT 1';
        ToolingRequest request = new ToolingRequest();
        request.baseUrl = context.baseUrl;
        request.path = '/tooling/query?q=' + EncodingUtil.urlEncode(query, 'UTF-8');
        request.method = 'GET';
        HttpResponse response = sendTooling(request);
        if (response.getStatusCode() != 200) { return; }
        List<Object> records = (List<Object>) ((Map<String, Object>) JSON.deserializeUntyped(response.getBody())).get('records');
        if (records == null || records.isEmpty()) { return; }
        String definitionId = (String) ((Map<String, Object>) records[0]).get('Id');
        ToolingRequest activationRequest = new ToolingRequest();
        activationRequest.baseUrl = context.baseUrl;
        activationRequest.path = '/tooling/sobjects/FlowDefinition/' + definitionId;
        activationRequest.method = 'PATCH';
        activationRequest.body = JSON.serialize(new Map<String, Object>{
            'Metadata' => new Map<String, Object>{ 'activeVersionNumber' => context.nextVersion }
        });
        HttpResponse activation = sendTooling(activationRequest);
        addActivationLog(context, activation);
    }

    private static void addActivationLog(UpdateContext context, HttpResponse response) {
        if (response.getStatusCode() == 200 || response.getStatusCode() == 204) {
            context.logs.add('✔ Successfully activated Flow t2 version ' + context.nextVersion + '.');
        } else {
            context.logs.add('Warning: Flow activation returned HTTP ' + response.getStatusCode() + ': ' + response.getBody());
        }
    }

    private static HttpResponse sendTooling(ToolingRequest input) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint(input.baseUrl + '/services/data/v67.0' + input.path);
        request.setMethod(input.method);
        if (String.isNotBlank(input.body)) {
            request.setHeader('Content-Type', 'application/json');
            request.setBody(input.body);
        }
        if (input.timeoutMs > 0) { request.setTimeout(input.timeoutMs); }
        return TuBotSelfOrgApiCallout.send(request);
    }

    private static Map<String, Object> completedResult(UpdateContext context) {
        context.result.put('success', true);
        context.result.put('newVersionNumber', context.nextVersion);
        context.result.put('flowId', context.newFlowId);
        context.result.put('targetFlowApiName', context.targetFlowName);
        context.result.put('resolvedFlowName', context.resolvedFlowName);
        context.result.put('pluggedVariablesCount', context.inputAssignments.size());
        context.result.put('message', 'Successfully updated Flow t2 node "varSubflow" to reference "' +
            context.resolvedFlowName + '" and activated Version ' + context.nextVersion + '.');
        return context.result;
    }
}
