/**
 * @description Simple Setup channel step: selects the newest MessagingChannel
 * or creates an Embedded Messaging channel plus Omni-Queue with plain Apex
 * DML (no Metadata API, no sessions, no callouts), then activates it, enrolls
 * the integration user, and blind-verifies. Idempotent: re-runs select the
 * previously created channel (or reuse the existing queue) instead of
 * duplicating them.
 *
 * DML parity note: a metadata deploy can also attach a QueueRoutingConfig,
 * opt-out keywords, and automated responses, which have no DML-writable
 * equivalent. The DML-created channel is otherwise identical (verified live:
 * EmbeddedMessaging type, platform-generated key, queue session handler,
 * Enhanced platform). Admins needing routing configs or keyword responses
 * add them in Setup or provision via the CLI post-install script.
 */
public with sharing class SimpleSetupChannelStep {
    public static final String DEFAULT_CHANNEL_NAME = 'Web_Chat_Channel';
    public static final String DEFAULT_CHANNEL_LABEL = 'Web Chat Channel';
    public static final String DEFAULT_QUEUE_NAME = 'Omni_Web_Queue';
    public static final String DEFAULT_QUEUE_LABEL = 'Omni Web Queue';
    public static final String MESSAGE_TYPE_EMBEDDED = 'EmbeddedMessaging';
    public static final String QUEUE_SOBJECT_MESSAGING_SESSION = 'MessagingSession';

    // Test seam: MessagingChannel rows are visible in test context, so tests
    // covering the nothing-exists path set this to force a null result.
    @TestVisible
    private static Boolean forceNoExistingChannel = false;

    public class ChannelStepException extends Exception {
    }

    /** @description Channel/queue names plus the enrolling user for creation. */
    public class ChannelSpec {
        public String channelName;
        public String channelLabel;
        public String queueName;
        public String queueLabel;
        public Id userId;
    }

    /** @description Channel by DeveloperName, or null when absent. */
    public static Map<String, Object> findChannelByDeveloperName(String developerName) {
        List<MessagingChannel> channels = [
            SELECT Id, DeveloperName, MasterLabel, MessageType, IsActive
            FROM MessagingChannel
            WHERE DeveloperName = :developerName
            WITH USER_MODE
            LIMIT 1
        ];
        if (channels.isEmpty()) {
            return null;
        }
        MessagingChannel channel = channels[0];
        return new Map<String, Object>{
            'id' => channel.Id,
            'developerName' => channel.DeveloperName,
            'label' => channel.MasterLabel,
            'messageType' => channel.MessageType,
            'isActive' => channel.IsActive
        };
    }

    /** @description Newest channel in the org, or null when none exists. */
    public static Map<String, Object> findExistingChannel() {
        if (Test.isRunningTest() && forceNoExistingChannel) {
            return null;
        }
        List<MessagingChannel> channels = [
            SELECT Id, DeveloperName, MasterLabel, MessageType, IsActive
            FROM MessagingChannel
            WITH USER_MODE
            ORDER BY CreatedDate DESC
            LIMIT 1
        ];
        if (channels.isEmpty()) {
            return null;
        }
        MessagingChannel channel = channels[0];
        return new Map<String, Object>{
            'id' => channel.Id,
            'developerName' => channel.DeveloperName,
            'label' => channel.MasterLabel,
            'messageType' => channel.MessageType,
            'isActive' => channel.IsActive
        };
    }

    /**
     * @description Ensure an existing channel is active and verified. Queue
     * membership is left untouched (the channel already has its own queue).
     */
    public static Map<String, Object> ensureActive(String channelId) {
        List<MessagingChannel> channels = [
            SELECT Id, DeveloperName, MasterLabel, IsActive
            FROM MessagingChannel
            WHERE Id = :channelId
            WITH USER_MODE
            LIMIT 1
        ];
        if (channels.isEmpty()) {
            throw new ChannelStepException('Messaging Channel was not found.');
        }
        if (!channels[0].IsActive) {
            update as user new MessagingChannel(Id = channels[0].Id, IsActive = true);
        }
        List<MessagingChannel> verified = [
            SELECT Id, IsActive FROM MessagingChannel WHERE Id = :channelId WITH USER_MODE LIMIT 1
        ];
        if (verified.isEmpty() || !verified[0].IsActive) {
            throw new ChannelStepException('Channel activation could not be verified.');
        }
        return new Map<String, Object>{
            'id' => channels[0].Id,
            'developerName' => channels[0].DeveloperName,
            'label' => channels[0].MasterLabel
        };
    }

    /**
     * @description Create the channel plus its Omni-Queue with DML, then
     * activate and verify. Reuses an existing queue or channel with the same
     * developer name so re-runs never duplicate setup rows.
     */
    public static Map<String, Object> createChannelWithQueue(ChannelSpec spec) {
        Map<String, Object> existing = findChannelByDeveloperName(spec.channelName);
        if (existing != null) {
            return activateAndVerify((String) existing.get('id'), spec.userId, spec.queueName);
        }
        Id queueId;
        try {
            queueId = ensureQueue(spec.queueName, spec.queueLabel);
            MessagingChannel channel = new MessagingChannel(
                DeveloperName = spec.channelName,
                MasterLabel = spec.channelLabel,
                MessageType = MESSAGE_TYPE_EMBEDDED,
                SessionHandlerId = queueId
            );
            insert as user channel;
            return activateAndVerify(channel.Id, spec.userId, spec.queueName);
        } catch (ChannelStepException e) {
            throw e;
        } catch (DmlException e) {
            throw new ChannelStepException(
                'Channel creation failed: ' + e.getDmlMessage(0)
                + ' If Messaging is disabled in this org, enable it (Setup > Messaging Settings), then re-run Simple Setup.'
            );
        }
    }

    /**
     * @description Ensure the channel is active and the user is enrolled,
     * then blind-verify both. Used for newly deployed channels.
     */
    public static Map<String, Object> activateAndVerify(String channelId, Id userId, String queueName) {
        List<MessagingChannel> channels = [
            SELECT Id, DeveloperName, MasterLabel, IsActive
            FROM MessagingChannel
            WHERE Id = :channelId
            WITH USER_MODE
            LIMIT 1
        ];
        if (channels.isEmpty()) {
            throw new ChannelStepException('Messaging Channel was not found after deployment.');
        }
        MessagingChannel channel = channels[0];
        if (!channel.IsActive) {
            update as user new MessagingChannel(Id = channel.Id, IsActive = true);
        }
        String memberId = ensureQueueMember(queueName, userId);
        List<MessagingChannel> verified = [
            SELECT Id, IsActive FROM MessagingChannel WHERE Id = :channelId WITH USER_MODE LIMIT 1
        ];
        Integer memberCount = [
            SELECT COUNT() FROM GroupMember WHERE Id = :memberId WITH USER_MODE
        ];
        if (verified.isEmpty() || !verified[0].IsActive || memberCount < 1) {
            throw new ChannelStepException(
                'Channel verification failed: activation or queue membership is missing in the target org.'
            );
        }
        return new Map<String, Object>{
            'id' => channel.Id,
            'developerName' => channel.DeveloperName,
            'label' => channel.MasterLabel
        };
    }

    // Find the Omni-Queue by developer name, creating it (plus its
    // MessagingSession membership row) when absent. Queue creation is plain
    // Group/QueueSobject DML: no Metadata API involved.
    private static Id ensureQueue(String queueName, String queueLabel) {
        List<Group> queues = [
            SELECT Id FROM Group
            WHERE Type = 'Queue' AND DeveloperName = :queueName
            WITH USER_MODE LIMIT 1
        ];
        if (!queues.isEmpty()) {
            ensureQueueSobject(queues[0].Id);
            return queues[0].Id;
        }
        Group queue = new Group(
            Name = queueLabel, DeveloperName = queueName, Type = 'Queue'
        );
        insert as user queue;
        ensureQueueSobject(queue.Id);
        return queue.Id;
    }

    private static void ensureQueueSobject(Id queueId) {
        Integer existing = [
            SELECT COUNT() FROM QueueSobject
            WHERE QueueId = :queueId AND SobjectType = :QUEUE_SOBJECT_MESSAGING_SESSION
            WITH USER_MODE
        ];
        if (existing < 1) {
            insert as user new QueueSobject(
                QueueId = queueId, SobjectType = QUEUE_SOBJECT_MESSAGING_SESSION
            );
        }
    }

    private static String ensureQueueMember(String queueName, Id userId) {
        List<Group> queues = [
            SELECT Id FROM Group
            WHERE Type = 'Queue' AND DeveloperName = :queueName
            WITH USER_MODE LIMIT 1
        ];
        if (queues.isEmpty()) {
            throw new ChannelStepException('Queue \'' + queueName + '\' was not found in the org.');
        }
        Id queueId = queues[0].Id;
        List<GroupMember> existing = [
            SELECT Id FROM GroupMember
            WHERE GroupId = :queueId AND UserOrGroupId = :userId
            WITH USER_MODE LIMIT 1
        ];
        if (!existing.isEmpty()) {
            return existing[0].Id;
        }
        GroupMember member = new GroupMember(GroupId = queueId, UserOrGroupId = userId);
        insert as user member;
        return member.Id;
    }
}
