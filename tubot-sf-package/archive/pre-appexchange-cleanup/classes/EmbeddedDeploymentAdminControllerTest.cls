@IsTest
private class EmbeddedDeploymentAdminControllerTest {
    @IsTest
    static void excludedEmbeddedDeploymentActionsFailClosed() {
        Integer rejected = 0;
        try { EmbeddedDeploymentAdminController.getEmbeddedServiceDeployments(null); }
        catch (AuraHandledException expected) { rejected++; }
        try { EmbeddedDeploymentAdminController.getDeploymentCustomComponents('deployment-id', null); }
        catch (AuraHandledException expected) { rejected++; }
        try { EmbeddedDeploymentAdminController.getAvailableHeaderComponents(null); }
        catch (AuraHandledException expected) { rejected++; }
        try { EmbeddedDeploymentAdminController.injectHeaderCustomLogic('bundle-name', null); }
        catch (AuraHandledException expected) { rejected++; }
        try { EmbeddedDeploymentAdminController.acceptDeploymentSetup('{}'); }
        catch (AuraHandledException expected) { rejected++; }

        System.assertEquals(5, rejected, 'Every excluded Embedded Messaging action must reject execution.');
    }
}
