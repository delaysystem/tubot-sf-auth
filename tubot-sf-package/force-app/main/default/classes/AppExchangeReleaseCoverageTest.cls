@IsTest
private class AppExchangeReleaseCoverageTest {
    @IsTest
    static void restoreActivatesOnlyActiveFlowSnapshots() {
        List<String> logs = new List<String>();
        MessagingBackupRestoreFlowService.restoreFlows(new List<Object>{
            new Map<String, Object>{ 'apiName' => 'InactiveFlow', 'isActive' => false, 'activeVersionNumber' => 3 },
            new Map<String, Object>{ 'apiName' => '', 'isActive' => true, 'activeVersionNumber' => 3 },
            new Map<String, Object>{ 'apiName' => 'RestoredFlow', 'isActive' => true, 'activeVersionNumber' => 4 }
        }, null, logs);

        System.assertEquals(1, logs.size());
        System.assertEquals('Test flow activation request recorded.', logs[0]);
    }

    @IsTest
    static void restoreRejectsAnActiveFlowWithoutANameOrVersion() {
        Boolean rejected = false;
        try {
            EmbeddedDeploymentFlowActivationService.activateFlowVersion(new Map<String, Object>{
                'apiName' => ' ', 'versionNumber' => 0, 'logs' => new List<String>()
            });
        } catch (AuraHandledException expected) {
            rejected = true;
        }
        System.assertEquals(true, rejected);
    }

    @IsTest
    static void restoreReportsWhenFlowIsNotInTheTargetOrg() {
        Boolean rejected = false;
        try {
            EmbeddedDeploymentFlowActivationService.ensureFlowIsActive(new Map<String, Object>{
                'apiName' => 'Missing_' + String.valueOf(Crypto.getRandomInteger()).replace('-', ''),
                'logs' => new List<String>()
            });
        } catch (AuraHandledException expected) {
            rejected = true;
        }
        System.assertEquals(true, rejected);
    }

    @IsTest
    static void restoreRejectsAnEmptyFlowName() {
        Boolean rejected = false;
        try {
            EmbeddedDeploymentFlowActivationService.ensureFlowIsActive(new Map<String, Object>{
                'apiName' => '', 'logs' => new List<String>()
            });
        } catch (AuraHandledException expected) {
            rejected = true;
        }
        System.assertEquals(true, rejected);
    }

    @IsTest
    static void restoreLeavesAnExistingActiveOrgFlowAlone() {
        List<FlowDefinitionView> activeFlows = [
            SELECT ApiName FROM FlowDefinitionView WHERE IsActive = true WITH USER_MODE
            ORDER BY ApiName ASC LIMIT 1
        ];
        if (activeFlows.isEmpty()) {
            return;
        }
        List<String> logs = new List<String>();
        EmbeddedDeploymentFlowActivationService.ensureFlowIsActive(new Map<String, Object>{
            'apiName' => activeFlows[0].ApiName, 'logs' => logs
        });
        System.assertEquals(1, logs.size());
        System.assertEquals('Flow ' + activeFlows[0].ApiName + ' is already active.', logs[0]);
    }

    @IsTest(SeeAllData=true)
    static void captureReadsCurrentOrgOmnichannelMetadata() {
        List<String> logs = new List<String>();
        List<Map<String, Object>> channels = MessagingBackupOmniCaptureService.captureMessagingChannels(logs);
        Map<String, Object> queues = MessagingBackupOmniCaptureService.captureQueues(logs);
        Map<String, Object> skills = MessagingBackupOmniCaptureService.captureSkills(logs);
        List<Map<String, Object>> flows = MessagingBackupOmniCaptureService.captureFlows(logs);

        System.assertNotEquals(null, channels);
        System.assert(queues.containsKey('queues'));
        System.assert(queues.containsKey('queueSobjects'));
        System.assert(queues.containsKey('groupMembers'));
        System.assert(skills.containsKey('skills'));
        System.assert(skills.containsKey('skillUsers'));
        System.assert(skills.containsKey('routingConfigs'));
        System.assertNotEquals(null, flows);
    }

    @IsTest
    static void panelAccessResourceReportsTheCurrentSalesforceIdentity() {
        RestContext.request = new RestRequest();
        RestContext.response = new RestResponse();

        PanelSettingsAccessResource.getAccess();

        Map<String, Object> responseBody = (Map<String, Object>) JSON.deserializeUntyped(
            RestContext.response.responseBody.toString()
        );
        Boolean authorized = PanelAuthSupportService.checkManageTubotPermission();
        System.assertEquals(UserInfo.getOrganizationId(), responseBody.get('organization_id'));
        System.assertEquals(UserInfo.getUserId(), responseBody.get('user_id'));
        System.assertEquals(authorized, responseBody.get('authorized'));
        System.assertEquals(authorized ? 200 : 403, RestContext.response.statusCode);
    }

    @IsTest
    static void panelBaseUrlResolverValidatesLegacyAndUsesSelectedMetadata() {
        MCP_Config__c legacy = new MCP_Config__c(Panel_Base_URL__c = 'https://panel.example.test/');
        System.assertEquals('https://panel.example.test', PanelBaseUrlResolver.resolve(legacy));

        MCP_Config__c staging = new MCP_Config__c(Panel_Environment__c = PanelEnvironmentResolver.STAGING);
        System.assertEquals(
            PanelEnvironmentResolver.panelBaseUrl(staging),
            PanelBaseUrlResolver.resolve(staging)
        );

        for (String invalidOrigin : new List<String>{
            'http://panel.example.test',
            'https://panel.example.test/path',
            'https://panel.example.test:8443',
            'not-a-url'
        }) {
            Boolean rejected = false;
            try {
                PanelBaseUrlResolver.resolve(new MCP_Config__c(Panel_Base_URL__c = invalidOrigin));
            } catch (AuraHandledException expected) {
                rejected = true;
            }
            System.assertEquals(true, rejected, invalidOrigin);
        }
    }

    @IsTest
    static void sessionFieldProvisionerReportsFieldsFromTheLiveSchema() {
        Map<String, Schema.SObjectField> fieldMap = Schema.SObjectType.MessagingSession.fields.getMap();
        List<SessionFieldsProvisioningService.FieldDefinitionSpec> existingSpecs =
            new List<SessionFieldsProvisioningService.FieldDefinitionSpec>();
        for (SessionFieldsProvisioningService.FieldDefinitionSpec spec :
            SessionFieldsProvisioningService.getRequiredFieldSpecs()) {
            if (SessionFieldsProvisioningService.isFieldInSchema(spec.apiName, fieldMap)) {
                existingSpecs.add(spec);
            }
        }
        System.assert(!existingSpecs.isEmpty(), 'The package schema should expose its MessagingSession fields.');

        List<String> logs = new List<String>();
        List<Map<String, Object>> results = SessionFieldMetadataProvisioner.createFields(
            new Map<String, Object>{
                'baseUrl' => Url.getOrgDomainUrl().toExternalForm(),
                'fieldMap' => fieldMap,
                'logs' => logs,
                'specs' => existingSpecs
            }
        );

        System.assertEquals(existingSpecs.size(), results.size());
        System.assertEquals(existingSpecs.size(), logs.size());
        for (Map<String, Object> result : results) {
            System.assertEquals(true, result.get('success'));
            System.assertEquals('Already Exists', result.get('status'));
        }
    }

    @IsTest
    static void fieldPermissionRestServiceSkipsAnEmptyPlan() {
        List<String> logs = new List<String>();
        SessionFieldPermissionRestService.apply(new Map<String, Object>{
            'baseUrl' => Url.getOrgDomainUrl().toExternalForm(),
            'logs' => logs,
            'restInsertRecords' => new List<Map<String, Object>>(),
            'dmlInsertRecords' => new List<FieldPermissions>(),
            'dmlUpdateRecords' => new List<FieldPermissions>()
        });
        System.assertEquals(0, logs.size());
    }

    @IsTest
    static void tokenStoreRejectsAMissingRefreshCredential() {
        Boolean rejected = false;
        try {
            PanelExternalCredentialTokenService.store('unused-access-value', null);
        } catch (AuraHandledException expected) {
            rejected = true;
        }
        System.assertEquals(true, rejected);
    }

    @IsTest
    static void restoreAcceptsSessionFieldsAlreadyInPackageSchema() {
        List<String> logs = new List<String>();
        MessagingBackupRestoreToolingService.restoreSessionFields(new List<Object>{
            new Map<String, Object>{ 'apiName' => 'AI_Conversation_Summary__c' },
            new Map<String, Object>{ 'apiName' => '' }
        }, null, logs);

        System.assertEquals(true, logs[0].contains('All 2 backed-up MessagingSession fields are present.'));
    }
}
