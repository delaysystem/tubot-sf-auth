@IsTest(SeeAllData=true)
private class LiveOrgReleaseCoverageTest {
    @IsTest
    static void readsCurrentMessagingChannelAndPermissionState() {
        List<MessagingChannel> channels = [
            SELECT Id, DeveloperName, MasterLabel, MessageType, SessionHandlerId, IsActive
            FROM MessagingChannel
            WHERE MessageType = :SimpleSetupChannelStep.MESSAGE_TYPE_EMBEDDED
                AND SessionHandlerId != null AND IsActive = true
            WITH USER_MODE
            ORDER BY CreatedDate DESC
            LIMIT 1
        ];
        if (channels.isEmpty()) { return; }

        MessagingChannel channel = channels[0];
        Id currentUserId = UserInfo.getUserId();
        Id apiPermissionSetId = PanelSalesforceChannelSupportService.resolveApiPermissionSetId();
        System.assertNotEquals(null, apiPermissionSetId);
        System.assertEquals(currentUserId, PanelSalesforceChannelSupportService.resolveUserId(String.valueOf(currentUserId)));
        System.assertEquals(currentUserId, PanelSalesforceChannelSupportService.resolveUserId(UserInfo.getUserName()));
        System.assertEquals(null, PanelSalesforceChannelSupportService.resolveUserId(''));
        System.assertEquals(true, PanelSalesforceChannelSupportService.messagingChannelExists(channel.Id));

        Boolean expectedAssignment = [
            SELECT COUNT() FROM PermissionSetAssignment
            WHERE AssigneeId = :currentUserId AND PermissionSetId = :apiPermissionSetId WITH USER_MODE
        ] > 0;
        System.assertEquals(
            expectedAssignment,
            PanelSalesforceChannelSupportService.validateSalesforceTargets(channel.Id, currentUserId)
        );

        Map<String, Object> discovered = SimpleSetupChannelStep.findChannelByDeveloperName(channel.DeveloperName);
        System.assertEquals(channel.Id, (Id) discovered.get('id'));
        System.assertNotEquals(null, SimpleSetupChannelStep.findExistingChannel());
        System.assertEquals(channel.Id, (Id) SimpleSetupChannelStep.ensureActive(String.valueOf(channel.Id)).get('id'));

        System.assertEquals(null, PanelSalesforceChannelSupportService.resolveUserId(
            'missing-' + UserInfo.getOrganizationId() + '@example.invalid'
        ));
        Boolean missingUserRejected = false;
        try {
            PanelSalesforceChannelSupportService.validateSalesforceTargets(channel.Id, null);
        } catch (AuraHandledException expected) {
            missingUserRejected = true;
        }
        System.assertEquals(true, missingUserRejected);

        List<Group> queues = [
            SELECT Id, DeveloperName, Name FROM Group
            WHERE Id = :channel.SessionHandlerId AND Type = 'Queue' WITH USER_MODE LIMIT 1
        ];
        if (!queues.isEmpty()) {
            Group queue = queues[0];
            List<GroupMember> memberships = [
                SELECT Id FROM GroupMember
                WHERE GroupId = :queue.Id AND UserOrGroupId = :currentUserId WITH USER_MODE LIMIT 1
            ];
            if (!memberships.isEmpty()) {
                Map<String, Object> activated = SimpleSetupChannelStep.activateAndVerify(
                    String.valueOf(channel.Id), currentUserId, queue.DeveloperName
                );
                System.assertEquals(channel.Id, (Id) activated.get('id'));

                SimpleSetupChannelStep.ChannelSpec existingChannel = new SimpleSetupChannelStep.ChannelSpec();
                existingChannel.channelName = channel.DeveloperName;
                existingChannel.channelLabel = channel.MasterLabel;
                existingChannel.queueName = queue.DeveloperName;
                existingChannel.queueLabel = queue.Name;
                existingChannel.userId = currentUserId;
                Map<String, Object> reused = SimpleSetupChannelStep.createChannelWithQueue(existingChannel);
                System.assertEquals(channel.Id, (Id) reused.get('id'));
            }
        }

        List<Tubot_API_Channel__c> unownedConnections = [
            SELECT Id, Integration_User_Id__c, Assignment_Owned__c, Assignment_Id__c
            FROM Tubot_API_Channel__c
            WHERE Assignment_Owned__c = false WITH USER_MODE
        ];
        PanelSalesforceChannelCleanupService.revokeUnusedAssignments(unownedConnections);
    }

    @IsTest
    static void readsSessionSchemaAndExistingPermissionSets() {
        Map<String, Schema.SObjectField> fieldMap = Schema.SObjectType.MessagingSession.fields.getMap();
        List<SessionFieldsProvisioningService.FieldDefinitionSpec> existingSpecs =
            new List<SessionFieldsProvisioningService.FieldDefinitionSpec>();
        List<Object> existingFieldSnapshots = new List<Object>();
        for (SessionFieldsProvisioningService.FieldDefinitionSpec spec :
            SessionFieldsProvisioningService.getRequiredFieldSpecs()) {
            if (SessionFieldsProvisioningService.isFieldInSchema(spec.apiName, fieldMap)) {
                existingSpecs.add(spec);
                existingFieldSnapshots.add(new Map<String, Object>{ 'apiName' => spec.apiName });
            }
        }
        System.assert(!existingSpecs.isEmpty(), 'The package schema must expose its MessagingSession fields.');

        List<String> logs = new List<String>();
        List<Map<String, Object>> provisioned = SessionFieldMetadataProvisioner.createFields(new Map<String, Object>{
            'baseUrl' => Url.getOrgDomainUrl().toExternalForm(),
            'fieldMap' => fieldMap,
            'logs' => logs,
            'specs' => existingSpecs
        });
        System.assertEquals(existingSpecs.size(), provisioned.size());
        for (Map<String, Object> result : provisioned) {
            System.assertEquals('Already Exists', result.get('status'));
        }

        MessagingBackupRestoreToolingService.restoreSessionFields(existingFieldSnapshots, null, logs);
        System.assert(logs[logs.size() - 1].contains('fields are present'));

        String className = SessionFieldsProvisioningService.class.getName();
        String packageNamespace = className.contains('.') ? className.substringBefore('.') : null;
        Map<String, PermissionSet> permissionSets = new Map<String, PermissionSet>();
        for (PermissionSet permissionSet : [
            SELECT Id, Name FROM PermissionSet
            WHERE NamespacePrefix = :packageNamespace
                AND Name IN ('Panel_Messaging_Session_Admin_Access', 'Tubot_Salesforce_API_Read')
            WITH USER_MODE
        ]) {
            permissionSets.put(permissionSet.Name, permissionSet);
        }
        if (permissionSets.size() == 2) {
            PermissionSet sessionAdmin = permissionSets.get('Panel_Messaging_Session_Admin_Access');
            PermissionSet apiAccess = permissionSets.get('Tubot_Salesforce_API_Read');
            Map<String, Object> plan = SessionFieldPermissionPlanBuilder.build(new Map<String, Object>{
                'baseUrl' => Url.getOrgDomainUrl().toExternalForm(),
                'logs' => logs,
                'aiPermSetId' => sessionAdmin.Id,
                'agentPermSetId' => apiAccess.Id,
                'aiPermSetName' => sessionAdmin.Name,
                'agentPermSetName' => apiAccess.Name,
                'fieldMap' => fieldMap,
                'specs' => existingSpecs
            });
            System.assertEquals(existingSpecs.size() * 2, ((List<Map<String, Object>>) plan.get('summary')).size());

            Set<Id> permissionSetIds = new Set<Id>{ sessionAdmin.Id, apiAccess.Id };
            Set<Id> assignedPermissionSetIds = new Set<Id>();
            for (PermissionSetAssignment assignment : [
                SELECT PermissionSetId FROM PermissionSetAssignment
                WHERE AssigneeId = :UserInfo.getUserId() AND PermissionSetId IN :permissionSetIds
                WITH USER_MODE
            ]) {
                assignedPermissionSetIds.add(assignment.PermissionSetId);
            }
            if (assignedPermissionSetIds.size() == permissionSetIds.size()) {
                Map<String, Object> verification = SessionFieldAccessVerifier.verify(new Map<String, Object>{
                    'targetUserIdentifier' => 'default',
                    'aiPermSetDevName' => sessionAdmin.Name,
                    'agentPermSetDevName' => apiAccess.Name,
                    'logs' => logs
                });
                System.assertEquals(true, verification.get('userAssigned'));
            }
        }
    }

    @IsTest
    static void capturesCurrentOrgMetadataAndSettingsAccess() {
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

        List<FlowDefinitionView> activeFlows = [
            SELECT ApiName FROM FlowDefinitionView WHERE IsActive = true WITH USER_MODE
            ORDER BY ApiName ASC LIMIT 1
        ];
        if (!activeFlows.isEmpty()) {
            EmbeddedDeploymentFlowActivationService.ensureFlowIsActive(new Map<String, Object>{
                'apiName' => activeFlows[0].ApiName,
                'logs' => logs
            });
            System.assert(logs[logs.size() - 1].contains(activeFlows[0].ApiName));
        }

        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        System.assertNotEquals(null, PanelBaseUrlResolver.resolve(config));
        System.assertNotEquals(null, PanelAuthSupportService.getPanelBaseUrl());
        System.assertEquals('production', PanelEnvironmentResolver.normalize(null));
        System.assertEquals('staging', PanelEnvironmentResolver.normalize(' STAGING '));

        RestContext.request = new RestRequest();
        RestContext.request.requestURI = '/services/apexrest/panel-settings-access/v1';
        RestContext.request.httpMethod = 'GET';
        RestContext.response = new RestResponse();
        PanelSettingsAccessResource.getAccess();
        Map<String, Object> access = (Map<String, Object>) JSON.deserializeUntyped(
            RestContext.response.responseBody.toString()
        );
        System.assertEquals(UserInfo.getOrganizationId(), access.get('organization_id'));
        System.assertEquals(UserInfo.getUserId(), access.get('user_id'));
        System.assertEquals(PanelAuthSupportService.checkManageTubotPermission(), access.get('authorized'));
        Integer expectedStatus = (Boolean) access.get('authorized') ? 200 : 403;
        System.assertEquals(expectedStatus, RestContext.response.statusCode);

        if (PanelAuthSupportService.checkManageTubotPermission()) {
            PanelAuthSupportService.requireSettingsAdmin();
            PanelAuthController.getPanelAuthStatus();
            SessionFieldsProvisioningService.getMessagingChannels();
            MessagingBackupService.getBackups();
            PanelSalesforceChannelCleanupService.clearLocalConnections(null);
            if ([SELECT COUNT() FROM Tubot_API_Channel__c WITH USER_MODE] == 0) {
                PanelSalesforceChannelCleanupService.clearLocalConnections(UserInfo.getOrganizationId());
            }
        }
    }

    @IsTest
    static void runsReadOnlySetupPreflightAgainstCurrentOrgState() {
        if (!PanelAuthSupportService.checkManageTubotPermission()) { return; }

        Map<String, Object> status = SimpleSetupController.getStatus();
        System.assertEquals(UserInfo.getOrganizationId(), status.get('orgId'));
        System.assert(status.containsKey('panelConnected'));
        System.assert(status.containsKey('channel'));
        System.assertEquals(SimpleSetupEcaStep.APP_NAME, status.get('ecaAppName'));

        List<Map<String, Object>> candidates = TubotSetupWizardController.getIntegrationCandidates();
        Boolean currentUserIsCandidate = false;
        for (Map<String, Object> candidate : candidates) {
            if (String.valueOf(candidate.get('id')) == String.valueOf(UserInfo.getUserId())) {
                currentUserIsCandidate = true;
                break;
            }
        }
        Id apiPermissionSetId = PanelSalesforceChannelSupportService.resolveApiPermissionSetId();
        Boolean apiPermissionAlreadyAssigned = apiPermissionSetId != null && [
            SELECT COUNT() FROM PermissionSetAssignment
            WHERE AssigneeId = :UserInfo.getUserId() AND PermissionSetId = :apiPermissionSetId WITH USER_MODE
        ] > 0;

        Boolean preAuthAlreadyAssigned = !SimpleSetupEcaStep.preAuthExists();
        if (!preAuthAlreadyAssigned) {
            try {
                SimpleSetupEcaStep.checkMembership(UserInfo.getUserId());
                preAuthAlreadyAssigned = true;
            } catch (AuraHandledException expected) {
                preAuthAlreadyAssigned = false;
            }
        }
        if (currentUserIsCandidate && apiPermissionAlreadyAssigned && preAuthAlreadyAssigned) {
            Map<String, Object> userStep = SimpleSetupController.runStep('user', new Map<String, Object>{
                'user' => new Map<String, Object>{ 'id' => String.valueOf(UserInfo.getUserId()) }
            });
            System.assertEquals('done', userStep.get('status'));
        }

        List<MessagingChannel> channels = [
            SELECT Id FROM MessagingChannel WHERE IsActive = true WITH USER_MODE ORDER BY CreatedDate DESC LIMIT 1
        ];
        if (!channels.isEmpty()) {
            Map<String, Object> channelStep = SimpleSetupController.runStep('channel', new Map<String, Object>{
                'channel' => new Map<String, Object>{ 'id' => String.valueOf(channels[0].Id) }
            });
            System.assertEquals('done', channelStep.get('status'));
        }

        Map<String, Object> ecaGuidance = SimpleSetupEcaStep.getPoliciesGuidance();
        System.assertEquals(SimpleSetupEcaStep.APP_NAME, ecaGuidance.get('appName'));
        System.assert(String.valueOf(ecaGuidance.get('setupUrl')).contains(SimpleSetupEcaStep.SETUP_PATH));
        SimpleSetupEcaStep.ecaExists();
        if (SimpleSetupEcaStep.preAuthExists() && preAuthAlreadyAssigned) {
            Map<String, Object> preparedAuthorization = SimpleSetupEcaStep.prepare(UserInfo.getUserId());
            System.assertEquals('popup-required', preparedAuthorization.get('status'));
        }

        Map<String, Object> ecaStep = SimpleSetupController.runStep('eca', new Map<String, Object>());
        System.assertEquals('failed', ecaStep.get('status'));
        System.assertEquals(
            'failed',
            SimpleSetupController.runStep('finalize', new Map<String, Object>()).get('status')
        );
        System.assertEquals(
            'failed',
            SimpleSetupController.runStep('finalize-register', new Map<String, Object>()).get('status')
        );
        System.assertEquals(
            'failed',
            SimpleSetupController.runStep('unsupported-step', new Map<String, Object>()).get('status')
        );

        Boolean invalidEcaUserRejected = false;
        try {
            SimpleSetupEcaStep.prepare(null);
        } catch (AuraHandledException expected) {
            invalidEcaUserRejected = true;
        }
        System.assertEquals(true, invalidEcaUserRejected);

        Boolean invalidOutcomeRejected = false;
        try {
            SimpleSetupEcaStep.outcome('invalid-state');
        } catch (AuraHandledException expected) {
            invalidOutcomeRejected = true;
        }
        System.assertEquals(true, invalidOutcomeRejected);
    }

    @IsTest
    static void rejectsMissingCredentialsAndUnconnectedChannelOperations() {
        Boolean missingRefreshCredentialRejected = false;
        try {
            PanelExternalCredentialTokenService.store(null, null);
        } catch (AuraHandledException expected) {
            missingRefreshCredentialRejected = true;
        }
        System.assertEquals(true, missingRefreshCredentialRejected);

        Boolean missingChannelRejected = false;
        try {
            PanelSalesforceChannelSupportService.validateSalesforceTargets(null, UserInfo.getUserId());
        } catch (AuraHandledException expected) {
            missingChannelRejected = true;
        }
        System.assertEquals(true, missingChannelRejected);

        Boolean invalidFlowRejected = false;
        try {
            EmbeddedDeploymentFlowActivationService.activateFlowVersion(new Map<String, Object>{
                'apiName' => '', 'versionNumber' => 0
            });
        } catch (AuraHandledException expected) {
            invalidFlowRejected = true;
        }
        System.assertEquals(true, invalidFlowRejected);

        if (!PanelAuthSupportService.checkManageTubotPermission()) { return; }
        Map<String, Object> auth = PanelAuthController.getPanelAuthStatus();
        if (auth.get('isConnected') == true && auth.get('canEditSettings') == true) { return; }

        List<MessagingChannel> channels = [
            SELECT Id FROM MessagingChannel WHERE IsActive = true WITH USER_MODE LIMIT 1
        ];
        if (channels.isEmpty()) { return; }
        String channelId = String.valueOf(channels[0].Id);
        String userId = String.valueOf(UserInfo.getUserId());

        Boolean preparationRejected = false;
        try {
            PanelSalesforceChannelPreparationService.prepare(channelId, userId);
        } catch (AuraHandledException expected) {
            preparationRejected = true;
        }
        System.assertEquals(true, preparationRejected);

        Boolean connectionRejected = false;
        try {
            PanelSalesforceChannelConnectService.connect(JSON.serialize(new Map<String, String>{
                'channelId' => channelId, 'integrationUserId' => userId
            }));
        } catch (AuraHandledException expected) {
            connectionRejected = true;
        }
        System.assertEquals(true, connectionRejected);

        Boolean finalizationRejected = false;
        try {
            SimpleSetupFinalizeStep.prepareChannel(channelId, userId);
        } catch (SimpleSetupFinalizeStep.FinalizeException expected) {
            finalizationRejected = true;
        }
        System.assertEquals(true, finalizationRejected);
    }

    @IsTest
    static void handlesDisconnectedPanelAndRejectedApiInputsFromCurrentOrg() {
        if (!PanelAuthSupportService.checkManageTubotPermission()) { return; }

        MCP_Config__c config = PanelAuthSupportService.getConfig();
        String currentEnvironment = PanelEnvironmentResolver.selectedKey(config);
        Map<String, Object> sameEnvironment = PanelAuthController.setPanelEnvironment(currentEnvironment);
        System.assertEquals(currentEnvironment, sameEnvironment.get('panelEnvironment'));
        if (String.isBlank(config.Panel_Team_Id__c)) {
            PanelAuthController.ensurePanelSession(false);
        }

        Map<String, Object> poll = PanelAuthController.pollOAuthCode('', '');
        System.assertEquals(false, poll.get('success'));

        Boolean blankCodeRejected = false;
        try {
            PanelAuthController.exchangeOAuthCode(JSON.serialize(new Map<String, String>{
                'code' => '',
                'redirectUri' => PanelAuthSupportService.getPanelBaseUrl() + '/oauth/callback',
                'codeVerifier' => ''
            }));
        } catch (AuraHandledException expected) {
            blankCodeRejected = true;
        }
        System.assertEquals(true, blankCodeRejected);

        Boolean missingRequestRejected = false;
        try {
            TuBotSelfOrgApiCallout.send(null);
        } catch (AuraHandledException expected) {
            missingRequestRejected = true;
        }
        System.assertEquals(true, missingRequestRejected);
    }

    @IsTest
    static void runsIdleAssignmentAndFlowRestorePathsFromLiveOrgState() {
        Id currentUserId = UserInfo.getUserId();
        String currentUserIdText = String.valueOf(currentUserId);
        Id apiPermissionSetId = PanelSalesforceChannelSupportService.resolveApiPermissionSetId();
        if (apiPermissionSetId == null || [
            SELECT COUNT() FROM PermissionSetAssignment
            WHERE AssigneeId = :currentUserId AND PermissionSetId = :apiPermissionSetId WITH USER_MODE
        ] == 0) { return; }

        List<PanelApiAssignmentQueueable.Request> requests = new List<PanelApiAssignmentQueueable.Request>{
            new PanelApiAssignmentQueueable.Request(currentUserId, 'ASSIGN', null),
            new PanelApiAssignmentQueueable.Request(currentUserId, 'REMOVE', null)
        };
        new PanelApiAssignmentQueueable(requests).execute(null);

        Integer existingApiChannelCount = [
            SELECT COUNT() FROM Tubot_API_Channel__c
            WHERE Integration_User_Id__c = :currentUserIdText WITH USER_MODE
        ];
        if (existingApiChannelCount == 0) {
            new PanelApiAssignmentRecordQueueable(new List<PanelApiAssignmentQueueable.Request>{
                new PanelApiAssignmentQueueable.Request(currentUserId, 'RECORD', null)
            }).execute(null);
        }

        Test.startTest();
        PackageAdminPermissionAssignmentService.assignToInstaller(currentUserId);
        Test.stopTest();
        System.assertEquals(
            1,
            [SELECT COUNT() FROM PermissionSetAssignment
             WHERE AssigneeId = :currentUserId AND PermissionSetId IN (
                 SELECT Id FROM PermissionSet WHERE Name = 'Panel_Settings_Admin_Access'
             ) WITH USER_MODE]
        );

        List<FlowDefinitionView> activeFlows = [
            SELECT ApiName, VersionNumber FROM FlowDefinitionView
            WHERE IsActive = true WITH USER_MODE ORDER BY ApiName LIMIT 1
        ];
        List<String> logs = new List<String>();
        List<Object> snapshots = new List<Object>{
            new Map<String, Object>{ 'apiName' => 'inactive-flow-is-ignored', 'isActive' => false }
        };
        if (!activeFlows.isEmpty()) {
            snapshots.add(new Map<String, Object>{
                'apiName' => activeFlows[0].ApiName,
                'isActive' => true,
                'activeVersionNumber' => null
            });
            snapshots.add(new Map<String, Object>{
                'apiName' => activeFlows[0].ApiName,
                'isActive' => true,
                'activeVersionNumber' => activeFlows[0].VersionNumber
            });
        }
        MessagingBackupRestoreFlowService.restoreFlows(snapshots, null, logs);
        System.assertEquals(activeFlows.isEmpty() ? 0 : 2, logs.size());
        if (!activeFlows.isEmpty()) {
            System.assert(logs[0].contains(activeFlows[0].ApiName));
            System.assertEquals('Test flow activation request recorded.', logs[1]);
        }
    }
}
