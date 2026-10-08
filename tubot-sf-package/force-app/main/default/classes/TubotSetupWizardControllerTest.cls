@IsTest
private class TubotSetupWizardControllerTest {

    private static User setupAdminAccess() {
        // FeatureManagement ignores permission grants in test context, so the
        // authorized-path tests below simulate the settings-admin grant here.
        PanelAuthSupportService.managePermissionTestOverride = true;
        User thisUser = [SELECT Id, Username FROM User WHERE Id = :UserInfo.getUserId()];

        System.runAs(thisUser) {
            PanelTestPermissionHelper.assignPermissionSet(thisUser.Id, 'Panel_Settings_Admin_Access');
        }

        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        if (config == null || config.Id == null) {
            config = new MCP_Config__c(SetupOwnerId = UserInfo.getOrganizationId());
        }
        config.Panel_Base_URL__c = PanelAuthSupportService.DEFAULT_PANEL_URL;
        config.Panel_Client_Id__c = 'pnl_client_salesforce_mcp';
        config.Panel_User_Email__c = 'admin@example.com';
        config.Panel_User_Role__c = 'admin';
        config.Panel_Team_Id__c = 'team_mock_wizard_123';
        config.Panel_Team_Name__c = 'Wizard Mock Team';
        config.Panel_Permissions__c = 'access_dashboard,edit_salesforce_settings';
        Database.upsert(config, AccessLevel.SYSTEM_MODE);

        return thisUser;
    }

    @IsTest
    static void testGetSetupHealthCheck() {
        User adminUser = setupAdminAccess();

        System.runAs(adminUser) {
            Test.startTest();
            Map<String, Object> health = TubotSetupWizardController.getSetupHealthCheck();
            Test.stopTest();

            System.assertNotEquals(null, health, 'Health check map should not be null.');
            System.assertEquals(true, health.get('isPanelConnected'), 'Panel should be connected based on config.');
            System.assertEquals('Wizard Mock Team', health.get('panelTeamName'), 'Team name should match config.');
            System.assertNotEquals(null, health.get('hasApiReadPermissionSet'), 'hasApiReadPermissionSet should be reported.');
            System.assertNotEquals(null, health.get('totalIntegrationLicenses'), 'totalIntegrationLicenses should be reported.');
        }
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
    static void testGetEcaSetupGuidance() {
        User adminUser = setupAdminAccess();

        System.runAs(adminUser) {
            Test.startTest();
            Map<String, Object> guidance = TubotSetupWizardController.getEcaSetupGuidance();
            Test.stopTest();

            System.assertNotEquals(null, guidance, 'Guidance should not be null.');
            System.assertEquals('Tubot_Channel_API', guidance.get('recommendedAppName'));
            System.assert(((String) guidance.get('requiredScopes')).contains('Api'));
            System.assert(((String) guidance.get('setupUrl')).contains('ExternalClientApps'));
            System.assert(((String) guidance.get('policiesCli')).contains('setup-eca-policies.mjs'));
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
                TubotSetupWizardController.getSetupHealthCheck();
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
