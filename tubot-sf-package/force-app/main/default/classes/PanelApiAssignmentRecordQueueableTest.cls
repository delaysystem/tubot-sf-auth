@IsTest
private class PanelApiAssignmentRecordQueueableTest {
    private static User createTargetUser(String marker) {
        Profile standardProfile = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
        User target = new User(
            Alias = 'rc' + marker, Email = 'record-q-' + marker + '@example.com',
            EmailEncodingKey = 'UTF-8', LastName = 'RecordQ' + marker,
            LanguageLocaleKey = 'en_US', LocaleSidKey = 'en_US',
            ProfileId = standardProfile.Id, TimeZoneSidKey = 'America/Los_Angeles',
            Username = 'record-q-' + marker + '-' + Crypto.getRandomInteger() + '@example.com'
        );
        insert target;
        return target;
    }

    private static Id apiPermissionSetId() {
        Id psId = PanelTestPermissionHelper.resolvePermissionSetId(
            PanelSalesforceChannelSupportService.PERMISSION_SET
        );
        System.assertNotEquals(null, psId, 'The API permission set must exist.');
        return psId;
    }

    // Grants the running user channel FLS (fresh packaging build orgs grant
    // nobody) and returns them for runAs segments. Setup DML only, so it
    // shares a mixed-DML segment with User/assignment inserts.
    private static User grantSettingsAdmin() {
        User thisUser = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        PanelTestPermissionHelper.assignPermissionSet(thisUser.Id, 'Panel_Settings_Admin_Access');
        return thisUser;
    }

    private static PanelApiAssignmentQueueable.Request recordRequest(Id userId, Id assignmentId) {
        return new PanelApiAssignmentQueueable.Request(userId, 'RECORD', assignmentId);
    }

    @IsTest
    static void updatesChannelReferencesForUsersWithChannels() {
        User thisUser = grantSettingsAdmin();
        User target = createTargetUser('ra');
        PermissionSetAssignment grant = new PermissionSetAssignment(
            AssigneeId = target.Id, PermissionSetId = apiPermissionSetId()
        );
        insert grant;
        System.runAs(thisUser) {
            insert new Tubot_API_Channel__c(
                Connection_Key__c = '0Mj000000000000AAA:' + target.Id,
                Channel_Id__c = '0Mj000000000000AAA',
                Integration_User_Id__c = target.Id,
                Team_Id__c = 'team_test_record',
                Assignment_Owned__c = true
            );
        }
        System.runAs(thisUser) {
            new PanelApiAssignmentRecordQueueable(
                new List<PanelApiAssignmentQueueable.Request>{
                    recordRequest(target.Id, grant.Id)
                }
            ).execute(null);
        }
        // Read back under the granted runAs user: in packaging build orgs,
        // the default test context cannot resolve Assignment_Id__c even on
        // plain SOQL (proven empirically; the field ships fine in 1.2.0 and
        // the USER_MODE product query works under this same grant).
        System.runAs(thisUser) {
            Tubot_API_Channel__c row = [
                SELECT Assignment_Id__c FROM Tubot_API_Channel__c
                WHERE Integration_User_Id__c = :target.Id LIMIT 1
            ];
            System.assertEquals(String.valueOf(grant.Id), row.Assignment_Id__c);
        }
    }

    @IsTest
    static void deletesOrphanedAssignmentsWithoutChannels() {
        User thisUser = grantSettingsAdmin();
        User orphan = createTargetUser('rb');
        PermissionSetAssignment grant = new PermissionSetAssignment(
            AssigneeId = orphan.Id, PermissionSetId = apiPermissionSetId()
        );
        insert grant;
        System.runAs(thisUser) {
            new PanelApiAssignmentRecordQueueable(
                new List<PanelApiAssignmentQueueable.Request>{
                    recordRequest(orphan.Id, grant.Id)
                }
            ).execute(null);
        }
        System.assertEquals(
            0,
            [SELECT COUNT() FROM PermissionSetAssignment WHERE Id = :grant.Id]
        );
    }

    @IsTest
    static void mixedBatchUpdatesInlineAndChainsDeletes() {
        User thisUser = grantSettingsAdmin();
        User kept = createTargetUser('rc');
        User orphan = createTargetUser('rd');
        PermissionSetAssignment keptGrant = new PermissionSetAssignment(
            AssigneeId = kept.Id, PermissionSetId = apiPermissionSetId()
        );
        PermissionSetAssignment orphanGrant = new PermissionSetAssignment(
            AssigneeId = orphan.Id, PermissionSetId = apiPermissionSetId()
        );
        insert new List<PermissionSetAssignment>{ keptGrant, orphanGrant };
        System.runAs(thisUser) {
            insert new Tubot_API_Channel__c(
                Connection_Key__c = '0Mj000000000000AAA:' + kept.Id,
                Channel_Id__c = '0Mj000000000000AAA',
                Integration_User_Id__c = kept.Id,
                Team_Id__c = 'team_test_record',
                Assignment_Owned__c = true
            );
        }
        // Must not throw mixed-DML: the update applies inline while the
        // delete is chained to a follow-up job (never flushed here).
        System.runAs(thisUser) {
            new PanelApiAssignmentRecordQueueable(
                new List<PanelApiAssignmentQueueable.Request>{
                    recordRequest(kept.Id, keptGrant.Id),
                    recordRequest(orphan.Id, orphanGrant.Id)
                }
            ).execute(null);
        }
        System.runAs(thisUser) {
            Tubot_API_Channel__c row = [
                SELECT Assignment_Id__c FROM Tubot_API_Channel__c
                WHERE Integration_User_Id__c = :kept.Id LIMIT 1
            ];
            System.assertEquals(String.valueOf(keptGrant.Id), row.Assignment_Id__c);
        }
        System.assertEquals(
            1,
            [SELECT COUNT() FROM PermissionSetAssignment WHERE Id = :orphanGrant.Id],
            'The orphan delete chains to a follow-up job; nothing is flushed in tests.'
        );
        // Simulate the follow-up job the chain would run.
        System.runAs(thisUser) {
            new PanelApiAssignmentRecordQueueable(
                new List<PanelApiAssignmentQueueable.Request>{
                    recordRequest(orphan.Id, orphanGrant.Id)
                }
            ).execute(null);
        }
        System.assertEquals(
            0,
            [SELECT COUNT() FROM PermissionSetAssignment WHERE Id = :orphanGrant.Id]
        );
    }
}
