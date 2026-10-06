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
    static void restoreAcceptsSessionFieldsAlreadyInPackageSchema() {
        List<String> logs = new List<String>();
        MessagingBackupRestoreToolingService.restoreSessionFields(new List<Object>{
            new Map<String, Object>{ 'apiName' => 'AI_Conversation_Summary__c' },
            new Map<String, Object>{ 'apiName' => '' }
        }, null, logs);

        System.assertEquals(true, logs[0].contains('All 2 backed-up MessagingSession fields are present.'));
    }
}
