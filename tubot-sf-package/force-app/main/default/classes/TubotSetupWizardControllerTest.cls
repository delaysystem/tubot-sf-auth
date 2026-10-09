@IsTest
private class TubotSetupWizardControllerTest {

    private static User setupAdminAccess() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        return [SELECT Id, Username FROM User WHERE Id = :UserInfo.getUserId()];
    }

    @IsTest
    static void testGetIntegrationCandidates() {
        User adminUser = setupAdminAccess();

        System.runAs(adminUser) {
            Test.startTest();
            List<Map<String, Object>> candidates = TubotSetupWizardController.getIntegrationCandidates();
            Test.stopTest();

            System.assertNotEquals(null, candidates, 'Candidates list should not be null.');
            System.assert(!candidates.isEmpty(), 'At least one candidate user should be returned.');
        }
    }

    @IsTest
    static void testAssignApiPermissionSet() {
        User adminUser = setupAdminAccess();

        System.runAs(adminUser) {
            Test.startTest();
            Map<String, Object> result = TubotSetupWizardController.assignApiPermissionSet(adminUser.Username);
            Test.stopTest();

            System.assertEquals(true, result.get('success'), 'Assignment should succeed.');
            System.assertEquals(true, result.get('isAssigned'), 'isAssigned should be true.');

            // Verify idempotency on second call
            Map<String, Object> repeatResult = TubotSetupWizardController.assignApiPermissionSet(String.valueOf(adminUser.Id));
            System.assertEquals(true, repeatResult.get('success'), 'Repeat assignment should be idempotent.');
        }
    }

    @IsTest
    static void testAssignApiPermissionSetInvalidUser() {
        User adminUser = setupAdminAccess();

        System.runAs(adminUser) {
            Boolean exceptionThrown = false;
            try {
                TubotSetupWizardController.assignApiPermissionSet('invalid_user_id_12345');
            } catch (AuraHandledException e) {
                exceptionThrown = true;
            }
            System.assertEquals(true, exceptionThrown, 'AuraHandledException should be thrown for invalid user.');
        }
    }

    @IsTest
    static void testNonAdminAccessDenied() {
        Profile stdProfile = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
        User nonAdmin = new User(
            FirstName = 'Standard',
            LastName = 'TestUser',
            Email = 'standardtestuser@example.com',
            Username = 'standardtestuser_' + DateTime.now().getTime() + '@example.com',
            Alias = 'stdusr',
            TimeZoneSidKey = 'America/New_York',
            LocaleSidKey = 'en_US',
            EmailEncodingKey = 'UTF-8',
            ProfileId = stdProfile.Id,
            LanguageLocaleKey = 'en_US'
        );
        insert nonAdmin;

        System.runAs(nonAdmin) {
            Boolean exceptionThrown = false;
            try {
                TubotSetupWizardController.getIntegrationCandidates();
            } catch (AuraHandledException e) {
                exceptionThrown = true;
            }
            System.assertEquals(true, exceptionThrown, 'Non-admin user should be denied access.');
        }
    }

    @IsTest
    static void testAssignApiPermissionSetUsesOwnNamespaceCopy() {
        // Dev orgs can hold both the packaged and unpackaged permission set.
        // Assignment must target this code's own namespace copy: connect and
        // prepare check the own-namespace copy, so any other pick deadlocks
        // setup with "still being prepared".
        User adminUser = setupAdminAccess();
        Profile stdProfile = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
        User target = new User(
            Alias = 'nsusr', Email = 'ns-user@example.com',
            EmailEncodingKey = 'UTF-8', LastName = 'NsUser',
            LanguageLocaleKey = 'en_US', LocaleSidKey = 'en_US',
            ProfileId = stdProfile.Id, TimeZoneSidKey = 'America/Los_Angeles',
            Username = 'ns-user-' + Crypto.getRandomInteger() + '@example.com'
        );
        insert target;
        System.runAs(adminUser) {
            Test.startTest();
            Map<String, Object> result =
                TubotSetupWizardController.assignApiPermissionSet(target.Id);
            Test.stopTest();
            System.assertEquals(true, result.get('success'));
        }
        String here = TubotSetupWizardController.class.getName();
        String wantNs = here.contains('.') ? here.substringBefore('.') : null;
        List<PermissionSetAssignment> assignments = [
            SELECT PermissionSet.NamespacePrefix FROM PermissionSetAssignment
            WHERE AssigneeId = :target.Id
            AND PermissionSet.Name = 'Tubot_Salesforce_API_Read'
        ];
        System.assertEquals(1, assignments.size(), 'Exactly one API-read copy should be assigned.');
        System.assertEquals(
            wantNs, assignments[0].PermissionSet.NamespacePrefix,
            'Assignment must target this code\'s own namespace copy.'
        );
    }
}
