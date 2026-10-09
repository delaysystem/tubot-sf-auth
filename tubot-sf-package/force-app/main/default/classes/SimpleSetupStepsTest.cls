@IsTest
private class SimpleSetupStepsTest {
    @IsTest
    static void ecaGuidanceNamesPackagedAppAndPoliciesCommand() {
        Map<String, Object> guidance = SimpleSetupEcaStep.getPoliciesGuidance();
        System.assertEquals('Tubot_Channel_API', String.valueOf(guidance.get('appName')));
        System.assert(
            String.valueOf(guidance.get('cliCommand')).contains('setup-eca-policies.mjs'),
            String.valueOf(guidance.get('cliCommand'))
        );
        System.assert(
            String.valueOf(guidance.get('setupUrl')).contains('/lightning/setup/ExternalClientApps/home')
        );
    }

    @IsTest
    static void ecaChecksHonorTestOverrides() {
        SimpleSetupEcaStep.forceEcaExists = true;
        System.assertEquals(true, SimpleSetupEcaStep.ecaExists());
        SimpleSetupEcaStep.forceEcaExists = false;
        System.assertEquals(false, SimpleSetupEcaStep.ecaExists());
        SimpleSetupEcaStep.forcePreAuthExists = true;
        System.assertEquals(true, SimpleSetupEcaStep.preAuthExists());
        SimpleSetupEcaStep.forcePreAuthExists = false;
        System.assertEquals(false, SimpleSetupEcaStep.preAuthExists());
    }

    @IsTest
    static void ecaChecksReadLiveOrgMetadataAndRejectInvalidInputs() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        SimpleSetupEcaStep.forceEcaExists = null;
        SimpleSetupEcaStep.forcePreAuthExists = null;

        Integer ecaCount = [
            SELECT COUNT() FROM ExternalClientApplication
            WHERE DeveloperName = :SimpleSetupEcaStep.APP_NAME WITH USER_MODE
        ];
        System.assertEquals(ecaCount > 0, SimpleSetupEcaStep.ecaExists());

        String className = SimpleSetupEcaStep.class.getName();
        String namespace = className.contains('.') ? className.substringBefore('.') : null;
        String qualifiedName = String.isBlank(namespace)
            ? SimpleSetupEcaStep.PREAUTH_PERMISSION_SET
            : namespace + '__' + SimpleSetupEcaStep.PREAUTH_PERMISSION_SET;
        Boolean expectedPreAuth = false;
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
            expectedPreAuth = expectedPreAuth || belongsToPackage;
            if (belongsToPackage) {
                preAuthIds.add(candidate.Id);
            }
        }
        System.assertEquals(expectedPreAuth, SimpleSetupEcaStep.preAuthExists());

        Boolean rejectedInvalidUser = false;
        try {
            SimpleSetupEcaStep.prepare(null);
        } catch (AuraHandledException expected) {
            rejectedInvalidUser = true;
        }
        System.assertEquals(true, rejectedInvalidUser);

        Boolean rejectedInvalidState = false;
        try {
            SimpleSetupEcaStep.outcome('invalid-state');
        } catch (AuraHandledException expected) {
            rejectedInvalidState = true;
        }
        System.assertEquals(true, rejectedInvalidState);

        Integer liveAssignmentCount = preAuthIds.isEmpty() ? 0 : [
            SELECT COUNT() FROM PermissionSetAssignment
            WHERE AssigneeId = :UserInfo.getUserId() AND PermissionSetId IN :preAuthIds
            WITH USER_MODE
        ];
        Boolean membershipIsAccepted = false;
        Map<String, Object> membership;
        try {
            membership = SimpleSetupEcaStep.checkMembership(UserInfo.getUserId());
            membershipIsAccepted = String.valueOf(membership.get('status')) == 'done';
        } catch (AuraHandledException expected) {
            membershipIsAccepted = false;
        }
        System.assertEquals(liveAssignmentCount == 1, membershipIsAccepted);
    }

    @IsTest(SeeAllData=true)
    static void ecaPrepareAssignsTheCurrentActiveUser() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        User activeUser = [
            SELECT Id, IsActive FROM User WHERE Id = :UserInfo.getUserId() WITH USER_MODE LIMIT 1
        ];
        System.assertEquals(true, activeUser.IsActive);

        Map<String, Object> result = SimpleSetupEcaStep.prepare(activeUser.Id);

        System.assertEquals('popup-required', String.valueOf(result.get('status')));
        String className = SimpleSetupEcaStep.class.getName();
        String namespace = className.contains('.') ? className.substringBefore('.') : null;
        String qualifiedName = String.isBlank(namespace)
            ? SimpleSetupEcaStep.PREAUTH_PERMISSION_SET
            : namespace + '__' + SimpleSetupEcaStep.PREAUTH_PERMISSION_SET;
        Set<Id> packagePermissionSetIds = new Set<Id>();
        for (PermissionSet candidate : [
            SELECT Id, NamespacePrefix
            FROM PermissionSet
            WHERE Name = :SimpleSetupEcaStep.PREAUTH_PERMISSION_SET OR Name = :qualifiedName
            WITH USER_MODE
        ]) {
            Boolean belongsToPackage = String.isBlank(namespace)
                ? String.isBlank(candidate.NamespacePrefix)
                : candidate.NamespacePrefix == namespace;
            if (belongsToPackage) {
                packagePermissionSetIds.add(candidate.Id);
            }
        }
        System.assert(!packagePermissionSetIds.isEmpty());
        System.assertEquals(1, [
            SELECT COUNT() FROM PermissionSetAssignment
            WHERE AssigneeId = :activeUser.Id AND PermissionSetId IN :packagePermissionSetIds
            WITH USER_MODE
        ]);
    }

    @IsTest
    static void finalizeRequiresPanelConnection() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        Test.startTest();
        Map<String, Object> prepared = SimpleSetupController.runStep(
            'finalize',
            new Map<String, Object>{
                'channel' => new Map<String, Object>{ 'id' => '0Mj000000000000AAA' },
                'user' => new Map<String, Object>{ 'id' => UserInfo.getUserId() }
            }
        );
        Test.stopTest();
        System.assertEquals('failed', String.valueOf(prepared.get('status')));
        System.assert(String.valueOf(prepared.get('message')).contains('Panel is not connected'));
    }
}
