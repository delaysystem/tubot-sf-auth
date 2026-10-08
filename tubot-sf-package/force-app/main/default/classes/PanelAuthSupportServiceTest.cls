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
