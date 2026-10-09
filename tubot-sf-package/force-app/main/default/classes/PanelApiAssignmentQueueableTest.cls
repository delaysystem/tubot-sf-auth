@IsTest
private class PanelApiAssignmentQueueableTest {

    @IsTest
    static void testAssignTargetsOwnNamespaceCopy() {
        // The async ASSIGN must insert this code's own namespace copy: connect
        // checks the own-namespace copy, so any other pick deadlocks setup
        // with "still being prepared".
        PanelAuthSupportService.managePermissionTestOverride = true;
        // Fresh packaging build orgs grant nobody FLS on the channel object,
        // so the runAs insert below needs the settings-admin grant first
        // (mirrors ChannelServiceTest.setupAdminAccess; same mixed-DML
        // segment as the User insert since both are setup objects).
        User thisUser = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        System.runAs(thisUser) {
            PanelTestPermissionHelper.assignPermissionSet(thisUser.Id, 'Panel_Settings_Admin_Access');
        }
        Profile stdProfile = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
        User target = new User(
            Alias = 'qnsusr', Email = 'queueable-ns-user@example.com',
            EmailEncodingKey = 'UTF-8', LastName = 'QueueableNsUser',
            LanguageLocaleKey = 'en_US', LocaleSidKey = 'en_US',
            ProfileId = stdProfile.Id, TimeZoneSidKey = 'America/Los_Angeles',
            Username = 'queueable-ns-user-' + Crypto.getRandomInteger() + '@example.com'
        );
        insert target;
        // runAs separates the non-setup row insert from the setup-object
        // assignment insert below (mixed-DML rule).
        System.runAs(thisUser) {
            insert new Tubot_API_Channel__c(
                Connection_Key__c = '0Mj000000000000AAA:' + target.Id,
                Channel_Id__c = '0Mj000000000000AAA',
                Integration_User_Id__c = target.Id,
                Team_Id__c = 'team_test_queueable',
                Assignment_Owned__c = true
            );
        }
        // Invoke execute() directly: the async flush would also run the job's
        // chained record-update enqueue, which exceeds test chain depth. The
        // reconciliation + insert under test runs identically inline. A second
        // runAs keeps this setup-DML segment pure (mixed-DML rule) while
        // carrying the settings-admin FLS the USER_MODE channel query needs
        // in fresh packaging build orgs.
        System.runAs(thisUser) {
            new PanelApiAssignmentQueueable(
                new List<PanelApiAssignmentQueueable.Request>{
                    new PanelApiAssignmentQueueable.Request(target.Id, 'ASSIGN', null)
                }
            ).execute(null);
        }
        String here = PanelApiAssignmentQueueable.class.getName();
        String wantNs = here.contains('.') ? here.substringBefore('.') : null;
        List<PermissionSetAssignment> assignments = [
            SELECT PermissionSet.NamespacePrefix FROM PermissionSetAssignment
            WHERE AssigneeId = :target.Id
            AND PermissionSet.Name = :PanelSalesforceChannelSupportService.PERMISSION_SET
        ];
        System.assertEquals(1, assignments.size(), 'Exactly one API-read copy should be assigned.');
        System.assertEquals(
            wantNs, assignments[0].PermissionSet.NamespacePrefix,
            'Assignment must target this code\'s own namespace copy.'
        );
    }
}
