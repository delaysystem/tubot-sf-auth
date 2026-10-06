/** Applies FieldPermissions through REST Composite with user-mode DML fallback. */
public with sharing class SessionFieldPermissionRestService {
    public static void apply(Map<String, Object> plan) {
        applyInserts(plan);
        applyUpdates(plan);
    }

    private static void applyInserts(Map<String, Object> plan) {
        List<Map<String, Object>> restRecords = (List<Map<String, Object>>) plan.get('restInsertRecords');
        List<FieldPermissions> dmlRecords = (List<FieldPermissions>) plan.get('dmlInsertRecords');
        if (restRecords.isEmpty()) { return; }
        Boolean succeeded = false;
        try {
            HttpResponse response = sendComposite(new Map<String, Object>{
                'plan' => plan, 'endpointPath' => '/services/data/v61.0/composite/sobjects',
                'method' => 'POST', 'records' => restRecords
            });
            succeeded = successful(response);
            addInsertLog(plan, response, succeeded);
        } catch (Exception ex) {
            logs(plan).add('  [Step 3:NOTE] REST callout note: ' + ex.getMessage() + '. Applying local DML fallback.');
        }
        if (!succeeded && !dmlRecords.isEmpty()) {
            Database.insert(dmlRecords, false, AccessLevel.USER_MODE);
            logs(plan).add('  ✔ [Step 3] Applied local DML insert for ' + dmlRecords.size() + ' FieldPermissions records.');
        }
    }

    private static void addInsertLog(Map<String, Object> plan, HttpResponse response, Boolean succeeded) {
        if (succeeded) {
            logs(plan).add('  ✔ [Step 3] REST Composite FieldPermissions insert succeeded (HTTP ' + response.getStatusCode() + ')');
        } else {
            logs(plan).add('  [Step 3:NOTE] REST Composite returned HTTP ' + response.getStatusCode() + '. Applying local DML fallback.');
        }
    }

    private static void applyUpdates(Map<String, Object> plan) {
        List<FieldPermissions> records = (List<FieldPermissions>) plan.get('dmlUpdateRecords');
        if (records.isEmpty()) { return; }
        Boolean succeeded = false;
        try {
            HttpResponse response = sendComposite(new Map<String, Object>{
                'plan' => plan, 'endpointPath' => '/services/data/v67.0/composite/sobjects',
                'method' => 'PATCH', 'records' => updatePayload(records)
            });
            succeeded = successful(response);
            addUpdateLog(plan, response, succeeded);
        } catch (Exception ex) {
            logs(plan).add('  [Step 3:NOTE] REST update callout note: ' + ex.getMessage() + '. Applying local DML fallback.');
        }
        if (!succeeded) {
            Database.update(records, false, AccessLevel.USER_MODE);
            logs(plan).add('  ✔ [Step 3] Applied local DML update for ' + records.size() + ' existing FieldPermissions records.');
        }
    }

    private static List<Map<String, Object>> updatePayload(List<FieldPermissions> permissions) {
        List<Map<String, Object>> records = new List<Map<String, Object>>();
        for (FieldPermissions permission : permissions) {
            records.add(new Map<String, Object>{
                'attributes' => new Map<String, Object>{ 'type' => 'FieldPermissions' },
                'id' => permission.Id, 'PermissionsRead' => true, 'PermissionsEdit' => true
            });
        }
        return records;
    }

    private static void addUpdateLog(Map<String, Object> plan, HttpResponse response, Boolean succeeded) {
        if (succeeded) {
            logs(plan).add('  ✔ [Step 3] REST Composite FieldPermissions update succeeded (HTTP ' + response.getStatusCode() + ')');
        } else {
            logs(plan).add('  [Step 3:NOTE] REST Composite update returned HTTP ' + response.getStatusCode() + '. Applying local DML fallback.');
        }
    }

    private static HttpResponse sendComposite(Map<String, Object> input) {
        Map<String, Object> plan = (Map<String, Object>) input.get('plan');
        List<Map<String, Object>> records = (List<Map<String, Object>>) input.get('records');
        HttpRequest request = new HttpRequest();
        request.setEndpoint((String) plan.get('baseUrl') + (String) input.get('endpointPath'));
        request.setMethod((String) input.get('method'));
        request.setHeader('Content-Type', 'application/json');
        request.setBody(JSON.serialize(new Map<String, Object>{ 'allOrNone' => false, 'records' => records }));
        request.setTimeout(25000);
        return TuBotSelfOrgApiCallout.send(request);
    }

    private static Boolean successful(HttpResponse response) {
        return response.getStatusCode() == 200 || response.getStatusCode() == 201;
    }

    private static List<String> logs(Map<String, Object> plan) {
        return (List<String>) plan.get('logs');
    }
}
