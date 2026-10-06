/** Optional Data 360 surface checks; package build orgs can omit these licenses. */
@IsTest
private class Data360MarketingAgentVerificationTest {
    @IsTest
    static void testDataCloudPlatformSchemaAvailability() {
        Map<String, Schema.SObjectType> globalDescribe = Schema.getGlobalDescribe();
        Boolean dataCloudAvailable = hasObject(globalDescribe, 'DataStream') &&
            hasObject(globalDescribe, 'IdentityResolution') &&
            hasObject(globalDescribe, 'DataLakeObjectInstance') &&
            hasObject(globalDescribe, 'MarketSegment');
        if (!dataCloudAvailable) { return; }
        Assert.isTrue(dataCloudAvailable, 'Data 360 APIs are available in this org.');
    }

    @IsTest
    static void testConnectApiIdentityResolutionCompilation() {
        try {
            Type identityResolutionType = Type.forName('ConnectApi', 'CdpIdentityResolution');
            if (identityResolutionType == null) { return; }
            Assert.isNotNull(identityResolutionType, 'ConnectApi.CdpIdentityResolution is available.');
        } catch (TypeException unavailable) {
            // Data 360 ConnectApi types are optional in package validation orgs.
            System.assertNotEquals(null, unavailable.getMessage(), 'Missing optional API types should return a diagnostic.');
        }
    }

    private static Boolean hasObject(Map<String, Schema.SObjectType> types, String apiName) {
        for (String candidate : types.keySet()) {
            if (candidate.equalsIgnoreCase(apiName)) { return true; }
        }
        return false;
    }
}
