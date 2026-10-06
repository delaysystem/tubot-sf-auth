/** Creates missing MessagingSession fields through the Tooling API. */
public with sharing class SessionFieldMetadataProvisioner {
    public static List<Map<String, Object>> createFields(Map<String, Object> input) {
        List<Map<String, Object>> results = new List<Map<String, Object>>();
        List<SessionFieldsProvisioningService.FieldDefinitionSpec> specs =
            (List<SessionFieldsProvisioningService.FieldDefinitionSpec>) input.get('specs');
        for (SessionFieldsProvisioningService.FieldDefinitionSpec spec : specs) {
            results.add(createField(input, spec));
        }
        return results;
    }

    private static Map<String, Object> createField(Map<String, Object> input, SessionFieldsProvisioningService.FieldDefinitionSpec spec) {
        String baseUrl = (String) input.get('baseUrl');
        List<String> logs = (List<String>) input.get('logs');
        Map<String, Schema.SObjectField> fieldMap = (Map<String, Schema.SObjectField>) input.get('fieldMap');
        Map<String, Object> result = new Map<String, Object>{
            'apiName' => spec.apiName, 'label' => spec.label, 'type' => spec.type,
            'success' => false, 'status' => 'Pending'
        };
        if (SessionFieldsProvisioningService.isFieldInSchema(spec.apiName, fieldMap)) {
            return existingField(spec, fieldMap, logs);
        }
        HttpResponse response = createToolingField(baseUrl, spec);
        applyCreationResponse(new Map<String, Object>{
            'result' => result, 'spec' => spec, 'response' => response, 'logs' => logs
        });
        return result;
    }

    private static Map<String, Object> existingField(
        SessionFieldsProvisioningService.FieldDefinitionSpec spec,
        Map<String, Schema.SObjectField> fieldMap,
        List<String> logs
    ) {
        logs.add('  ✔ [Step 1] ' + spec.apiName + ' (' +
            SessionFieldsProvisioningService.resolveFieldApiName(spec.apiName, fieldMap) + ', ' + spec.type + ') already exists in schema.');
        return new Map<String, Object>{
            'apiName' => spec.apiName, 'label' => spec.label, 'type' => spec.type,
            'success' => true, 'status' => 'Already Exists',
            'message' => 'Field already available in schema describe.'
        };
    }

    private static HttpResponse createToolingField(
        String baseUrl,
        SessionFieldsProvisioningService.FieldDefinitionSpec spec
    ) {
        Map<String, Object> payload = new Map<String, Object>{
            'FullName' => 'MessagingSession.' + spec.apiName,
            'Metadata' => fieldMetadata(spec)
        };
        HttpRequest request = new HttpRequest();
        request.setEndpoint(baseUrl + '/services/data/v61.0/tooling/sobjects/CustomField/');
        request.setMethod('POST');
        request.setHeader('Content-Type', 'application/json');
        request.setBody(JSON.serialize(payload));
        request.setTimeout(30000);
        return TuBotSelfOrgApiCallout.send(request);
    }

    private static Map<String, Object> fieldMetadata(SessionFieldsProvisioningService.FieldDefinitionSpec spec) {
        Map<String, Object> metadata = new Map<String, Object>{
            'label' => spec.label, 'type' => spec.type, 'description' => spec.description
        };
        addMetadataValue(metadata, 'defaultValue', spec.defaultValue);
        addMetadataValue(metadata, 'length', spec.length);
        addMetadataValue(metadata, 'visibleLines', spec.visibleLines);
        addMetadataValue(metadata, 'precision', spec.precision);
        addMetadataValue(metadata, 'scale', spec.scale);
        return metadata;
    }

    private static void addMetadataValue(Map<String, Object> metadata, String key, Object value) {
        if (value != null) { metadata.put(key, value instanceof String ? value : String.valueOf(value)); }
    }

    private static void applyCreationResponse(Map<String, Object> state) {
        Map<String, Object> result = (Map<String, Object>) state.get('result');
        SessionFieldsProvisioningService.FieldDefinitionSpec spec =
            (SessionFieldsProvisioningService.FieldDefinitionSpec) state.get('spec');
        HttpResponse response = (HttpResponse) state.get('response');
        List<String> logs = (List<String>) state.get('logs');
        if (response.getStatusCode() == 200 || response.getStatusCode() == 201) {
            addCreatedField(state);
            return;
        }
        if (response.getStatusCode() == 400 && response.getBody().contains('DUPLICATE')) {
            result.put('success', true);
            result.put('status', 'Already Exists');
            logs.add('  ✔ [Step 1] ' + spec.apiName + ' already exists in org (duplicate detected).');
            return;
        }
        result.put('status', 'Failed');
        result.put('message', response.getBody());
        logs.add('  ✖ [Step 1:ERROR] Failed to create ' + spec.apiName + ' (HTTP ' +
            response.getStatusCode() + '): ' + response.getBody());
    }

    private static void addCreatedField(Map<String, Object> state) {
        Map<String, Object> result = (Map<String, Object>) state.get('result');
        SessionFieldsProvisioningService.FieldDefinitionSpec spec =
            (SessionFieldsProvisioningService.FieldDefinitionSpec) state.get('spec');
        HttpResponse response = (HttpResponse) state.get('response');
        List<String> logs = (List<String>) state.get('logs');
        Map<String, Object> responseBody = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
        String fieldId = (String) responseBody.get('id');
        result.put('id', fieldId);
        result.put('success', true);
        result.put('status', 'Created');
        logs.add('  ✔ [Step 1] Created CustomField ' + spec.apiName + ' via Tooling API (Id: ' + fieldId + ')');
    }
}
