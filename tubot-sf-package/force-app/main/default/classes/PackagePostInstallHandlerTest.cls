@isTest
private class PackagePostInstallHandlerTest {

    @isTest
    static void testPackagePostInstallHandlerExecution() {
        Test.startTest();
        PackagePostInstallHandler handler = new PackagePostInstallHandler();
        try {
            Test.testInstall(handler, null);
        } catch (TypeException te) {
            PackagePostInstallHandler.initializeOrgDefaults();
        }
        Test.stopTest();

        Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
        System.assertNotEquals(null, config, 'Messaging_Config__c org defaults should not be null after install');
        System.assertEquals('ALL', config.Selected_Messaging_Channel_Id__c, 'Default channel filter should be ALL');
        System.assertEquals('agent', config.Agent_Keyword__c, 'Default agent keyword should be agent');
        System.assertEquals(false, config.Use_Flow_Routing__c, 'Flow routing stays off because Flow metadata is excluded from the package.');
    }

    @isTest
    static void testInitializeOrgDefaultsDirectCall() {
        Test.startTest();
        PackagePostInstallHandler.initializeOrgDefaults();
        PackagePostInstallHandler.assignAdminPermissionSet(UserInfo.getUserId());
        Test.stopTest();

        Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
        System.assertNotEquals(null, config, 'Config should be initialized');

        List<PermissionSet> psList = [SELECT Id FROM PermissionSet WHERE Name = 'Panel_Settings_Admin_Access' LIMIT 1];
        if (!psList.isEmpty()) {
            List<PermissionSetAssignment> psa = [
                SELECT Id FROM PermissionSetAssignment 
                WHERE AssigneeId = :UserInfo.getUserId() AND PermissionSetId = :psList[0].Id
            ];
            System.assertEquals(1, psa.size(), 'Panel_Settings_Admin_Access should be assigned');
        }
    }
}
