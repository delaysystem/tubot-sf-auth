/** Apex actions for listing and configuring Embedded Service deployments and LWC headers. */
public with sharing class EmbeddedDeploymentAdminController {
    @AuraEnabled
    public static List<Map<String, Object>> getEmbeddedServiceDeployments(String sessionTokenOverride) {
        throw disabledFeature();
    }

    @AuraEnabled
    public static Map<String, Object> getDeploymentCustomComponents(String deploymentId, String sessionTokenOverride) {
        throw disabledFeature();
    }

    @AuraEnabled
    public static List<Map<String, Object>> getAvailableHeaderComponents(String sessionTokenOverride) {
        throw disabledFeature();
    }

    @AuraEnabled
    public static Map<String, Object> injectHeaderCustomLogic(String bundleNameOrId, String sessionTokenOverride) {
        throw disabledFeature();
    }

    @AuraEnabled
    public static Map<String, Object> acceptDeploymentSetup(String requestJson) {
        throw disabledFeature();
    }

    private static AuraHandledException disabledFeature() {
        TubotPackageFeatureGate.reject('Embedded Messaging deployment setup');
        return new AuraHandledException('Embedded Messaging deployment setup is not included in this package.');
    }
}
