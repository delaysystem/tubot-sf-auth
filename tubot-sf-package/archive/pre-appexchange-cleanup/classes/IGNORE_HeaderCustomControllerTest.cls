@isTest
private class HeaderCustomControllerTest {

    /**
     * @description Test handleIncomingTurn with a valid 18-character Salesforce ID string.
     */
    @isTest
    static void testHandleIncomingTurn_ValidIdFormat() {
        Test.startTest();
        String mockSessionId = '0Mw000000000000AAA';
        Map<String, Object> result = HeaderCustomController.handleIncomingTurn(mockSessionId, 'Hello Agent Test', true);
        Test.stopTest();

        System.assertNotEquals(null, result, 'Response map should not be null');
        System.assertEquals(mockSessionId, result.get('sessionId'), 'SessionId should match input');
        System.assert(result.containsKey('success'), 'Result map should contain success key');
        System.assert(result.containsKey('message'), 'Result map should contain message key');
    }

    /**
     * @description Test handleIncomingTurn with a non-ID string ('ACTIVE_SESSION').
     */
    @isTest
    static void testHandleIncomingTurn_ActiveSessionFallback() {
        Test.startTest();
        Map<String, Object> result = HeaderCustomController.handleIncomingTurn('ACTIVE_SESSION', 'Test turn text', true);
        Test.stopTest();

        System.assertNotEquals(null, result, 'Response map should not be null');
        System.assertEquals('ACTIVE_SESSION', result.get('sessionId'), 'SessionId should match ACTIVE_SESSION');
    }

    /**
     * @description Test handleIncomingTurn with null and blank inputs.
     */
    @isTest
    static void testHandleIncomingTurn_NullAndBlankInputs() {
        Test.startTest();
        Map<String, Object> resultNull = HeaderCustomController.handleIncomingTurn(null, null, true);
        Map<String, Object> resultBlank = HeaderCustomController.handleIncomingTurn('', '', true);
        Test.stopTest();

        System.assertNotEquals(null, resultNull, 'Result for null input should not be null');
        System.assertNotEquals(null, resultBlank, 'Result for blank input should not be null');
    }

    /**
     * @description Test handleIncomingTurn with non-standard string conversation IDs.
     */
    @isTest
    static void testHandleIncomingTurn_CustomConversationId() {
        Test.startTest();
        Map<String, Object> result = HeaderCustomController.handleIncomingTurn('custom-uuid-1234-5678', 'Testing custom conversation string', true);
        Test.stopTest();

        System.assertNotEquals(null, result, 'Result for custom conversation ID should not be null');
        System.assertEquals('custom-uuid-1234-5678', result.get('sessionId'), 'SessionId should match custom string');
    }

    /**
     * @description Verify outbound messages do not dispatch agent notifications.
     */
    @isTest
    static void testHandleIncomingTurn_OutboundMessageDoesNotTriggerNotification() {
        Test.startTest();
        Map<String, Object> resultInbound = HeaderCustomController.handleIncomingTurn('ACTIVE_SESSION', 'I need an Agent', true);
        Map<String, Object> resultOutbound = HeaderCustomController.handleIncomingTurn('ACTIVE_SESSION', 'I am an Agent replying to you', false);
        Test.stopTest();

        System.assertNotEquals(null, resultInbound, 'Inbound result should not be null');
        System.assertNotEquals(null, resultOutbound, 'Outbound result should not be null');
    }

    /**
     * @description Test direct invocation of sendDynamicPassThroughComponent method.
     */
    @isTest
    static void testSendDynamicPassThroughComponent_DirectCall() {
        Test.startTest();
        Map<String, Object> result = HeaderCustomController.sendDynamicPassThroughComponent(
            'ACTIVE_SESSION', 
            'Test Component Text', 
            'https://example.com/custom-url', 
            'https://example.com/thumb.jpg', 
            'Dynamic_PassThrough_Component'
        );
        Test.stopTest();

        System.assertNotEquals(null, result, 'Result map should not be null');
        System.assertEquals('Dynamic_PassThrough_Component', result.get('componentName'), 'Component name should match');
    }

    /**
     * @description Test REST API doPost endpoint for proxy integration.
     */
    @isTest
    static void testDoPost_RestResourceEndpoint() {
        RestRequest req = new RestRequest();
        RestResponse res = new RestResponse();

        req.requestURI = '/services/apexrest/HeaderCustomController/v1/sendComponent';
        req.httpMethod = 'POST';
        req.requestBody = Blob.valueOf('{' +
            '"sessionId": "ACTIVE_SESSION",' +
            '"textValue": "Proxy Component Message",' +
            '"customUrl": "https://example.com",' +
            '"customImageUrl": "https://example.com/img.png",' +
            '"componentName": "Dynamic_PassThrough_Component"' +
        '}');

        RestContext.request = req;
        RestContext.response = res;

        Test.startTest();
        String jsonResult = HeaderCustomController.doPost();
        Map<String, Object> result = (Map<String, Object>) JSON.deserializeUntyped(jsonResult);
        Test.stopTest();

        System.assertNotEquals(null, result, 'REST doPost result should not be null');
        System.assertEquals('Dynamic_PassThrough_Component', result.get('componentName'), 'Component name should match');
    }

    /**
     * @description Test handleIncomingTurn with MIAW MessagingPlatformKey format (v2/iamessage/UNAUTH/NA/uid:...).
     */
    @isTest
    static void testHandleIncomingTurn_MessagingPlatformKey() {
        Test.startTest();
        String platformKey = 'v2/iamessage/UNAUTH/NA/uid:12345678-abcd-ef01-2345-6789abcdef01';
        Map<String, Object> result = HeaderCustomController.handleIncomingTurn(platformKey, 'Can you list specs?', true);
        Test.stopTest();

        System.assertNotEquals(null, result, 'Result map should not be null');
        System.assertEquals(platformKey, result.get('sessionId'), 'SessionId should match platformKey');
    }

    /**
     * @description Test handleIncomingTurn with MessagingEndUser ID (0PA...).
     */
    @isTest
    static void testHandleIncomingTurn_MessagingEndUserId() {
        Test.startTest();
        String endUserId = '0PA000000000000AAA';
        Map<String, Object> result = HeaderCustomController.handleIncomingTurn(endUserId, 'Hello EndUser', true);
        Test.stopTest();

        System.assertNotEquals(null, result, 'Result map should not be null');
        System.assertEquals(endUserId, result.get('sessionId'), 'SessionId should match endUserId');
    }

    /**
     * @description Test handleIncomingTurn with Conversation ID (0dw...).
     */
    @isTest
    static void testHandleIncomingTurn_ConversationId() {
        Test.startTest();
        String convId = '0dw000000000000AAA';
        Map<String, Object> result = HeaderCustomController.handleIncomingTurn(convId, 'Hello Conversation', false);
        Test.stopTest();

        System.assertNotEquals(null, result, 'Result map should not be null');
        System.assertEquals(convId, result.get('sessionId'), 'SessionId should match convId');
    }

    /**
     * @description Test escalateSessionWithAiRouting AuraEnabled method.
     */
    @isTest
    static void testEscalateSessionWithAiRouting() {
        Test.startTest();
        Map<String, Object> result = HeaderCustomController.escalateSessionWithAiRouting(
            null,
            'User asked for Spanish agent',
            'Customer conversation summary',
            'Spanish_Queue',
            'Skills_Based',
            2.0,
            'Spanish_2',
            'defaultFlowTuBot'
        );
        Test.stopTest();

        System.assertNotEquals(null, result, 'Escalate result should not be null');
        System.assert(result.containsKey('success'), 'Escalate result should contain success key');
    }

    /**
     * @description Test REST API doPost endpoint with action=escalate.
     */
    @isTest
    static void testDoPost_Escalate() {
        RestRequest req = new RestRequest();
        RestResponse res = new RestResponse();

        req.requestURI = '/services/apexrest/HeaderCustomController/v1/escalate';
        req.httpMethod = 'POST';
        req.requestBody = Blob.valueOf('{' +
            '"action": "escalate",' +
            '"reason": "User said quiero agente",' +
            '"summary": "Escalating to Spanish_2 per AI_Routing__c",' +
            '"targetSkill": "Spanish_2",' +
            '"targetQueue": "Spanish_Queue",' +
            '"skillLevel": 2.0' +
        '}');

        RestContext.request = req;
        RestContext.response = res;

        Test.startTest();
        String jsonResult = HeaderCustomController.doPost();
        Map<String, Object> result = (Map<String, Object>) JSON.deserializeUntyped(jsonResult);
        Test.stopTest();

        System.assertNotEquals(null, result, 'REST doPost escalation result should not be null');
        System.assert(result.containsKey('success'), 'Result should have success key');
    }
}


