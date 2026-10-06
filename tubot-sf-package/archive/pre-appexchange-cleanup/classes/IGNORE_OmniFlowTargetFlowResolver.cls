/** Resolves the selected Flow name and compatible t2 input assignments. */
public with sharing class IGNORE_OmniFlowTargetFlowResolver {
    private class ResolutionContext {
        private String requestedName;
        private String cleanName;
        private String resolvedName;
        private Set<String> validInputs = new Set<String>();
        private Map<String, String> inputCasing = new Map<String, String>();
        private List<Map<String, Object>> assignments = new List<Map<String, Object>>();
        private List<String> logs = new List<String>();
    }

    public static Map<String, Object> prepare(Map<String, Object> input) {
        ResolutionContext context = initialize(input);
        resolveFlowName(context);
        loadInputVariables(context);
        buildAssignments(context);
        return new Map<String, Object>{
            'resolvedFlowName' => context.resolvedName,
            'inputAssignments' => context.assignments,
            'logs' => context.logs
        };
    }

    private static ResolutionContext initialize(Map<String, Object> input) {
        ResolutionContext context = new ResolutionContext();
        context.requestedName = (String) input.get('targetFlowName');
        context.cleanName = (String) input.get('cleanTargetName');
        context.resolvedName = context.requestedName;
        return context;
    }

    private static void resolveFlowName(ResolutionContext context) {
        try {
            List<FlowDefinitionView> targetFlows = [
                SELECT ApiName, NamespacePrefix
                FROM FlowDefinitionView
                WHERE ApiName = :context.requestedName OR ApiName = :context.cleanName
                WITH USER_MODE LIMIT 1
            ];
            if (!targetFlows.isEmpty()) {
                context.resolvedName = resolvedName(targetFlows[0], context.requestedName);
            }
        } catch (Exception ex) {
            context.logs.add('Target flow resolution note: ' + ex.getMessage());
        }
    }

    private static String resolvedName(FlowDefinitionView target, String requestedName) {
        if (String.isBlank(target.NamespacePrefix) || requestedName.startsWithIgnoreCase(target.NamespacePrefix + '__')) {
            return target.ApiName;
        }
        return target.NamespacePrefix + '__' + target.ApiName;
    }

    private static void loadInputVariables(ResolutionContext context) {
        try {
            addVariables(context, true);
            if (context.validInputs.isEmpty()) { addVariables(context, false); }
        } catch (Exception ex) {
            context.logs.add('Note: FlowVariableView query: ' + ex.getMessage());
        }
    }

    private static void addVariables(ResolutionContext context, Boolean activeOnly) {
        if (activeOnly) {
            for (FlowVariableView variable : [
                SELECT ApiName, DataType, IsInput
                FROM FlowVariableView
                WHERE (FlowVersionView.FlowDefinitionView.ApiName = :context.requestedName
                    OR FlowVersionView.FlowDefinitionView.ApiName = :context.cleanName)
                    AND FlowVersionView.Status = 'Active' AND IsInput = true
                WITH USER_MODE
            ]) {
                addVariable(context, variable);
            }
            return;
        }
        for (FlowVariableView variable : [
            SELECT ApiName, DataType, IsInput
            FROM FlowVariableView
            WHERE (FlowVersionView.FlowDefinitionView.ApiName = :context.requestedName
                OR FlowVersionView.FlowDefinitionView.ApiName = :context.cleanName)
                AND IsInput = true
            WITH USER_MODE
        ]) {
            addVariable(context, variable);
        }
    }

    private static void addVariable(ResolutionContext context, FlowVariableView variable) {
        String key = variable.ApiName.toLowerCase();
        context.validInputs.add(key);
        context.inputCasing.put(key, variable.ApiName);
    }

    private static void buildAssignments(ResolutionContext context) {
        for (String variableName : new List<String>{
            'recordId', 'escalate_to_human', 'varRouting', 'varSkillLevel', 'varTargetQueueName', 'varTargetSkillName'
        }) {
            addAssignment(context, variableName);
        }
    }

    private static void addAssignment(ResolutionContext context, String variableName) {
        String key = variableName.toLowerCase();
        if (!context.validInputs.isEmpty() && !context.validInputs.contains(key)) { return; }
        String targetName = context.inputCasing.containsKey(key) ? context.inputCasing.get(key) : variableName;
        context.assignments.add(new Map<String, Object>{
            'name' => targetName,
            'processMetadataValues' => new List<Object>(),
            'value' => new Map<String, Object>{ 'elementReference' => variableName }
        });
    }
}
