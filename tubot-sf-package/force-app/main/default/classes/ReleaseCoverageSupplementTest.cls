@IsTest(SeeAllData=true)
private class ReleaseCoverageSupplementTest {
    private class ProvisioningResponseMock implements HttpCalloutMock {
        private Integer nextResponse = 0;
        private List<HttpRequest> requests = new List<HttpRequest>();

        public HttpResponse respond(HttpRequest request) {
            requests.add(request);
            nextResponse++;
            if (nextResponse == 1) { return response(201, '{"id":"00N000000000001AAA"}'); }
            if (nextResponse == 2) { return response(400, '{"message":"DUPLICATE_MASTER_LABEL"}'); }
            return response(500, '{"message":"metadata write rejected"}');
        }
    }

    private class FlowActivationResponseMock implements HttpCalloutMock {
        private Boolean omitLatestVersion;
        private Boolean rejectActivation;
        private Integer requestCount = 0;
        private List<HttpRequest> requests = new List<HttpRequest>();

        private FlowActivationResponseMock(Boolean omitVersion, Boolean rejectUpdate) {
            omitLatestVersion = omitVersion;
            rejectActivation = rejectUpdate;
        }

        public HttpResponse respond(HttpRequest request) {
            requests.add(request);
            requestCount++;
            if (requestCount == 3) {
                return response(rejectActivation ? 400 : 204, rejectActivation ? '{"error":"rejected"}' : '');
            }
            if (omitLatestVersion) { return response(200, '{"records":[]}'); }
            if (requestCount == 1) {
                return response(200, '{"records":[{"LatestVersion":{"VersionNumber":1}}]}');
            }
            return response(200, '{"records":[{"Id":"300000000000001AAA"}]}');
        }
    }

    @IsTest
    static void sessionFieldProvisionerHandlesCreatedDuplicateAndRejectedFields() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        ProvisioningResponseMock mock = new ProvisioningResponseMock();
        Test.setMock(HttpCalloutMock.class, mock);

        List<String> logs = new List<String>();
        List<Map<String, Object>> results;
        Test.startTest();
        results = SessionFieldMetadataProvisioner.createFields(new Map<String, Object>{
            'baseUrl' => Url.getOrgDomainUrl().toExternalForm(),
            'fieldMap' => Schema.SObjectType.MessagingSession.fields.getMap(),
            'logs' => logs,
            'specs' => new List<SessionFieldsProvisioningService.FieldDefinitionSpec>{
                fieldSpec('CoverageCreatedField__c', false),
                fieldSpec('CoverageDuplicateField__c', 'default text'),
                fieldSpec('CoverageRejectedField__c', null)
            }
        });
        Test.stopTest();

        System.assertEquals(3, results.size());
        System.assertEquals('Created', results[0].get('status'));
        System.assertEquals(true, results[0].get('success'));
        System.assertEquals('Already Exists', results[1].get('status'));
        System.assertEquals(true, results[1].get('success'));
        System.assertEquals('Failed', results[2].get('status'));
        System.assertEquals(false, results[2].get('success'));
        System.assertEquals(3, mock.requests.size());
        System.assertEquals(3, logs.size());
    }

    @IsTest
    static void panelFailuresProvideKnownGuidanceWithoutLeakingUpstreamBodies() {
        Map<String, String> expectedGuidance = new Map<String, String>{
            'unauthorized' => 'Reconnect the Salesforce package to Panel',
            'forbidden' => 'edit-salesforce-settings permission',
            'salesforce_invalid_client_credentials' => 'consumer key and secret',
            'salesforce_oauth_not_configured' => 'Run As',
            'salesforce_oauth_rejected' => 'OAuth policies',
            'salesforce_oauth_unavailable' => 'temporarily unavailable',
            'salesforce_identity_failed' => 'id scope',
            'salesforce_identity_mismatch' => 'Run As user',
            'salesforce_identity_unavailable' => 'identity lookup',
            'salesforce_identity_invalid_response' => 'invalid identity response',
            'salesforce_auth_failed' => 'authentication failed',
            'credential_encryption_key_missing' => 'encryption key is missing',
            'credential_encryption_key_invalid' => 'encryption key is invalid',
            'credential_key_missing' => 'encryption key is missing',
            'credential_key_invalid' => 'encryption key is invalid',
            'auth_service_unavailable' => 'temporarily unavailable',
            'internal_error' => 'could not complete setup',
            'deprecated' => 'retired (410 Gone)'
        };
        String requestId = '12345678-1234-1234-1234-123456789abc';
        for (String code : expectedGuidance.keySet()) {
            String message = PanelSalesforceChannelSupportService.panelFailure(
                response(403, JSON.serialize(new Map<String, String>{ 'error' => code, 'requestId' => requestId })),
                'Register channel'
            );
            System.assert(message.contains('HTTP 403, ' + code));
            System.assert(message.contains(expectedGuidance.get(code)), code);
            System.assert(message.contains(requestId), code);
        }

        String unknown = PanelSalesforceChannelSupportService.panelFailure(
            response(502, '{"error":"unknown_code","requestId":"not-a-request-id","message":"private upstream detail"}'),
            'Register channel'
        );
        System.assert(unknown.contains('Check Panel login and Salesforce ECA setup'));
        System.assertEquals(false, unknown.contains('not-a-request-id'));
        System.assertEquals(false, unknown.contains('private upstream detail'));

        String malformed = PanelSalesforceChannelSupportService.panelFailure(
            response(500, 'private upstream detail'), 'Register channel'
        );
        System.assert(malformed.contains('panel_request_failed'));
        System.assertEquals(false, malformed.contains('private upstream detail'));
    }

    @IsTest
    static void ensureInactiveLiveFlowUsesToolingApiToActivateLatestVersion() {
        List<FlowDefinitionView> inactiveFlows = [
            SELECT ApiName FROM FlowDefinitionView
            WHERE IsActive = false AND ApiName != null
            WITH USER_MODE ORDER BY ApiName ASC LIMIT 1
        ];
        if (inactiveFlows.isEmpty()) { return; }

        PanelAuthSupportService.managePermissionTestOverride = true;
        FlowActivationResponseMock mock = new FlowActivationResponseMock(false, false);
        Test.setMock(HttpCalloutMock.class, mock);
        List<String> logs = new List<String>();
        Test.startTest();
        EmbeddedDeploymentFlowActivationService.ensureFlowIsActive(new Map<String, Object>{
            'apiName' => inactiveFlows[0].ApiName,
            'logs' => logs
        });
        Test.stopTest();

        System.assertEquals(3, mock.requests.size());
        System.assertEquals('POST', mock.requests[2].getMethod());
        System.assertEquals(1, logs.size());
        System.assert(logs[0].contains(inactiveFlows[0].ApiName + ' activated at version 1.'));
    }

    @IsTest
    static void ensureInactiveLiveFlowRejectsMissingLatestVersion() {
        List<FlowDefinitionView> inactiveFlows = [
            SELECT ApiName FROM FlowDefinitionView
            WHERE IsActive = false AND ApiName != null
            WITH USER_MODE ORDER BY ApiName ASC LIMIT 1
        ];
        if (inactiveFlows.isEmpty()) { return; }

        PanelAuthSupportService.managePermissionTestOverride = true;
        FlowActivationResponseMock mock = new FlowActivationResponseMock(true, false);
        Test.setMock(HttpCalloutMock.class, mock);
        Boolean rejected = false;
        try {
            EmbeddedDeploymentFlowActivationService.ensureFlowIsActive(new Map<String, Object>{
                'apiName' => inactiveFlows[0].ApiName,
                'logs' => new List<String>()
            });
        } catch (AuraHandledException expected) {
            rejected = true;
        }
        System.assertEquals(true, rejected);
        System.assertEquals(1, mock.requests.size());
    }

    @IsTest
    static void ensureInactiveLiveFlowReportsToolingActivationRejection() {
        List<FlowDefinitionView> inactiveFlows = [
            SELECT ApiName FROM FlowDefinitionView
            WHERE IsActive = false AND ApiName != null
            WITH USER_MODE ORDER BY ApiName ASC LIMIT 1
        ];
        if (inactiveFlows.isEmpty()) { return; }

        PanelAuthSupportService.managePermissionTestOverride = true;
        FlowActivationResponseMock mock = new FlowActivationResponseMock(false, true);
        Test.setMock(HttpCalloutMock.class, mock);
        Boolean rejected = false;
        try {
            EmbeddedDeploymentFlowActivationService.ensureFlowIsActive(new Map<String, Object>{
                'apiName' => inactiveFlows[0].ApiName,
                'logs' => new List<String>()
            });
        } catch (AuraHandledException expected) {
            rejected = true;
        }
        System.assertEquals(true, rejected);
        System.assertEquals(3, mock.requests.size());
    }

    private static SessionFieldsProvisioningService.FieldDefinitionSpec fieldSpec(String apiName, Object defaultValue) {
        return new SessionFieldsProvisioningService.FieldDefinitionSpec(new Map<String, Object>{
            'apiName' => apiName,
            'label' => apiName,
            'type' => 'Text',
            'defaultValue' => defaultValue,
            'length' => 255,
            'visibleLines' => 3,
            'precision' => 12,
            'scale' => 2,
            'description' => 'Coverage test field specification'
        });
    }

    private static HttpResponse response(Integer statusCode, String body) {
        HttpResponse result = new HttpResponse();
        result.setHeader('Content-Type', 'application/json');
        result.setStatusCode(statusCode);
        result.setBody(body);
        return result;
    }
}
