/**
 * @description Unit tests for OmniChannelSetupService verifying queue assembly,
 * user provisioning, presence status linking, permission set assignment, and idempotency.
 */
@IsTest
private class OmniChannelSetupServiceTest {

    @testSetup
    static void assignSettingsPermission() {
        User thisUser = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        String exactName = 'Panel_Settings_Admin_Access';
        String namespacedName = '%__Panel_Settings_Admin_Access';
        List<PermissionSet> settingsSets = [
            SELECT Id FROM PermissionSet
            WHERE Name = :exactName OR Name LIKE :namespacedName
            LIMIT 1
        ];
        System.assertEquals(1, settingsSets.size(), 'The package admin permission set must be present.');
        if (!settingsSets.isEmpty() && [
            SELECT COUNT() FROM PermissionSetAssignment
            WHERE AssigneeId = :thisUser.Id AND PermissionSetId = :settingsSets[0].Id
        ] == 0) {
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
        User resolvedDefault = OmniChannelSetupService.resolveTargetUser('default');
        System.assertEquals(curUser.Id, resolvedDefault.Id, 'Should resolve default user to current running user');

        User resolvedById = OmniChannelSetupService.resolveTargetUser(curUser.Id);
        System.assertEquals(curUser.Id, resolvedById.Id, 'Should resolve user by 15/18 char Id');

        User resolvedByUsername = OmniChannelSetupService.resolveTargetUser(curUser.Username);
        System.assertEquals(curUser.Id, resolvedByUsername.Id, 'Should resolve user by Username');

        List<User> multiResolved = OmniChannelSetupService.resolveTargetUsers(curUser.Username + ', default');
        System.assertEquals(1, multiResolved.size(), 'Deduplicated resolution should return single user');
        Test.stopTest();
    }

    @IsTest
    static void testResolveTargetUserInvalid() {
        Test.startTest();
        try {
            OmniChannelSetupService.resolveTargetUser('non_existent_user_987654@invalid.domain.com');
            System.assert(false, 'Expected IllegalArgumentException for unknown user identifier');
        } catch (IllegalArgumentException ex) {
            System.assert(ex.getMessage().contains('No active Salesforce user found'), 'Expected error message');
        }
        Test.stopTest();
    }

    @IsTest
    static void testSetupMessagingQueueAndIdempotency() {
        String devName = 'Test_Queue_' + String.valueOf(Crypto.getRandomInteger()).replace('-', '');
        if (devName.length() > 30) { devName = devName.substring(0, 30); }
        String label = 'Test Queue';

        Test.startTest();
        List<String> logs = new List<String>();
        Group q1 = OmniChannelSetupService.setupMessagingQueue(devName, label, logs);
        System.assertNotEquals(null, q1.Id, 'Queue should be created');

        // Run again to verify idempotency
        Group q2 = OmniChannelSetupService.setupMessagingQueue(devName, label, logs);
        System.assertEquals(q1.Id, q2.Id, 'Subsequent call should resolve existing queue without error');
        Test.stopTest();
    }

    @IsTest
    static void testProvisionAgentUserAndIdempotency() {
        String devName = 'Test_Q_Prov_' + String.valueOf(Crypto.getRandomInteger()).replace('-', '');
        if (devName.length() > 30) { devName = devName.substring(0, 30); }
        String label = 'Test Q Prov';

        Group q = OmniChannelSetupService.setupMessagingQueue(devName, label, new List<String>());
        User curUser = [SELECT Id, Username, Email, Name FROM User WHERE Id = :UserInfo.getUserId() LIMIT 1];

        String permSetName = 'Test_Perm_Set_' + String.valueOf(Crypto.getRandomInteger()).replace('-', '');
        if (permSetName.length() > 30) { permSetName = permSetName.substring(0, 30); }

        Test.startTest();
        OmniChannelAgentProvisioningService.ProvisionRequest request = new OmniChannelAgentProvisioningService.ProvisionRequest();
        request.queue = q;
        request.targetUsers = new List<User>{ curUser };
        request.presenceStatusDeveloperName = 'Available_Messaging';
        request.permissionSetDeveloperName = permSetName;
        request.permissionSetLabel = 'Test Perm Set';
        request.logs = new List<String>();
        OmniChannelSetupService.SetupResult res1 = OmniChannelSetupService.provisionAgentUser(request);
        System.assert(res1.success, 'Provisioning should succeed: ' + res1.message);

        // Run again to verify idempotency
        request.logs = new List<String>();
        OmniChannelSetupService.SetupResult res2 = OmniChannelSetupService.provisionAgentUser(request);
        System.assert(res2.success, 'Second run should succeed idempotently');
        Test.stopTest();
    }

    @IsTest
    static void testSetupOmniChannelEndToEnd() {
        Integer rejected = 0;
        try { OmniChannelSetupService.setupOmniChannelEndToEnd(new Map<String, String>()); }
        catch (AuraHandledException expected) { rejected++; }
        System.assertEquals(1, rejected, 'Disabled package entry points must reject execution.');
    }

    @IsTest
    static void testExecuteSetupScript() {
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        String suffix = String.valueOf(Crypto.getRandomInteger()).replace('-', '');
        String queueName = 'Test_Script_' + suffix;
        String permissionName = 'Test_PS_' + suffix;
        OmniChannelSetupService.SetupResult result;
        System.runAs(admin) {
        Test.startTest();
        result = OmniChannelSetupService.executeSetupScript(
            JSON.serialize(new Map<String, String>{
                'queueDevName' => queueName, 'queueLabel' => 'Script Queue',
                'userIdentifier' => 'default', 'permSetDevName' => permissionName,
                'permSetLabel' => 'Script Permission Set'
            })
        );
        Test.stopTest();
        }
        System.assertEquals(true, result.success, result.message);
        Group actualQueue = [SELECT Id FROM Group WHERE DeveloperName = :queueName];
        System.assertEquals(actualQueue.Id, result.queueId);
        System.assertEquals(1, [
            SELECT COUNT() FROM QueueSobject WHERE QueueId = :actualQueue.Id AND SobjectType = 'MessagingSession'
        ]);
    }
}
