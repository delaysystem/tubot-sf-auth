/** Captures MessagingSession custom field metadata for backup snapshots. */
public with sharing class MessagingBackupFieldCaptureService {
    public static List<Map<String, Object>> captureMessagingSessionFields(String baseUrl, List<String> logs) {
        List<Map<String, Object>> rows = new List<Map<String, Object>>();
        Map<String, Schema.SObjectField> fields = Schema.sObjectType.MessagingSession.fields.getMap();
        Map<String, Map<String, Object>> toolingFields = loadToolingFields(baseUrl, logs);
        for (String key : fields.keySet()) {
            Map<String, Object> row = fieldSnapshot(fields.get(key).getDescribe(), toolingFields);
            if (row != null) { rows.add(row); }
        }
        return rows;
    }

    private static Map<String, Map<String, Object>> loadToolingFields(String baseUrl, List<String> logs) {
        Map<String, Map<String, Object>> result = new Map<String, Map<String, Object>>();
        try {
            String query = 'SELECT Id, DeveloperName, TableEnumOrId, Description FROM CustomField ' +
                'WHERE TableEnumOrId = \'MessagingSession\'';
            String endpoint = baseUrl + '/services/data/v67.0/tooling/query?q=' + EncodingUtil.urlEncode(query, 'UTF-8');
            HttpRequest request = new HttpRequest();
            request.setEndpoint(endpoint);
            request.setMethod('GET');
            request.setHeader('Content-Type', 'application/json');
            request.setTimeout(20000);
            HttpResponse response = TuBotSelfOrgApiCallout.send(request);
            if (response.getStatusCode() != 200) { return result; }
            Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
            List<Object> records = (List<Object>) body.get('records');
            if (records != null) { addToolingFields(records, result); }
        } catch (Exception ex) {
            logs.add('MessagingSession field metadata is unavailable: ' + ex.getMessage());
        }
        return result;
    }

    private static void addToolingFields(List<Object> records, Map<String, Map<String, Object>> result) {
        for (Object value : records) {
            Map<String, Object> record = (Map<String, Object>) value;
            String name = (String) record.get('DeveloperName');
            if (String.isNotBlank(name)) { result.put(name.toLowerCase(), record); }
        }
    }

    private static Map<String, Object> fieldSnapshot(
        Schema.DescribeFieldResult field,
        Map<String, Map<String, Object>> toolingFields
    ) {
        if (!field.isCustom()) { return null; }
        String developerName = field.getName().removeEnd('__c').toLowerCase();
        Map<String, Object> tooling = toolingFields.get(developerName);
        return new Map<String, Object>{
            'apiName' => field.getName(), 'label' => field.getLabel(), 'type' => String.valueOf(field.getType()),
            'length' => field.getLength(), 'precision' => field.getPrecision(), 'scale' => field.getScale(),
            'inlineHelpText' => field.getInlineHelpText(),
            'toolingId' => tooling == null ? null : tooling.get('Id'),
            'description' => tooling == null ? null : tooling.get('Description')
        };
    }
}
