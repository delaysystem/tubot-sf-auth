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
