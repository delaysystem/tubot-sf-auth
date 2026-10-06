/** Updates the varSubflow node in Flow metadata without coupling it to Tooling API transport. */
public with sharing class IGNORE_OmniFlowSubflowNodeEditor {
    public static void editFlowMetadata(OmniFlowSubflowUpdateService.UpdateContext context) {
        List<Object> subflows = (List<Object>) context.flowMetadata.get('subflows');
        if (subflows == null) {
            subflows = new List<Object>();
            context.flowMetadata.put('subflows', subflows);
        }
        if (!replaceSubflow(subflows, context)) { subflows.add(newSubflowNode(context)); }
        context.flowMetadata.put('status', 'Draft');
    }

    private static Boolean replaceSubflow(List<Object> subflows, OmniFlowSubflowUpdateService.UpdateContext context) {
        for (Object item : subflows) {
            Map<String, Object> subflow = (Map<String, Object>) item;
            if (subflow.get('name') == 'varSubflow') {
                subflow.put('flowName', context.resolvedFlowName);
                subflow.put('inputAssignments', context.inputAssignments);
                return true;
            }
        }
        return false;
    }

    private static Map<String, Object> newSubflowNode(OmniFlowSubflowUpdateService.UpdateContext context) {
        return new Map<String, Object>{
            'name' => 'varSubflow',
            'label' => 'varSubflow',
            'locationX' => 0,
            'locationY' => 0,
            'flowName' => context.resolvedFlowName,
            'inputAssignments' => context.inputAssignments,
            'storeOutputAutomatically' => true
        };
    }
}
