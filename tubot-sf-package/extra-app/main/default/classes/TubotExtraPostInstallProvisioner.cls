/** Creates and links Omni-Channel routing records after the managed package installs. */
public without sharing class TubotExtraPostInstallProvisioner {
    private static final String CHAT_ROUTING_NAME = 'Chat_Routing_Config';
    private static final String HOLDING_ROUTING_NAME = 'Holding_Routing_Config';
    private static final String HOLDING_SKILL_NAME = 'TuBot_On_Hold_DO_NOT_EDIT';
    private static final String PACKAGE_NAMESPACE = 'tubot';
    private static final String PROVISION_FLOW_API_NAME = 'TubotExtraCreateOmniRecords';
    private static final String QUEUE_PROVISION_FLOW_API_NAME = 'TubotExtraEnsureQueue';

    @future
    public static void provisionAfterInstall() {
        provision();
    }

    public static void provision() {
        Set<String> routingNames = new Set<String>{ CHAT_ROUTING_NAME, HOLDING_ROUTING_NAME };
        Set<String> existingRoutingNames = new Set<String>();
        for (QueueRoutingConfig config : [
            SELECT DeveloperName
            FROM QueueRoutingConfig
            WHERE DeveloperName IN :routingNames
        ]) {
            existingRoutingNames.add(config.DeveloperName);
        }
        Boolean createChatRouting = !existingRoutingNames.contains(CHAT_ROUTING_NAME);
        Boolean createHoldingRouting = !existingRoutingNames.contains(HOLDING_ROUTING_NAME);

        Integer existingSkillCount = [
            SELECT COUNT()
            FROM Skill
            WHERE DeveloperName = :HOLDING_SKILL_NAME
        ];
        Boolean createHoldingSkill = existingSkillCount == 0;

        if (createChatRouting || createHoldingRouting || createHoldingSkill) {
            Flow.Interview provisioningFlow = Flow.Interview.createInterview(
                PACKAGE_NAMESPACE,
                PROVISION_FLOW_API_NAME,
                new Map<String, Object>{
                    'createChatRoutingConfig' => createChatRouting,
                    'createHoldingRoutingConfig' => createHoldingRouting,
                    'createHoldingSkill' => createHoldingSkill
                }
            );
            provisioningFlow.start();
        }

        Map<String, Id> routingIdsByName = new Map<String, Id>();
        for (QueueRoutingConfig config : [
            SELECT Id, DeveloperName
            FROM QueueRoutingConfig
            WHERE DeveloperName IN :routingNames
        ]) {
            routingIdsByName.put(config.DeveloperName, config.Id);
        }
        if (!routingIdsByName.containsKey(CHAT_ROUTING_NAME) ||
            !routingIdsByName.containsKey(HOLDING_ROUTING_NAME)) {
            throw new ProvisioningException('The packaged Flow did not create both routing configurations.');
        }

        Integer finalSkillCount = [
            SELECT COUNT()
            FROM Skill
            WHERE DeveloperName = :HOLDING_SKILL_NAME
        ];
        if (finalSkillCount == 0) {
            throw new ProvisioningException('The packaged Flow did not create the holding skill.');
        }

        ensureQueue(
            'Chat_Queue',
            'Chat Queue',
            routingIdsByName.get(CHAT_ROUTING_NAME),
            true,
            false
        );
        ensureQueue(
            'AI_Bot_Holding_Queue_100',
            'AI Bot Holding Queue 100',
            routingIdsByName.get(HOLDING_ROUTING_NAME),
            true,
            true
        );
    }

    private static void ensureQueue(
        String queueDeveloperName,
        String queueLabel,
        Id routingConfigId,
        Boolean addMessagingSession,
        Boolean addMessagingEndUser
    ) {
        Flow.Interview queueProvisioningFlow = Flow.Interview.createInterview(
            PACKAGE_NAMESPACE,
            QUEUE_PROVISION_FLOW_API_NAME,
            new Map<String, Object>{
                'queueDeveloperName' => queueDeveloperName,
                'queueLabel' => queueLabel,
                'routingConfigId' => String.valueOf(routingConfigId),
                'addMessagingSession' => addMessagingSession,
                'addMessagingEndUser' => addMessagingEndUser
            }
        );
        queueProvisioningFlow.start();
    }

    public class ProvisioningException extends Exception {}
}
