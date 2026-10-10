@IsTest
private class SimpleSetupControllerTest {
    private static void grantAdmin() {
        PanelAuthSupportService.managePermissionTestOverride = true;
    }

    private static User createStandardUser(String marker) {
        User candidate = new User(
            Alias = 'ss' + marker, Email = 'simple-setup-' + marker + '@example.com',
            EmailEncodingKey = 'UTF-8', LastName = 'SimpleSetup' + marker,
            LanguageLocaleKey = 'en_US', LocaleSidKey = 'en_US',
            ProfileId = UserInfo.getProfileId(), TimeZoneSidKey = 'America/Los_Angeles',
            Username = 'simple-setup-' + marker + '-' + Crypto.getRandomInteger() + '@example.com'
        );
        insert candidate;
        return candidate;
    }

    @IsTest
    static void nonAdminIsRejected() {
        PanelAuthSupportService.managePermissionTestOverride = false;
        Map<String, Object> result = SimpleSetupController.runStep(
            'user', new Map<String, Object>()
        );
        System.assertEquals('failed', String.valueOf(result.get('status')));
        System.assert(String.valueOf(result.get('message')).contains('permission'));
    }

    @IsTest
    static void unknownStepIsRejected() {
        grantAdmin();
        Map<String, Object> result = SimpleSetupController.runStep(
            'nope', new Map<String, Object>()
        );
        System.assertEquals('failed', String.valueOf(result.get('status')));
        System.assert(String.valueOf(result.get('message')).contains('Unknown setup step'));
    }

    @IsTest
    static void legacyPollingStepsAreRejected() {
        // The session-era deploy-polling steps no longer exist: every step is
        // synchronous, so stale callers fail closed with guidance.
        grantAdmin();
        for (String legacy : new List<String>{ 'channel-status', 'eca-status' }) {
            Map<String, Object> result = SimpleSetupController.runStep(
                legacy, new Map<String, Object>()
            );
            System.assertEquals('failed', String.valueOf(result.get('status')), legacy);
            System.assert(
                String.valueOf(result.get('message')).contains('Unknown setup step'), legacy
            );
        }
    }

    @IsTest
    static void statusReportsOrgShape() {
        grantAdmin();
        Map<String, Object> status = SimpleSetupController.getStatus();
        System.assertEquals(UserInfo.getOrganizationId(), String.valueOf(status.get('orgId')));
        System.assert(status.containsKey('panelConnected'));
        System.assert(status.containsKey('channel'));
        System.assertEquals('Tubot_Channel_API', String.valueOf(status.get('ecaAppName')));
        System.assert(status.containsKey('ecaExists'));
    }

    @IsTest
    static void ecaMembershipCheckReflectsTheCurrentAssignment() {
        grantAdmin();
        Boolean hasPreAuthAssignment = false;
        String className = SimpleSetupEcaStep.class.getName();
        String namespace = className.contains('.') ? className.substringBefore('.') : null;
        String qualifiedName = String.isBlank(namespace)
            ? SimpleSetupEcaStep.PREAUTH_PERMISSION_SET
            : namespace + '__' + SimpleSetupEcaStep.PREAUTH_PERMISSION_SET;
        Set<Id> preAuthIds = new Set<Id>();
        for (PermissionSet candidate : [
            SELECT Id, NamespacePrefix
            FROM PermissionSet
            WHERE Name = :SimpleSetupEcaStep.PREAUTH_PERMISSION_SET OR Name = :qualifiedName
            WITH USER_MODE
        ]) {
            Boolean belongsToPackage = String.isBlank(namespace)
                ? String.isBlank(candidate.NamespacePrefix)
                : candidate.NamespacePrefix == namespace;
            if (belongsToPackage) { preAuthIds.add(candidate.Id); }
        }
        if (!preAuthIds.isEmpty()) {
            hasPreAuthAssignment = [
                SELECT COUNT() FROM PermissionSetAssignment
                WHERE AssigneeId = :UserInfo.getUserId() AND PermissionSetId IN :preAuthIds
                WITH USER_MODE
            ] == 1;
        }

        Boolean rejected = false;
        try {
            SimpleSetupController.checkEcaAuthorization(String.valueOf(UserInfo.getUserId()));
        } catch (AuraHandledException expected) {
            rejected = true;
        }
        System.assertEquals(!hasPreAuthAssignment, rejected);
    }

    @IsTest
    static void userStepAutoSelectsAndAssigns() {
        grantAdmin();
        createStandardUser('u1');
        Test.startTest();
        Map<String, Object> result = SimpleSetupController.runStep(
            'user', new Map<String, Object>()
        );
        Test.stopTest();
        System.assertEquals('done', String.valueOf(result.get('status')));
        Map<String, Object> user = (Map<String, Object>) result.get('user');
        Id selectedId = (Id) user.get('id');
        System.assertNotEquals(null, selectedId);
        PermissionSet apiPs = [
            SELECT Id FROM PermissionSet WHERE Name = 'Tubot_Salesforce_API_Read' LIMIT 1
        ];
        Integer assignments = [
            SELECT COUNT() FROM PermissionSetAssignment
            WHERE AssigneeId = :selectedId AND PermissionSetId = :apiPs.Id
        ];
        System.assertEquals(1, assignments);
    }

    @IsTest
    static void finalizeRequiresChannelAndUser() {
        grantAdmin();
        Map<String, Object> missingChannel = SimpleSetupController.runStep(
            'finalize', new Map<String, Object>()
        );
        System.assertEquals('failed', String.valueOf(missingChannel.get('status')));
        Map<String, Object> missingUser = SimpleSetupController.runStep(
            'finalize',
            new Map<String, Object>{ 'channel' => new Map<String, Object>{ 'id' => '0Mj000000000000AAA' } }
        );
        System.assertEquals('failed', String.valueOf(missingUser.get('status')));
        System.assert(String.valueOf(missingUser.get('message')).contains('integration user'));
    }

    @IsTest
    static void channelStepCreatesChannelWhenNoneExists() {
        grantAdmin();
        SimpleSetupChannelStep.forceNoExistingChannel = true;
        User candidate = createStandardUser('u2');
        Test.startTest();
        Map<String, Object> result = SimpleSetupController.runStep(
            'channel',
            new Map<String, Object>{
                'user' => new Map<String, Object>{ 'id' => candidate.Id }
            }
        );
        Test.stopTest();
        // Seam forces the nothing-exists path regardless of org rows: the
        // channel/queue pair is created synchronously with DML (no deploy).
        System.assertEquals('done', String.valueOf(result.get('status')));
        System.assertEquals(true, result.get('created'));
        Map<String, Object> channel = (Map<String, Object>) result.get('channel');
        System.assertNotEquals(null, channel.get('id'));
        // Blind-verify the created rows directly in the target schema.
        List<MessagingChannel> channels = [
            SELECT Id, IsActive, SessionHandlerId FROM MessagingChannel
            WHERE Id = :(Id) channel.get('id') LIMIT 1
        ];
        System.assertEquals(1, channels.size());
        System.assertEquals(true, channels[0].IsActive);
        System.assertNotEquals(null, channels[0].SessionHandlerId);
        Integer memberCount = [
            SELECT COUNT() FROM GroupMember
            WHERE GroupId = :(Id) channels[0].SessionHandlerId AND UserOrGroupId = :candidate.Id
        ];
        System.assertEquals(1, memberCount);

        SimpleSetupChannelStep.ChannelSpec repeatSpec = new SimpleSetupChannelStep.ChannelSpec();
        repeatSpec.channelName = SimpleSetupChannelStep.DEFAULT_CHANNEL_NAME;
        repeatSpec.channelLabel = SimpleSetupChannelStep.DEFAULT_CHANNEL_LABEL;
        repeatSpec.queueName = SimpleSetupChannelStep.DEFAULT_QUEUE_NAME;
        repeatSpec.queueLabel = SimpleSetupChannelStep.DEFAULT_QUEUE_LABEL;
        repeatSpec.userId = candidate.Id;
        Map<String, Object> reused = SimpleSetupChannelStep.createChannelWithQueue(repeatSpec);
        System.assertEquals(channel.get('id'), reused.get('id'));
        System.assertEquals(1, [
            SELECT COUNT() FROM GroupMember
            WHERE GroupId = :(Id) channels[0].SessionHandlerId AND UserOrGroupId = :candidate.Id
        ]);

        SimpleSetupChannelStep.forceNoExistingChannel = false;
        Map<String, Object> selectedAgain = SimpleSetupController.runStep(
            'channel',
            new Map<String, Object>{
                'user' => new Map<String, Object>{ 'id' => candidate.Id },
                'channel' => new Map<String, Object>{ 'id' => channel.get('id') }
            }
        );
        System.assertEquals('done', String.valueOf(selectedAgain.get('status')));
        System.assertEquals(false, selectedAgain.get('created'));

        Map<String, Object> autoSelectedAgain = SimpleSetupController.runStep(
            'channel', new Map<String, Object>{ 'user' => new Map<String, Object>{ 'id' => candidate.Id } }
        );
        System.assertEquals('done', String.valueOf(autoSelectedAgain.get('status')));
        System.assertEquals(false, autoSelectedAgain.get('created'));
    }

    @IsTest
    static void ecaFailsWhenPackagedAppMissing() {
        grantAdmin();
        SimpleSetupEcaStep.forceEcaExists = false;
        Test.startTest();
        Map<String, Object> result = SimpleSetupController.runStep(
            'eca', new Map<String, Object>()
        );
        Test.stopTest();
        System.assertEquals('failed', String.valueOf(result.get('status')));
        System.assert(String.valueOf(result.get('message')).contains('packaged execution client is missing'));
    }

    @IsTest
    static void ecaRequiresSelectedIntegrationUser() {
        grantAdmin();
        SimpleSetupEcaStep.forceEcaExists = true;
        SimpleSetupEcaStep.forcePreAuthExists = false;
        Test.startTest();
        Map<String, Object> result = SimpleSetupController.runStep(
            'eca', new Map<String, Object>()
        );
        Test.stopTest();
        System.assertEquals('failed', String.valueOf(result.get('status')));
        System.assert(String.valueOf(result.get('message')).contains('integration user'));
    }

    @IsTest
    static void ecaDoesNotTreatPermissionSetExistenceAsPolicyProof() {
        grantAdmin();
        SimpleSetupEcaStep.forceEcaExists = true;
        SimpleSetupEcaStep.forcePreAuthExists = true;
        Test.startTest();
        Map<String, Object> result = SimpleSetupController.runStep(
            'eca', new Map<String, Object>()
        );
        Test.stopTest();
        System.assertEquals('failed', String.valueOf(result.get('status')));
        System.assert(String.valueOf(result.get('message')).contains('integration user'));
    }

    @IsTest
    static void finalizeRegisterRequiresChannelAndUser() {
        grantAdmin();
        Map<String, Object> missingBoth = SimpleSetupController.runStep(
            'finalize-register', new Map<String, Object>()
        );
        System.assertEquals('failed', String.valueOf(missingBoth.get('status')));
        Map<String, Object> missingUser = SimpleSetupController.runStep(
            'finalize-register',
            new Map<String, Object>{ 'channel' => new Map<String, Object>{ 'id' => '0Mj000000000000AAA' } }
        );
        System.assertEquals('failed', String.valueOf(missingUser.get('status')));
        System.assert(String.valueOf(missingUser.get('message')).contains('integration user'));
    }

    @IsTest
    static void userStepHonorsSelectedUser() {
        grantAdmin();
        createStandardUser('selA');
        createStandardUser('selB');
        List<Map<String, Object>> candidates =
            TubotSetupWizardController.getIntegrationCandidates();
        System.assert(
            candidates.size() >= 2,
            'Need at least two candidates to prove the selection wins over auto-select.'
        );
        String requestedId = String.valueOf(candidates[candidates.size() - 1].get('id'));
        Test.startTest();
        Map<String, Object> result = SimpleSetupController.runStep(
            'user',
            new Map<String, Object>{
                'user' => new Map<String, Object>{ 'id' => requestedId }
            }
        );
        Test.stopTest();
        System.assertEquals('done', String.valueOf(result.get('status')));
        Map<String, Object> user = (Map<String, Object>) result.get('user');
        System.assertEquals(requestedId, String.valueOf(user.get('id')));
        PermissionSet apiPs = [
            SELECT Id FROM PermissionSet WHERE Name = 'Tubot_Salesforce_API_Read' LIMIT 1
        ];
        Integer assignments = [
            SELECT COUNT() FROM PermissionSetAssignment
            WHERE AssigneeId = :requestedId AND PermissionSetId = :apiPs.Id
        ];
        System.assertEquals(1, assignments);
    }

    @IsTest
    static void userStepRejectsStaleSelection() {
        grantAdmin();
        // Stale selection: a real inserted user's ID with one body character
        // flipped, so the format is valid but no candidate can match it.
        String seedId = String.valueOf(createStandardUser('stale').Id);
        String staleId = seedId.substring(0, 5) + 'X' + seedId.substring(6);
        Test.startTest();
        Map<String, Object> result = SimpleSetupController.runStep(
            'user',
            new Map<String, Object>{
                'user' => new Map<String, Object>{ 'id' => staleId }
            }
        );
        Test.stopTest();
        System.assertEquals('failed', String.valueOf(result.get('status')));
        System.assert(String.valueOf(result.get('message')).contains('no longer available'));
    }

    @IsTest
    static void channelStepRejectsStaleSelection() {
        grantAdmin();
        User candidate = createStandardUser('selC');
        Test.startTest();
        Map<String, Object> result = SimpleSetupController.runStep(
            'channel',
            new Map<String, Object>{
                'user' => new Map<String, Object>{ 'id' => candidate.Id },
                'channel' => new Map<String, Object>{ 'id' => '0Mj000000000000AAA' }
            }
        );
        Test.stopTest();
        System.assertEquals('failed', String.valueOf(result.get('status')));
        System.assert(String.valueOf(result.get('message')).contains('no longer available'));
    }

    @IsTest
    static void finalizeStepsGateOnPanelConnection() {
        // Panel is never connected in test context (org settings invisible),
        // so both halves of the split finalize step must fail at the gate.
        grantAdmin();
        Map<String, Object> input = new Map<String, Object>{
            'channel' => new Map<String, Object>{ 'id' => '0Mj000000000000AAA' },
            'user' => new Map<String, Object>{ 'id' => UserInfo.getUserId() }
        };
        Map<String, Object> prepared = SimpleSetupController.runStep('finalize', input);
        System.assertEquals('failed', String.valueOf(prepared.get('status')));
        System.assert(String.valueOf(prepared.get('message')).contains('Panel is not connected'));
        Map<String, Object> registered = SimpleSetupController.runStep('finalize-register', input);
        System.assertEquals('failed', String.valueOf(registered.get('status')));
        System.assert(String.valueOf(registered.get('message')).contains('Panel is not connected'));
    }
}
