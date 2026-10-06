@IsTest
private class PanelSelfOrgResponseParserTest {
    @IsTest
    static void parseAcceptsObjectsAndRejectsOtherBodies() {
        Map<String, Object> payload = PanelSelfOrgResponseParser.parse('{"connected":true}');
        System.assertEquals(true, payload.get('connected'));
        System.assertEquals(0, PanelSelfOrgResponseParser.parse('[]').size());
        System.assertEquals(0, PanelSelfOrgResponseParser.parse('not-json').size());
        System.assertEquals(0, PanelSelfOrgResponseParser.parse(null).size());
    }

    @IsTest
    static void safeErrorUsesOnlyBoundedUpstreamText() {
        String fallback = 'Use the safe fallback.';
        System.assertEquals(fallback, PanelSelfOrgResponseParser.safeError(null, fallback));
        System.assertEquals('Try again.', PanelSelfOrgResponseParser.safeError(
            new Map<String, Object>{ 'error_description' => 'Try again.' }, fallback
        ));

        String tooLong = '';
        for (Integer i = 0; i < 301; i++) { tooLong += 'x'; }
        System.assertEquals(fallback, PanelSelfOrgResponseParser.safeError(
            new Map<String, Object>{ 'error_description' => tooLong }, fallback
        ));
    }

    @IsTest
    static void authorizationUrlMustBeHttpsSalesforceAuthorizeEndpoint() {
        System.assertEquals(true, PanelSelfOrgResponseParser.isSalesforceAuthorizationUrl(
            'https://tenant.my.salesforce.com/services/oauth2/authorize'
        ));
        System.assertEquals(true, PanelSelfOrgResponseParser.isSalesforceAuthorizationUrl(
            'https://login.salesforce.mil/services/oauth2/authorize'
        ));
        System.assertEquals(false, PanelSelfOrgResponseParser.isSalesforceAuthorizationUrl(
            'http://tenant.my.salesforce.com/services/oauth2/authorize'
        ));
        System.assertEquals(false, PanelSelfOrgResponseParser.isSalesforceAuthorizationUrl(
            'https://tenant.my.salesforce.com.attacker.invalid/services/oauth2/authorize'
        ));
        System.assertEquals(false, PanelSelfOrgResponseParser.isSalesforceAuthorizationUrl(
            'https://user@tenant.my.salesforce.com/services/oauth2/authorize'
        ));
        System.assertEquals(false, PanelSelfOrgResponseParser.isSalesforceAuthorizationUrl(
            'https://tenant.my.salesforce.com/services/oauth2/token'
        ));
        System.assertEquals(false, PanelSelfOrgResponseParser.isSalesforceAuthorizationUrl('invalid-url'));
    }
}
