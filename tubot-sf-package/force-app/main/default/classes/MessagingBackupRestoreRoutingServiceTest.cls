@IsTest
private class MessagingBackupRestoreRoutingServiceTest {
    @TestSetup
    static void grantRoutingPermission() {
        User currentUser = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];
        System.runAs(currentUser) {
            PanelTestPermissionHelper.assignPermissionSet(currentUser.Id, 'Panel_Settings_Admin_Access');
        }
    }

    private class RoutingPatchMock implements HttpCalloutMock {
        private String expectedTargetQueueId;

        public RoutingPatchMock(String targetQueueId) {
            expectedTargetQueueId = targetQueueId;
        }

        public HTTPResponse respond(HTTPRequest request) {
            System.assertEquals('POST', request.getMethod());
            Map<String, Object> salesforceRequest = (Map<String, Object>) JSON.deserializeUntyped(request.getBody());
            System.assertEquals('PATCH', salesforceRequest.get('method'));
            System.assert(((String) salesforceRequest.get('path')).contains('/services/data/v67.0/sobjects/MessagingChannel/'));
            Map<String, Object> patch = (Map<String, Object>) JSON.deserializeUntyped((String) salesforceRequest.get('requestBody'));
            System.assertEquals('OmniQueue', patch.get('RoutingType'));
            System.assertEquals(expectedTargetQueueId, patch.get('TargetQueueId'));
            System.assert(patch.containsKey('FallbackQueueId'));
            System.assertEquals(null, patch.get('FallbackQueueId'));
            HttpResponse response = new HttpResponse();
            response.setStatusCode(204);
            return response;
        }
    }

    private static MessagingChannel syntheticChannel(String developerName) {
        String keyPrefix = MessagingChannel.SObjectType.getDescribe(SObjectDescribeOptions.DEFERRED).getKeyPrefix();
        Id channelId = (Id) (keyPrefix + '000000000000');
        MessagingChannel channel = new MessagingChannel(Id = channelId, DeveloperName = developerName);
        return channel;
    }

    private static MessagingBackupRestoreRoutingService.ChannelContext contextFor(MessagingChannel channel) {
        MessagingBackupRestoreRoutingService.ChannelContext context =
            new MessagingBackupRestoreRoutingService.ChannelContext();
        context.baseUrl = Url.getOrgDomainUrl().toExternalForm();
        context.logs = new List<String>();
        context.current.put(channel.DeveloperName.toLowerCase(), channel);
        return context;
    }

    @IsTest
    static void restoreMessagingChannelsPatchesChangedValuesAndSkipsUnknownNames() {
        MessagingChannel channel = syntheticChannel('RoutingRestoreTestChannel');
        MessagingBackupRestoreRoutingService.ChannelContext context = contextFor(channel);
        String targetQueueId = String.valueOf(UserInfo.getUserId());
        Test.setMock(HttpCalloutMock.class, new RoutingPatchMock(targetQueueId));
        List<String> logs = context.logs;
        User admin = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()];

        Test.startTest();
        System.runAs(admin) {
            MessagingBackupRestoreRoutingService.restoreChannel(context, new Map<String, Object>{
                'developerName' => 'RoutingRestoreTestChannel',
                'sessionHandlerId' => null,
                'fallbackQueueId' => String.valueOf(UserInfo.getUserId()),
                'routingType' => 'OmniQueue',
                'targetQueueId' => targetQueueId,
                'routingConfigurationId' => null
            });
            MessagingBackupRestoreRoutingService.restoreChannel(context, new Map<String, Object>{
                'developerName' => 'NoMatchingChannel'
            });
        }
        Test.stopTest();

        System.assertEquals(1, logs.size());
        System.assert(logs[0].contains('routing restored'));
        System.assertNotEquals(null, channel.Id);
    }

    @IsTest
    static void restoreChannelRejectsMissingOptionalRoutingField() {
        if (Schema.SObjectType.MessagingChannel.fields.getMap().containsKey('RoutingConfigurationId')) {
            return;
        }
        MessagingBackupRestoreRoutingService.ChannelContext context = contextFor(
            syntheticChannel('RoutingRestoreMissingFieldChannel')
        );
        Boolean rejected = false;
        try {
            MessagingBackupRestoreRoutingService.restoreChannel(context, new Map<String, Object>{
                'developerName' => 'RoutingRestoreMissingFieldChannel',
                'sessionHandlerId' => null,
                'fallbackQueueId' => null,
                'routingType' => null,
                'targetQueueId' => null,
                'routingConfigurationId' => 'routing-config-required'
            });
        } catch (AuraHandledException ex) {
            rejected = true;
        }
        System.assertEquals(true, rejected);
    }

    @IsTest
    static void routingPatchRetainsSavedHandlerAndDetectsNoChanges() {
        ApexClass handlerClass = [SELECT Id FROM ApexClass WHERE Name = 'PanelAuthController' LIMIT 1];
        MessagingChannel current = syntheticChannel('MatchingRoutingChannel');
        current.put('SessionHandlerId', handlerClass.Id);
        current.put('FallbackQueueId', null);
        current.put('RoutingType', null);
        current.put('TargetQueueId', null);
        Map<String, Object> snapshot = new Map<String, Object>{
            'sessionHandlerId' => String.valueOf(handlerClass.Id),
            'fallbackQueueId' => null,
            'routingType' => null,
            'targetQueueId' => null,
            'routingConfigurationId' => null
        };

        Map<String, Object> patch = MessagingBackupRestoreRoutingService.routingPatch(current, snapshot);

        System.assertEquals(true, patch.isEmpty());
    }

    @IsTest
    static void missingQueueLinksFiltersUnsupportedAndAlreadyPresentRows() {
        Group pendingQueue = new Group(Name = 'Pending Messaging Queue', DeveloperName = 'PendingMessagingQueue', Type = 'Queue');
        Group existingQueue = new Group(Name = 'Existing Messaging Queue', DeveloperName = 'ExistingMessagingQueue', Type = 'Queue');
        insert new List<Group>{ pendingQueue, existingQueue };
        String existingQueueId = String.valueOf(existingQueue.Id);
        List<QueueSobject> pending = MessagingBackupRestoreRoutingService.missingMessagingSessionQueueLinks(
            new List<Object>{
                new Map<String, Object>{ 'queueId' => String.valueOf(pendingQueue.Id), 'sobjectType' => 'MessagingSession' },
                new Map<String, Object>{ 'queueId' => existingQueueId, 'sobjectType' => 'MessagingSession' },
                new Map<String, Object>{ 'queueId' => existingQueueId, 'sobjectType' => 'Account' },
                new Map<String, Object>{ 'queueId' => '', 'sobjectType' => 'MessagingSession' }
            },
            new Set<String>{ existingQueueId }
        );

        System.assertEquals(1, pending.size());
        System.assertEquals('MessagingSession', pending[0].SobjectType);
        System.assertEquals(pendingQueue.Id, pending[0].QueueId);
        System.assertEquals(0, MessagingBackupRestoreRoutingService.missingMessagingSessionQueueLinks(null, new Set<String>()).size());
    }

    @IsTest
    static void restoreQueuesAcceptsEmptySnapshot() {
        List<String> logs = new List<String>();
        MessagingBackupRestoreRoutingService.restoreQueues(new List<Object>(), null, logs);
        System.assertEquals(0, logs.size());
    }
}
