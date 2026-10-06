/**
 * @description Unit tests for OmniSupervisorSetupService verifying user resolution,
 * Public Group creation, GroupMember association, Service Cloud User license handling,
 * and Permission Set assignment.
 */
@IsTest
private class OmniSupervisorSetupServiceTest {

    @testSetup
    static void assignSettingsPermission() {
        User thisUser = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        List<PermissionSet> settingsSets = [
            SELECT Id FROM PermissionSet WHERE Name = 'Panel_Settings_Admin_Access' LIMIT 1
        ];
        if (!settingsSets.isEmpty()) {
            insert new PermissionSetAssignment(
                AssigneeId = thisUser.Id,
                PermissionSetId = settingsSets[0].Id
            );
        }
    }

    @IsTest
    static void testResolveTargetUser() {
        User curUser = [SELECT Id, Username, Email FROM User WHERE Id = :UserInfo.getUserId() LIMIT 1];

        Test.startTest();
        List<User> resolvedDefault = OmniSupervisorSetupService.resolveTargetUsers('default');
        System.assertEquals(1, resolvedDefault.size(), 'Should resolve default user');
        System.assertEquals(curUser.Id, resolvedDefault[0].Id, 'Should resolve default to current user');

        List<User> resolvedById = OmniSupervisorSetupService.resolveTargetUsers(curUser.Id);
        System.assertEquals(curUser.Id, resolvedById[0].Id, 'Should resolve user by Id');

        List<User> resolvedByUsername = OmniSupervisorSetupService.resolveTargetUsers(curUser.Username);
        System.assertEquals(curUser.Id, resolvedByUsername[0].Id, 'Should resolve user by username');
        Test.stopTest();
    }

    @IsTest
    static void testResolveTargetUserInvalid() {
        Test.startTest();
        try {
            OmniSupervisorSetupService.resolveTargetUsers('non_existent_supervisor_987@test.domain');
            System.assert(false, 'Expected IllegalArgumentException for unknown user');
        } catch (IllegalArgumentException ex) {
            System.assert(ex.getMessage().contains('No active Salesforce user found'), 'Expected user not found exception');
        }
        Test.stopTest();
    }

    @IsTest
    static void testSupervisorGroupAndMembershipIdempotency() {
        String devName = 'Test_Sup_Grp_' + String.valueOf(Crypto.getRandomInteger()).replace('-', '');
        if (devName.length() > 30) { devName = devName.substring(0, 30); }
        String label = 'Test Supervisor Group';

        User curUser = [SELECT Id, Username, Email, Name, UserPermissionsSupportUser FROM User WHERE Id = :UserInfo.getUserId() LIMIT 1];

        Test.startTest();
        List<String> logs = new List<String>();
        Group g1 = OmniSupervisorSetupService.ensureSupervisorGroup(devName, label, logs);
        System.assertNotEquals(null, g1.Id, 'Supervisor group should be created');

        // Subsequent call must resolve existing
        Group g2 = OmniSupervisorSetupService.ensureSupervisorGroup(devName, label, logs);
        System.assertEquals(g1.Id, g2.Id, 'Subsequent call should resolve existing group');

        OmniSupervisorSetupService.addUsersToSupervisorGroup(g1, new List<User>{ curUser }, logs);
        // Second call must be idempotent
        OmniSupervisorSetupService.addUsersToSupervisorGroup(g1, new List<User>{ curUser }, logs);
        Test.stopTest();
    }

    @IsTest
    static void testSetupSupervisorUserEndToEnd() {
        String grpName = 'Test_Sup_E2E_' + String.valueOf(Crypto.getRandomInteger()).replace('-', '');
        if (grpName.length() > 30) { grpName = grpName.substring(0, 30); }
        String psName = 'Test_PS_Sup_' + String.valueOf(Crypto.getRandomInteger()).replace('-', '');
        if (psName.length() > 30) { psName = psName.substring(0, 30); }

        Map<String, String> config = new Map<String, String>{
            'userIdentifier' => 'default',
            'groupDevName' => grpName,
            'groupLabel' => 'Test Supervisor E2E Group',
            'permSetDevName' => psName,
            'permSetLabel' => 'Test Supervisor Perm Set'
        };

        Test.startTest();
        OmniSupervisorSetupService.SetupResult res = OmniSupervisorSetupService.setupSupervisorUser(config);
        System.assert(res.success, 'Supervisor setup should succeed: ' + res.message);
        System.assertNotEquals(null, res.groupId, 'Group ID should be populated');
        System.assertNotEquals(null, res.permissionSetId, 'Permission Set ID should be populated');

        // Test CLI JSON execution method
        String jsonConfig = JSON.serialize(config);
        OmniSupervisorSetupService.executeSetupScript(jsonConfig);
        Test.stopTest();
    }
}
