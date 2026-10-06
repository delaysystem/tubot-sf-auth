/** Assigns the MessagingSession Escalate quick action to every session layout. */
public with sharing class IGNORE_SessionLayoutActionService {
    private static final String ACTION_DEV_NAME = 'Escalate_To_Human';
    private static final String ACTION_FULL_NAME = 'MessagingSession.Escalate_To_Human';

    public static void assignToLayouts(Map<String, Object> context) {
        logs(context).add('\n--- STEP 3: Adding Escalate Button to Messaging Session Page Layout via Tooling API ---');
        HttpResponse response = queryLayouts(context);
        if (response.getStatusCode() != 200) {
            logs(context).add('[Step 3] Warning: Layout query returned HTTP ' + response.getStatusCode() + ': ' + response.getBody());
            return;
        }
        List<Object> layouts = (List<Object>) ((Map<String, Object>) JSON.deserializeUntyped(response.getBody())).get('records');
        if (layouts == null || layouts.isEmpty()) {
            logs(context).add('[Step 3] Notice: No Layout records found for TableEnumOrId = MessagingSession.');
            return;
        }
        for (Object item : layouts) { assignLayout(context, (Map<String, Object>) item); }
    }

    private static HttpResponse queryLayouts(Map<String, Object> context) {
        String query = 'SELECT Id, Name, TableEnumOrId, FullName FROM Layout WHERE TableEnumOrId = \'MessagingSession\'';
        HttpRequest request = new HttpRequest();
        request.setEndpoint((String) context.get('baseUrl') + '/services/data/v67.0/tooling/query?q=' + EncodingUtil.urlEncode(query, 'UTF-8'));
        request.setMethod('GET');
        request.setHeader('Content-Type', 'application/json');
        return TuBotSelfOrgApiCallout.send(request);
    }

    private static void assignLayout(Map<String, Object> context, Map<String, Object> layout) {
        String layoutId = (String) layout.get('Id');
        String layoutName = (String) layout.get('Name');
        if (context.get('primaryLayoutId') == null) { context.put('primaryLayoutId', layoutId); }
        logs(context).add('[Step 3] Inspecting MessagingSession Layout: ' + layoutName + ' (Id: ' + layoutId + ')');
        HttpResponse response = getLayoutMetadata(context, layoutId);
        if (response.getStatusCode() != 200) { return; }
        Map<String, Object> metadata = layoutMetadata(response);
        ensureQuickActionList(metadata);
        List<Object> actions = quickActionItems(metadata);
        if (!containsAction(actions, (String) context.get('actionFullName'))) { addAction(actions, (String) context.get('actionFullName')); }
        context.put('layoutId', layoutId);
        context.put('layoutName', layoutName);
        context.put('layoutMetadata', metadata);
        patchLayout(context);
    }

    private static HttpResponse getLayoutMetadata(Map<String, Object> context, String layoutId) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint((String) context.get('baseUrl') + '/services/data/v67.0/tooling/sobjects/Layout/' + layoutId);
        request.setMethod('GET');
        request.setHeader('Content-Type', 'application/json');
        request.setTimeout(30000);
        return TuBotSelfOrgApiCallout.send(request);
    }

    private static Map<String, Object> layoutMetadata(HttpResponse response) {
        Map<String, Object> data = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
        Object value = data.get('Metadata');
        return value instanceof Map<String, Object> ? (Map<String, Object>) value : new Map<String, Object>();
    }

    private static void ensureQuickActionList(Map<String, Object> metadata) {
        if (!(metadata.get('quickActionList') instanceof Map<String, Object>)) {
            metadata.put('quickActionList', new Map<String, Object>());
        }
        Map<String, Object> quickActionList = (Map<String, Object>) metadata.get('quickActionList');
        if (!(quickActionList.get('quickActionListItems') instanceof List<Object>)) {
            quickActionList.put('quickActionListItems', new List<Object>());
        }
    }

    private static List<Object> quickActionItems(Map<String, Object> metadata) {
        return (List<Object>) ((Map<String, Object>) metadata.get('quickActionList')).get('quickActionListItems');
    }

    private static Boolean containsAction(List<Object> items, String actionName) {
        for (Object item : items) {
            if (item instanceof Map<String, Object> && matchesAction((String) ((Map<String, Object>) item).get('quickActionName'), actionName)) {
                return true;
            }
        }
        return false;
    }

    private static Boolean matchesAction(String candidate, String actionName) {
        return candidate == actionName || candidate == ACTION_FULL_NAME ||
            (candidate != null && candidate.endsWith(ACTION_DEV_NAME));
    }

    private static void addAction(List<Object> actions, String actionName) {
        Map<String, Object> action = new Map<String, Object>{ 'quickActionName' => actionName };
        if (actions.isEmpty()) { actions.add(action); }
        else { actions.add(0, action); }
    }

    private static void patchLayout(Map<String, Object> context) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint((String) context.get('baseUrl') + '/services/data/v67.0/tooling/sobjects/Layout/' + context.get('layoutId'));
        request.setMethod('PATCH');
        request.setHeader('Content-Type', 'application/json');
        request.setBody(JSON.serialize(new Map<String, Object>{ 'Metadata' => context.get('layoutMetadata') }));
        request.setTimeout(30000);
        HttpResponse response = TuBotSelfOrgApiCallout.send(request);
        if (response.getStatusCode() == 200 || response.getStatusCode() == 204) {
            logs(context).add('[Step 3] ✔ Successfully assigned Escalate Action (' + context.get('actionFullName') +
                ') to Layout ' + context.get('layoutName') + ' via Tooling API PATCH.');
        } else {
            logs(context).add('[Step 3] Note: Tooling API Layout PATCH returned HTTP ' + response.getStatusCode() + ': ' + response.getBody());
        }
    }

    private static List<String> logs(Map<String, Object> context) {
        return (List<String>) context.get('logs');
    }
}
