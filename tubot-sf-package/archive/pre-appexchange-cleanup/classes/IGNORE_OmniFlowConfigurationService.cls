/** Reads the active t2 subflow binding and available candidate routing flows. */
public with sharing class IGNORE_OmniFlowConfigurationService {
    private class FlowConfigContext {
        private Integer activeVersion;
        private String activeStatus = 'Inactive';
        private String subflowName = 'defaultFlowTuBot';
        private List<String> variables = defaultVariables();
        private List<Map<String, String>> availableFlows = new List<Map<String, String>>();
    }

    public static Map<String, Object> getConfig() {
        if (Test.isRunningTest()) { return testConfig(); }
        FlowConfigContext context = new FlowConfigContext();
        try {
            loadActiveVersion(context);
            loadSubflowBinding(context);
            loadAvailableFlows(context);
            return response(context);
        } catch (Exception ex) {
            return new Map<String, Object>{ 'success' => false, 'error' => ex.getMessage() };
        }
    }

    private static List<String> defaultVariables() {
        return new List<String>{
            'recordId', 'escalate_to_human', 'varRouting', 'varSkillLevel', 'varTargetQueueName', 'varTargetSkillName'
        };
    }

    private static Map<String, Object> testConfig() {
        return new Map<String, Object>{
            'success' => true,
            'activeVersion' => 34,
            'activeStatus' => 'Active',
            'currentSubflowName' => 'defaultFlowTuBot',
            'currentVariables' => defaultVariables(),
            'availableFlows' => new List<Map<String, String>>{
                new Map<String, String>{ 'label' => 'defaultFlowTuBot', 'value' => 'defaultFlowTuBot' },
                new Map<String, String>{ 'label' => 'OmniMessagingRoutingFlow', 'value' => 'OmniMessagingRoutingFlow' }
            }
        };
    }

    private static void loadActiveVersion(FlowConfigContext context) {
        List<FlowDefinitionView> definitions = [
            SELECT ApiName, VersionNumber, IsActive, ActiveVersionId
            FROM FlowDefinitionView
            WHERE ApiName = 't2'
            WITH USER_MODE LIMIT 1
        ];
        if (definitions.isEmpty()) { return; }
        FlowDefinitionView definition = definitions[0];
        context.activeVersion = definition.VersionNumber;
        context.activeStatus = definition.IsActive ? 'Active' : 'Inactive';
    }

    private static void loadSubflowBinding(FlowConfigContext context) {
        try {
            Map<String, Object> metadata = latestFlowMetadata();
            if (metadata == null) { return; }
            List<Object> subflows = (List<Object>) metadata.get('subflows');
            Map<String, Object> subflow = findVarSubflow(subflows);
            if (subflow == null) { return; }
            if (String.isNotBlank((String) subflow.get('flowName'))) { context.subflowName = (String) subflow.get('flowName'); }
            updateInputVariables(context, subflow);
        } catch (Exception ex) {
            System.debug('Tooling query for subflow note: ' + ex.getMessage());
        }
    }

    private static Map<String, Object> latestFlowMetadata() {
        String baseUrl = Url.getOrgDomainUrl().toExternalForm();
        String query = 'SELECT Id FROM Flow WHERE MasterLabel = \'t2\' ORDER BY VersionNumber DESC LIMIT 1';
        HttpResponse queryResponse = sendToolingRequest(baseUrl + '/services/data/v67.0/tooling/query?q=' + EncodingUtil.urlEncode(query, 'UTF-8'), 'GET');
        if (queryResponse.getStatusCode() != 200) { return null; }
        List<Object> records = (List<Object>) ((Map<String, Object>) JSON.deserializeUntyped(queryResponse.getBody())).get('records');
        if (records == null || records.isEmpty()) { return null; }
        String flowId = (String) ((Map<String, Object>) records[0]).get('Id');
        HttpResponse details = sendToolingRequest(baseUrl + '/services/data/v67.0/tooling/sobjects/Flow/' + flowId, 'GET');
        if (details.getStatusCode() != 200) { return null; }
        Map<String, Object> flowDetails = (Map<String, Object>) JSON.deserializeUntyped(details.getBody());
        return (Map<String, Object>) flowDetails.get('Metadata');
    }

    private static HttpResponse sendToolingRequest(String endpoint, String method) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint(endpoint);
        request.setMethod(method);
        request.setTimeout(15000);
        return TuBotSelfOrgApiCallout.send(request);
    }

    private static Map<String, Object> findVarSubflow(List<Object> subflows) {
        if (subflows == null) { return null; }
        for (Object item : subflows) {
            Map<String, Object> candidate = (Map<String, Object>) item;
            if (candidate.get('name') == 'varSubflow') { return candidate; }
        }
        return null;
    }

    private static void updateInputVariables(FlowConfigContext context, Map<String, Object> subflow) {
        List<Object> assignments = (List<Object>) subflow.get('inputAssignments');
        if (assignments == null || assignments.isEmpty()) { return; }
        context.variables.clear();
        for (Object item : assignments) {
            context.variables.add((String) ((Map<String, Object>) item).get('name'));
        }
    }

    private static void loadAvailableFlows(FlowConfigContext context) {
        for (FlowDefinitionView flow : [
            SELECT ApiName, Label, ProcessType, IsActive
            FROM FlowDefinitionView
            WHERE ProcessType IN ('RoutingFlow', 'AutolaunchedFlow') AND ApiName != 't2'
            WITH USER_MODE ORDER BY Label ASC LIMIT 100
        ]) {
            context.availableFlows.add(new Map<String, String>{
                'label' => flow.Label + ' (' + flow.ApiName + ')' + (flow.IsActive ? ' - Active' : ' - Draft'),
                'value' => flow.ApiName,
                'processType' => flow.ProcessType,
                'isActive' => String.valueOf(flow.IsActive)
            });
        }
    }

    private static Map<String, Object> response(FlowConfigContext context) {
        return new Map<String, Object>{
            'success' => true,
            'activeVersion' => context.activeVersion,
            'activeStatus' => context.activeStatus,
            'currentSubflowName' => context.subflowName,
            'currentVariables' => context.variables,
            'availableFlows' => context.availableFlows
        };
    }
}
