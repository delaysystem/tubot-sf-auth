@isTest
private class PanelAuthSupportServiceTest {

    private class DeniedCredentialMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            throw new CalloutException(
                'We couldn\'t access the credential(s). You might not have the required permissions.'
            );
        }
    }

    @isTest
    static void testDefaultPanelUrlIsCanonicalDomain() {
        System.assertEquals(
            'https://panel.tubot.lat',
            PanelAuthSupportService.DEFAULT_PANEL_URL,
            'Packaged Panel default must use the canonical panel.tubot.lat domain.'
        );
    }

    @isTest
    static void testSettingsAccessRequiresDirectPackagePermissionSetAssignment() {
        PanelAuthSupportService.managePermissionTestOverride = null;
        User assignedUser = [SELECT Id, ProfileId FROM User WHERE Id = :UserInfo.getUserId()];
        PanelTestPermissionHelper.assignPermissionSet(assignedUser.Id, 'Panel_Settings_Admin_Access');
        System.assertEquals(true, PanelAuthSupportService.checkManageTubotPermission());
        System.assertEquals(true, PanelAuthController.hasPanelSettingsAccess());

        String uniqueSuffix = UserInfo.getOrganizationId() + '-' + String.valueOf(DateTime.now().getTime());
        User unassignedUser = new User(
            Alias = 'nopanel',
            Email = 'panel-access-' + uniqueSuffix + '@example.invalid',
            EmailEncodingKey = 'UTF-8',
            LastName = 'No Panel Access',
            LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US',
            ProfileId = assignedUser.ProfileId,
            TimeZoneSidKey = 'America/Los_Angeles',
            Username = 'panel-access-' + uniqueSuffix + '@example.invalid'
        );
        insert unassignedUser;

        System.runAs(unassignedUser) {
            PanelAuthSupportService.managePermissionTestOverride = null;
            System.assertEquals(false, PanelAuthSupportService.checkManageTubotPermission());
            System.assertEquals(false, PanelAuthController.hasPanelSettingsAccess());
            Boolean rejected = false;
            try {
                PanelAuthSupportService.requireSettingsAdmin();
            } catch (AuraHandledException expected) {
                rejected = true;
            }
            System.assertEquals(true, rejected, 'A user without the package permission set must be rejected.');
        }
    }

    @isTest
    static void testCredentialAccessFailurePointsAtRepair() {
        PanelAuthSupportService.managePermissionTestOverride = true;
        Test.setMock(HttpCalloutMock.class, new DeniedCredentialMock());
        Boolean guided = false;
        try {
            Test.startTest();
            PanelAuthSupportService.executePanelCallout('/api/v1/subscription', 'GET', null);
            Test.stopTest();
        } catch (CalloutException expected) {
            guided = expected.getMessage().contains('Repair Panel credential access');
        }
        System.assertEquals(true, guided, 'Denied credential access must name the in-app repair.');
    }
}
