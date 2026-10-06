@isTest
private class PanelAuthSupportServiceTest {

    @isTest
    static void testDefaultPanelUrlIsCanonicalDomain() {
        System.assertEquals(
            'https://panel.tubot.lat',
            PanelAuthSupportService.DEFAULT_PANEL_URL,
            'Packaged Panel default must use the canonical panel.tubot.lat domain.'
        );
    }
}
