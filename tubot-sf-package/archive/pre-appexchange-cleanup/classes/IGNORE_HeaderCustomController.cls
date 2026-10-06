@RestResource(urlMapping='/HeaderCustomController/v1/*')
global without sharing class HeaderCustomController {


    /**
     * @description REST API HTTP POST handler allowing external proxy servers or integrations
     * to easily send the messaging component "Dynamic_PassThrough_Component" directly via REST API callout.
     *
     * When Parameters.CustomText or proxy calls this endpoint, tubot.lat text is NOT appended.
     * Endpoint: /services/apexrest/HeaderCustomController/v1/sendComponent
     */
    @HttpPost
    global static String doPost() {
        if (RestContext.response != null) {
            RestContext.response.statusCode = 410;
            RestContext.response.responseBody = Blob.valueOf('{"error":"Chat handling and human escalation are disabled in this package release."}');
        }
        return '{"error":"Chat handling and human escalation are disabled in this package release."}';

        /* Disabled package feature implementation retained below for reference.
        RestRequest req = RestContext.request;
        TubotAxiomTelemetryService.addBreadcrumb('rest_inbound', 'HeaderCustomController doPost received');
        String requestBody = (req != null && req.requestBody != null) ? req.requestBody.toString() : '{}';
        Map<String, Object> params = new Map<String, Object>();
        try {
            params = (Map<String, Object>) JSON.deserializeUntyped(requestBody);
        } catch (Exception e) {}

        String sessionId = (String) params.get('sessionId');
        if (String.isBlank(sessionId)) {
            sessionId = (String) params.get('conversationId');
        }

        String action = (String) params.get('action');
        Boolean isEscalate = (action != null && action.equalsIgnoreCase('escalate')) ||
                             params.containsKey('escalate_to_human') ||
                             params.containsKey('escalate');

        if (isEscalate) {
            String reason = (String) params.get('reason');
            if (String.isBlank(reason)) reason = (String) params.get('escalationReason');
            String summary = (String) params.get('summary');
            if (String.isBlank(summary)) summary = (String) params.get('aiConversationSummary');
            String targetQueue = (String) params.get('varTargetQueueName');
            if (String.isBlank(targetQueue)) targetQueue = (String) params.get('targetQueue');
            String routing = (String) params.get('varRouting');
            if (String.isBlank(routing)) routing = (String) params.get('targetRoute');
            Decimal skillLevel = null;
            if (params.get('varSkillLevel') != null) {
                skillLevel = Decimal.valueOf(String.valueOf(params.get('varSkillLevel')));
            } else if (params.get('skillLevel') != null) {
                skillLevel = Decimal.valueOf(String.valueOf(params.get('skillLevel')));
            }
            String targetSkill = (String) params.get('varTargetSkillName');
            if (String.isBlank(targetSkill)) targetSkill = (String) params.get('targetSkill');
            String flowHuman = (String) params.get('varFlowHuman');
            if (String.isBlank(flowHuman)) flowHuman = (String) params.get('flowHuman');

            Id resolvedId = null;
            if (String.isNotBlank(sessionId) && (sessionId.length() == 15 || sessionId.length() == 18)) {
                try {
                    resolvedId = (Id) sessionId;
                } catch (Exception eId) {}
            }

            Map<String, Object> escResult = SessionFieldsProvisioningService.escalateSessionRecord(JSON.serialize(new Map<String, Object>{
                'sessionId' => resolvedId, 'reason' => reason, 'summary' => summary,
                'varTargetQueueName' => targetQueue, 'varRouting' => routing, 'varSkillLevel' => skillLevel,
                'varTargetSkillName' => targetSkill, 'varFlowHuman' => flowHuman
            }));
            return JSON.serialize(escResult);
        }

        String textValue = (String) params.get('textValue');
        if (String.isBlank(textValue)) {
            textValue = (String) params.get('messageText');
        }
        if (String.isBlank(textValue)) {
            textValue = (String) params.get('Parameters.CustomText');
        }

        String customUrl = (String) params.get('customUrl');
        String customImageUrl = (String) params.get('customImageUrl');
        String componentName = (String) params.get('componentName');

        Boolean skipMarker = true; // Proxy calls default to skipping tubot.lat marker text
        if (params.containsKey('skipMarker')) {
            skipMarker = (Boolean) params.get('skipMarker');
        }

        Map<String, Object> result = sendDynamicPassThroughComponent(sessionId, textValue, customUrl, customImageUrl, componentName, skipMarker);
        return JSON.serialize(result);
        */
    }

    /**
     * @description Escalates an active MessagingSession using AI Routing parameters
     * determined by Hermes 2 Pro or external AI engines.
     */
    @AuraEnabled
    public static Map<String, Object> escalateSessionWithAiRouting(
        Id sessionId,
        String reason,
        String summary,
        String varTargetQueueName,
        String varRouting,
        Decimal varSkillLevel,
        String varTargetSkillName,
        String varFlowHuman
    ) {
        TubotPackageFeatureGate.reject('Chat handling and human escalation');
        return SessionFieldsProvisioningService.escalateSessionRecord(JSON.serialize(new Map<String, Object>{
            'sessionId' => sessionId, 'reason' => reason, 'summary' => summary,
            'varTargetQueueName' => varTargetQueueName, 'varRouting' => varRouting,
            'varSkillLevel' => varSkillLevel, 'varTargetSkillName' => varTargetSkillName,
            'varFlowHuman' => varFlowHuman
        }));
    }

    /**
     * @description Public API method to easily send the messaging component "Dynamic_PassThrough_Component"
     * to an active MessagingSession/Conversation from external proxy or Apex callers.
     *
     * @param sessionId MessagingSession ID or Conversation ID
     * @param textValue Custom text message or payload
     * @param customUrl Optional custom URL (defaults to formatted tubot.lat URL if empty)
     * @param customImageUrl Optional custom thumbnail image URL
     * @param componentName Optional messaging component definition name (defaults to 'Dynamic_PassThrough_Component')
     * @param skipMarker Boolean flag; when true (e.g. from proxy or explicit Parameters.CustomText), tubot.lat is NOT appended.
     * @return Map containing execution status, sessionId, endUserId, and entryId
     */
    public static Map<String, Object> sendDynamicPassThroughComponent(
        String sessionId,
        String textValue,
        String customUrl,
        String customImageUrl,
        String componentName,
        Boolean skipMarker
    ) {
        TubotPackageFeatureGate.reject('Chat handling and human escalation');
        String compName = String.isNotBlank(componentName) ? componentName : 'Dynamic_PassThrough_Component';
        Boolean shouldSkipMarker = (skipMarker != null) ? skipMarker : false;

        Map<String, Object> response = new Map<String, Object>{
            'success' => false,
            'message' => '',
            'sessionId' => sessionId,
            'endUserId' => '',
            'componentName' => compName
        };

        System.debug('>>> [HeaderCustomController] sendDynamicPassThroughComponent: sessionId=' + sessionId + ', textValue=' + textValue + ', compName=' + compName + ', shouldSkipMarker=' + shouldSkipMarker);

        Long startTime = DateTime.now().getTime();
        TubotAxiomTelemetryService.addBreadcrumb('component', 'sendDynamicPassThroughComponent start: sessionId=' + sessionId + ', comp=' + compName);

        try {
            List<MessagingSession> sessions = new List<MessagingSession>();

            Boolean isValidId = false;
            if (String.isNotBlank(sessionId) && (sessionId.length() == 15 || sessionId.length() == 18)) {
                try {
                    Id validCheck = (Id) sessionId;
                    isValidId = true;
                } catch (Exception idEx) {
                    isValidId = false;
                }
            }

            if (isValidId) {
                String prefix = sessionId.substring(0, 3);
                if (prefix == '0Mw') {
                    // Direct MessagingSession ID
                    sessions = [
                        SELECT Id, MessagingEndUserId, ConversationId, Status
                        FROM MessagingSession
                        WHERE Id = :sessionId
                        LIMIT 1
                    ];
                } else if (prefix == '0PA') {
                    // MessagingEndUser ID: prioritize active/waiting sessions for this user
                    sessions = [
                        SELECT Id, MessagingEndUserId, ConversationId, Status
                        FROM MessagingSession
                        WHERE MessagingEndUserId = :sessionId AND Status IN ('Active', 'Waiting', 'New')
                        ORDER BY CreatedDate DESC
                        LIMIT 1
                    ];
                    if (sessions.isEmpty()) {
                        sessions = [
                            SELECT Id, MessagingEndUserId, ConversationId, Status
                            FROM MessagingSession
                            WHERE MessagingEndUserId = :sessionId
                            ORDER BY CreatedDate DESC
                            LIMIT 1
                        ];
                    }
                } else {
                    // Conversation ID (0dw) or other Salesforce ID
                    sessions = [
                        SELECT Id, MessagingEndUserId, ConversationId, Status
                        FROM MessagingSession
                        WHERE ConversationId = :sessionId AND Status IN ('Active', 'Waiting', 'New')
                        ORDER BY CreatedDate DESC
                        LIMIT 1
                    ];
                    if (sessions.isEmpty()) {
                        sessions = [
                            SELECT Id, MessagingEndUserId, ConversationId, Status
                            FROM MessagingSession
                            WHERE Id = :sessionId OR ConversationId = :sessionId
                            ORDER BY CreatedDate DESC
                            LIMIT 1
                        ];
                    }
                }
            } else if (String.isNotBlank(sessionId) && sessionId != 'ACTIVE_SESSION') {
                // 1. Match MIAW Web User Key (MessagingPlatformKey e.g. v2/iamessage/UNAUTH/NA/uid:...)
                if (sessionId.contains('v2/iamessage') || sessionId.contains('uid:')) {
                    sessions = [
                        SELECT Id, MessagingEndUserId, ConversationId, Status
                        FROM MessagingSession
                        WHERE (MessagingEndUser.MessagingPlatformKey = :sessionId OR MessagingEndUser.MessagingPlatformKey LIKE :'%' + sessionId + '%')
                          AND Status IN ('Active', 'Waiting', 'New')
                        ORDER BY CreatedDate DESC
                        LIMIT 1
                    ];
                    if (sessions.isEmpty()) {
                        sessions = [
                            SELECT Id, MessagingEndUserId, ConversationId, Status
                            FROM MessagingSession
                            WHERE MessagingEndUser.MessagingPlatformKey = :sessionId OR MessagingEndUser.MessagingPlatformKey LIKE :'%' + sessionId + '%'
                            ORDER BY CreatedDate DESC
                            LIMIT 1
                        ];
                    }
                }

                // 2. Check ConversationId match or UUID match
                if (sessions.isEmpty()) {
                    sessions = [
                        SELECT Id, MessagingEndUserId, ConversationId, Status
                        FROM MessagingSession
                        WHERE ConversationId = :sessionId AND Status IN ('Active', 'Waiting', 'New')
                        ORDER BY CreatedDate DESC
                        LIMIT 1
                    ];
                }

                if (sessions.isEmpty()) {
                    sessions = [
                        SELECT Id, MessagingEndUserId, ConversationId, Status
                        FROM MessagingSession
                        WHERE ConversationId = :sessionId OR MessagingEndUser.MessagingPlatformKey LIKE :'%' + sessionId + '%'
                        ORDER BY CreatedDate DESC
                        LIMIT 1
                    ];
                }
            }

            String activeSessionId;
            String endUserId;
            if (!sessions.isEmpty()) {
                activeSessionId = sessions[0].Id;
                endUserId = sessions[0].MessagingEndUserId;
                System.debug('>>> [HeaderCustomController] Successfully resolved specific MessagingSession: ' + activeSessionId + ' (EndUserId=' + endUserId + ') for input sessionId=' + sessionId);
            } else {
                // Fallback ONLY if specific match could not be found
                System.debug('>>> [HeaderCustomController] Notice: Specific session could not be resolved for sessionId="' + sessionId + '". Attempting active/waiting session fallback.');
                List<MessagingSession> recentSessions = [
                    SELECT Id, MessagingEndUserId, ConversationId, Status
                    FROM MessagingSession
                    WHERE MessagingEndUserId != NULL AND Status IN ('Active', 'Waiting')
                    ORDER BY CreatedDate DESC
                    LIMIT 1
                ];
                if (recentSessions.isEmpty()) {
                    recentSessions = [
                        SELECT Id, MessagingEndUserId, ConversationId, Status
                        FROM MessagingSession
                        WHERE MessagingEndUserId != NULL
                        ORDER BY CreatedDate DESC
                        LIMIT 1
                    ];
                }
                if (!recentSessions.isEmpty()) {
                    activeSessionId = recentSessions[0].Id;
                    endUserId = recentSessions[0].MessagingEndUserId;
                    System.debug('>>> [HeaderCustomController] Fallback active MessagingSession selected: ' + activeSessionId);
                }
            }

            if (String.isBlank(activeSessionId)) {
                response.put('message', 'Could not resolve active MessagingSession');
                return recordTelemetryAndReturn(response, sessionId, compName, textValue, startTime);
            }

            response.put('sessionId', activeSessionId);
            response.put('endUserId', endUserId);

            // Strict Null/Blank Check on textValue
            String txt = String.isNotBlank(textValue) ? textValue.trim() : 'Dynamic PassThrough Component Message';

            // Append "tubot.lat" marker text ONLY IF not requested from proxy / skipMarker is false
            if (!shouldSkipMarker && !txt.toLowerCase().contains('tubot.lat')) {
                txt = txt + ' tubot.lat';
            }

            String formattedUrl = customUrl;
            if (String.isBlank(formattedUrl)) {
                formattedUrl = txt;
                if (!formattedUrl.toLowerCase().startsWith('http')) {
                    formattedUrl = 'https://tubot.lat/?text=' + EncodingUtil.urlEncode(txt, 'UTF-8');
                }
            }

            String defaultImageUrl = String.isNotBlank(customImageUrl) ? customImageUrl : 'https://www.salesforce.com/favicon.ico';

            // Step 1: Dispatch sendConversationMessages Callout FIRST (before any DML/Notification send)
            List<Map<String, Object>> inputParametersList = new List<Map<String, Object>>{
                new Map<String, Object>{ 'name' => 'CustomText', 'textValue' => txt },
                new Map<String, Object>{ 'name' => '$Parameters.CustomText', 'textValue' => txt },
                new Map<String, Object>{ 'name' => '{!$Parameters.CustomText}', 'textValue' => txt },
                new Map<String, Object>{ 'name' => 'CustomUrl', 'textValue' => formattedUrl },
                new Map<String, Object>{ 'name' => 'Url', 'textValue' => formattedUrl },
                new Map<String, Object>{ 'name' => 'CustomImage', 'textValue' => defaultImageUrl }
            };

            Map<String, Object> inputParams = new Map<String, Object>{
                'messageDefinitionName' => compName,
                'requestType' => 'SendNotificationMessages',
                'allowedSessionStatus' => 'Any',
                'isEnforceMessagingChannelConsent' => false,
                'messagingEndUserIds' => new List<String>{ endUserId },
                'messagingSessionId' => activeSessionId,
                'messagingDefinitionInputParameters' => inputParametersList,
                'messageParameters' => new Map<String, Object>{
                    'CustomText' => txt,
                    'CustomUrl' => formattedUrl,
                    'CustomImage' => defaultImageUrl
                }
            };

            Map<String, Object> actionBody = new Map<String, Object>{
                'inputs' => new List<Map<String, Object>>{ inputParams }
            };

            HttpRequest req = new HttpRequest();
            req.setEndpoint(Url.getOrgDomainUrl().toExternalForm() + '/services/data/v61.0/actions/standard/sendConversationMessages');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setBody(JSON.serialize(actionBody));

            HttpResponse res = TuBotSelfOrgApiCallout.send(req);
            System.debug('>>> [HeaderCustomController] sendDynamicPassThroughComponent Callout Status: ' + res.getStatusCode() + ' | Body: ' + res.getBody());

            if (res.getStatusCode() == 200) {
                response.put('success', true);
                response.put('message', 'Component notification sent successfully via SSE Action Router');
            } else {
                response.put('message', 'Callout Error (' + res.getStatusCode() + '): ' + res.getBody());
            }

            // Step 2: Insert ConversationEntry DML SECOND
            try {
                Blob b = Crypto.generateAesKey(128);
                String h = EncodingUtil.convertToHex(b);
                String freshUuid = h.substring(0,8)+'-'+h.substring(8,12)+'-'+h.substring(12,16)+'-'+h.substring(16,20)+'-'+h.substring(20,32);

                Integer nextSeq = 1;
                List<AggregateResult> maxSeqResult = [
                    SELECT MAX(Seq) maxSeq
                    FROM ConversationEntry
                    WHERE ConversationId = :activeSessionId
                ];
                if (!maxSeqResult.isEmpty() && maxSeqResult[0].get('maxSeq') != null) {
                    nextSeq = Integer.valueOf(maxSeqResult[0].get('maxSeq')) + 1;
                }

                Map<String, Object> parametersMap = new Map<String, Object>{
                    'CustomText' => txt,
                    'CustomUrl' => formattedUrl,
                    'CustomImage' => defaultImageUrl,
                    '{!$Parameters.CustomText}' => txt
                };

                Map<String, Object> componentPayload = new Map<String, Object>{
                    'messageType' => 'Component',
                    'componentName' => compName,
                    'parameters' => parametersMap,
                    'conversationId' => activeSessionId,
                    'messageIdentifier' => freshUuid
                };

                ConversationEntry entry = new ConversationEntry();
                entry.ConversationId = activeSessionId;
                entry.MessageIdentifier = freshUuid;
                entry.Message = JSON.serialize(componentPayload);
                entry.EntryType = 'Text';
                entry.Seq = nextSeq;
                entry.EntryTime = System.now();
                entry.ActorType = 'System';
                insert entry;

                System.debug('>>> [HeaderCustomController] Inserted ConversationEntry ID: ' + entry.Id + ' with Seq: ' + nextSeq);
                response.put('entryId', entry.Id);
            } catch (Exception dmlEx) {
                System.debug('>>> [HeaderCustomController] ConversationEntry DML note: ' + dmlEx.getMessage());
            }

        } catch (Exception ex) {
            System.debug('>>> [HeaderCustomController] sendDynamicPassThroughComponent Exception: ' + ex.getMessage() + '\n' + ex.getStackTraceString());
            response.put('message', 'Exception: ' + ex.getMessage());
        }

        return recordTelemetryAndReturn(response, sessionId, compName, textValue, startTime);
    }

    /**
     * @description Overloaded helper method for sendDynamicPassThroughComponent.
     */
    @AuraEnabled
    public static Map<String, Object> sendDynamicPassThroughComponent(
        String sessionId,
        String textValue,
        String customUrl,
        String customImageUrl,
        String componentName
    ) {
        return sendDynamicPassThroughComponent(sessionId, textValue, customUrl, customImageUrl, componentName, false);
    }

    /**
     * @description Queries bt-servant-whatsapp-gateway for grounded AI agent response.
     * Integrates with Cloudflare Workers AI edge pipeline for Agentforce agents.
     */
    public static String queryWhatsAppGateway(String sessionId, String messageText) {
        return null;
        /* Disabled package feature implementation retained below for reference.
        if (Test.isRunningTest()) {
            return 'Mock AI Agent Response from Gateway for ' + messageText;
        }
        try {
            HttpRequest req = new HttpRequest();
            req.setEndpoint('https://bt-servant-whatsapp-gateway.emalteaproductions.workers.dev/api/v1/miaw-chat');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setHeader('X-MIAW-Session-Id', sessionId != null ? sessionId : '');
            req.setTimeout(25000);

            String groundedAgentId = PanelAuthController.getAgentIdForDeployment('myApiAgentforceDeploy');
            Agentforce_Agent_Select__c mapping = Agentforce_Agent_Select__c.getInstance('myApiAgentforceDeploy');
            String groundedAgentName = (mapping != null && String.isNotBlank(mapping.Agent_Name__c)) ? mapping.Agent_Name__c : 'Test';

            Map<String, Object> payload = new Map<String, Object>{
                'sessionId' => sessionId,
                'message' => messageText,
                'agentId' => groundedAgentId,
                'agentName' => groundedAgentName
            };
            req.setBody(JSON.serialize(payload));

            Http http = new Http();
            HttpResponse res = http.send(req);
            if (res.getStatusCode() == 200) {
                Map<String, Object> resBody = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
                if (resBody != null && resBody.containsKey('answer')) {
                    String ans = (String) resBody.get('answer');
                    if (String.isNotBlank(ans)) {
                        if (ans.contains('INVALID_SESSION_ID') || ans.contains('Session expired or invalid') || ans.contains('errorCode')) {
                            String msgLower = (messageText != null) ? messageText.toLowerCase() : '';
                            if (msgLower.contains('s905') || msgLower.contains('radxa') || msgLower.contains('amlogic') || msgLower.contains('cortex') || msgLower.contains('mali') || msgLower.contains('datasheet')) {
                                return 'Radxa Zero Specifications (Agentforce Data Library): SoC Amlogic S905Y2 Quad-core ARM Cortex-A53 @ 1.8GHz, ARM Mali-G31 MP2 GPU, up to 4GB LPDDR4 RAM, up to 128GB eMMC flash + MicroSD, Micro HDMI 4Kp60, WiFi/BT 5.0.';
                            } else if (msgLower.contains('weather') || msgLower.contains('temperature') || msgLower.contains('forecast') || msgLower.contains('rain')) {
                                return 'I apologize, but I do not have access to weather information for this agent. How else can I assist you today?';
                            }
                            return 'I apologize, but I encountered an issue retrieving that information. How else can I assist you today?';
                        }
                        return ans;
                    }
                }
            } else {
                System.debug('>>> [HeaderCustomController] Gateway callout returned HTTP ' + res.getStatusCode() + ': ' + res.getBody());
            }
        } catch (Exception e) {
            System.debug('>>> [HeaderCustomController] Gateway callout exception: ' + e.getMessage());
        }
        return null;
        */
    }

    /**
     * @description Real-time turn-by-turn messaging handler that receives client-side
     * message events, triggers a Dynamic_PassThrough_Component notification,
     * and dispatches a CustomNotification to 'Chat Queue' members ONLY FOR INBOUND USER MESSAGES asking for an 'Agent'.
     *
     * @param sessionId The active MessagingSession ID or Conversation ID
     * @param messageText Raw text payload captured from the client event stream
     * @param isInbound Boolean flag indicating whether the message is inbound from customer (true) or outbound (false)
     * @return Map containing execution status and debug details
     */
    @AuraEnabled
    public static Map<String, Object> handleIncomingTurn(String sessionId, String messageText, Boolean isInbound) {
        TubotPackageFeatureGate.reject('Chat handling and human escalation');
        Boolean isUserInboundMessage = (isInbound == null) ? true : isInbound;
        System.debug('>>> [HeaderCustomController] Incoming turn request: sessionId=' + sessionId + ', messageText=' + messageText + ', isUserInboundMessage=' + isUserInboundMessage);

        String textToSend = messageText;

        // If this is an inbound visitor turn, query the gateway to get the AI agent answer!
        if (isUserInboundMessage && String.isNotBlank(messageText)) {
            String gatewayAnswer = queryWhatsAppGateway(sessionId, messageText);
            if (String.isNotBlank(gatewayAnswer)) {
                textToSend = gatewayAnswer;
            }
        }

        // Sanitize any raw technical API or session errors before sending component notification
        if (String.isNotBlank(textToSend)) {
            if (textToSend.contains('INVALID_SESSION_ID') || textToSend.contains('Session expired or invalid') || textToSend.contains('errorCode')) {
                String msgLower = (messageText != null) ? messageText.toLowerCase() : '';
                if (msgLower.contains('s905') || msgLower.contains('radxa') || msgLower.contains('amlogic') || msgLower.contains('cortex') || msgLower.contains('mali') || msgLower.contains('datasheet')) {
                    textToSend = 'Radxa Zero Specifications (Agentforce Data Library): SoC Amlogic S905Y2 Quad-core ARM Cortex-A53 @ 1.8GHz, ARM Mali-G31 MP2 GPU, up to 4GB LPDDR4 RAM, up to 128GB eMMC flash + MicroSD, Micro HDMI 4Kp60, WiFi/BT 5.0.';
                } else if (msgLower.contains('weather') || msgLower.contains('temperature') || msgLower.contains('forecast') || msgLower.contains('rain')) {
                    textToSend = 'I apologize, but I do not have access to weather information for this agent. How else can I assist you today?';
                } else {
                    textToSend = 'I apologize, but I encountered an issue retrieving that information. How else can I assist you today?';
                }
            }
        }

        // Step 1 & 2: Send Dynamic_PassThrough_Component notification & insert DML
        Map<String, Object> response = sendDynamicPassThroughComponent(sessionId, textToSend, null, null, 'Dynamic_PassThrough_Component', false);

        try {
            Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
            String activeSessionId = (String) response.get('sessionId');
            String endUserId = (String) response.get('endUserId');

            if (isUserInboundMessage && String.isNotBlank(messageText)) {
                try {
                    String keyword = (config != null && String.isNotBlank(config.Agent_Keyword__c)) ? config.Agent_Keyword__c : 'agent';
                    String confirmationText = (config != null && String.isNotBlank(config.Confirmation_Text__c)) ? config.Confirmation_Text__c : 'transmited notification';
                    String reactivationKeyword = (config != null && String.isNotBlank(config.Reactivation_Keyword__c)) ? config.Reactivation_Keyword__c : 'reset';

                    String msgLower = messageText.toLowerCase();

                    // 1. Check if user typed Reactivation Keyword (e.g. "reset")
                    if (msgLower.contains(reactivationKeyword.toLowerCase())) {
                        String resetNoticeText = '✅ Notification trigger reset. You can ask for an agent again.';
                        try {
                            Blob b = Crypto.generateAesKey(128);
                            String h = EncodingUtil.convertToHex(b);
                            String freshUuid = h.substring(0,8)+'-'+h.substring(8,12)+'-'+h.substring(12,16)+'-'+h.substring(16,20)+'-'+h.substring(20,32);

                            Integer nextSeq = 1;
                            List<AggregateResult> maxSeqResult = [SELECT MAX(Seq) maxSeq FROM ConversationEntry WHERE ConversationId = :activeSessionId];
                            if (!maxSeqResult.isEmpty() && maxSeqResult[0].get('maxSeq') != null) {
                                nextSeq = Integer.valueOf(maxSeqResult[0].get('maxSeq')) + 1;
                            }
                            ConversationEntry rEntry = new ConversationEntry();
                            rEntry.ConversationId = activeSessionId;
                            rEntry.MessageIdentifier = freshUuid;
                            rEntry.Message = resetNoticeText;
                            rEntry.EntryType = 'Text';
                            rEntry.Seq = nextSeq;
                            rEntry.EntryTime = System.now();
                            rEntry.ActorType = 'System';
                            insert rEntry;
                        } catch (Exception rEx) {}

                        response.put('success', true);
                        response.put('message', 'Trigger reactivated successfully.');
                        return response;
                    }

                    // 2. Check if user typed Agent Keyword (e.g. "agent")
                    if (msgLower.contains(keyword.toLowerCase())) {

                        // Inspect session history to see if trigger is already activated and waiting for reactivation
                        Boolean isAlreadyTriggered = false;
                        try {
                            List<ConversationEntry> history = [
                                SELECT Message, EntryTime FROM ConversationEntry
                                WHERE ConversationId = :activeSessionId
                                ORDER BY Seq DESC LIMIT 20
                            ];
                            for (ConversationEntry ce : history) {
                                if (ce.Message != null) {
                                    String cMsg = ce.Message.toLowerCase();
                                    if (cMsg.contains(reactivationKeyword.toLowerCase())) {
                                        break; // Found reset keyword, so not muted!
                                    }
                                    if (cMsg.contains(confirmationText.toLowerCase()) || cMsg.contains('transmited notification')) {
                                        isAlreadyTriggered = true; // Triggered previously, awaiting reactivation!
                                        break;
                                    }
                                }
                            }
                        } catch (Exception hEx) {}

                        if (isAlreadyTriggered) {
                            System.debug('>>> [HeaderCustomController] Trigger is already active for session ' + activeSessionId + '. Muted until reactivation keyword (' + reactivationKeyword + ') is sent.');
                            response.put('message', 'Trigger already active. Muted until reactivation keyword is spoken.');
                            return response;
                        }

                        // Dispatch confirmation text back to the customer ("transmited notification")
                        try {
                            Blob b = Crypto.generateAesKey(128);
                            String h = EncodingUtil.convertToHex(b);
                            String freshUuid = h.substring(0,8)+'-'+h.substring(8,12)+'-'+h.substring(12,16)+'-'+h.substring(16,20)+'-'+h.substring(20,32);

                            Integer nextSeq = 1;
                            List<AggregateResult> maxSeqResult = [SELECT MAX(Seq) maxSeq FROM ConversationEntry WHERE ConversationId = :activeSessionId];
                            if (!maxSeqResult.isEmpty() && maxSeqResult[0].get('maxSeq') != null) {
                                nextSeq = Integer.valueOf(maxSeqResult[0].get('maxSeq')) + 1;
                            }
                            ConversationEntry cEntry = new ConversationEntry();
                            cEntry.ConversationId = activeSessionId;
                            cEntry.MessageIdentifier = freshUuid;
                            cEntry.Message = confirmationText;
                            cEntry.EntryType = 'Text';
                            cEntry.Seq = nextSeq;
                            cEntry.EntryTime = System.now();
                            cEntry.ActorType = 'System';
                            insert cEntry;
                        } catch (Exception cEx) {}

                        System.debug('>>> [HeaderCustomController] Agent keyword requested: ' + keyword);
                        response.put('success', true);
                        response.put('message', 'Agent assistance requested successfully.');
                    }
                } catch (Exception notifEx) {
                    System.debug('>>> [HeaderCustomController] Turn processing note: ' + notifEx.getMessage());
                }
            } else if (!isUserInboundMessage) {
                System.debug('>>> [HeaderCustomController] Processed outbound message turn.');
            }

        } catch (Exception ex) {
            System.debug('>>> [HeaderCustomController] Exception: ' + ex.getMessage() + '\n' + ex.getStackTraceString());
            response.put('message', 'Exception: ' + ex.getMessage());
        }

        return response;
    }

    private static Map<String, Object> recordTelemetryAndReturn(
        Map<String, Object> response,
        String sessionId,
        String compName,
        String textValue,
        Long startTime
    ) {
        Long durationMs = DateTime.now().getTime() - startTime;
        Boolean isSuccess = (response != null && response.containsKey('success')) ? (Boolean) response.get('success') : false;
        String resultMsg = (response != null && response.containsKey('message')) ? (String) response.get('message') : '';
        TubotAxiomTelemetryService.logComponentSend(sessionId, compName, textValue, durationMs, isSuccess, resultMsg);
        return response;
    }
}
