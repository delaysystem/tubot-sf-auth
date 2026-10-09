@IsTest
private class TubotExtraPostInstallProvisionerTest {
    @IsTest
    static void postInstallCreatesAndLinksRoutingRecords() {
        Test.testInstall(new TubotExtraPostInstallHandler(), null);

        Map<String, QueueRoutingConfig> configsByName = new Map<String, QueueRoutingConfig>();
        for (QueueRoutingConfig config : [
            SELECT Id, DeveloperName, MasterLabel, RoutingModel, RoutingPriority,
                CapacityWeight, IsAttributeBased, PushTimeout
            FROM QueueRoutingConfig
            WHERE DeveloperName IN ('Chat_Routing_Config', 'Holding_Routing_Config')
        ]) {
            configsByName.put(config.DeveloperName, config);
        }

        System.assertEquals(2, configsByName.size(), 'Both package routing configurations are created.');
        System.assertEquals('LeastActive', configsByName.get('Chat_Routing_Config').RoutingModel);
        System.assertEquals(1, configsByName.get('Chat_Routing_Config').RoutingPriority);
        System.assertEquals(20, configsByName.get('Chat_Routing_Config').PushTimeout);
        System.assertEquals(10, configsByName.get('Holding_Routing_Config').RoutingPriority);

        Skill skill = [
            SELECT Id, MasterLabel, Description
            FROM Skill
            WHERE DeveloperName = 'TuBot_On_Hold_DO_NOT_EDIT'
            LIMIT 1
        ];
        System.assertEquals('TuBot_On_Hold_DO_NOT_EDIT', skill.MasterLabel);
        System.assertEquals('tubot.lat', skill.Description);

        Map<String, Group> queuesByName = new Map<String, Group>();
        for (Group queue : [
            SELECT Id, Name, DeveloperName, QueueRoutingConfigId
            FROM Group
            WHERE Type = 'Queue'
                AND DeveloperName IN ('Chat_Queue', 'AI_Bot_Holding_Queue_100')
        ]) {
            queuesByName.put(queue.DeveloperName, queue);
        }

        System.assertEquals(2, queuesByName.size(), 'Both package queues are created.');
        System.assertEquals(
            configsByName.get('Chat_Routing_Config').Id,
            queuesByName.get('Chat_Queue').QueueRoutingConfigId
        );
        System.assertEquals(
            configsByName.get('Holding_Routing_Config').Id,
            queuesByName.get('AI_Bot_Holding_Queue_100').QueueRoutingConfigId
        );

        Set<Id> queueIds = new Set<Id>{
            queuesByName.get('Chat_Queue').Id,
            queuesByName.get('AI_Bot_Holding_Queue_100').Id
        };
        Set<String> memberships = new Set<String>();
        for (QueueSobject queueSobject : [
            SELECT QueueId, SobjectType
            FROM QueueSobject
            WHERE QueueId IN :queueIds
        ]) {
            memberships.add(String.valueOf(queueSobject.QueueId) + ':' + queueSobject.SobjectType);
        }
        System.assert(memberships.contains(String.valueOf(queuesByName.get('Chat_Queue').Id) + ':MessagingSession'));
        System.assert(memberships.contains(String.valueOf(queuesByName.get('AI_Bot_Holding_Queue_100').Id) + ':MessagingSession'));
        System.assert(memberships.contains(String.valueOf(queuesByName.get('AI_Bot_Holding_Queue_100').Id) + ':MessagingEndUser'));
    }

    @IsTest
    static void postInstallIsIdempotent() {
        TubotExtraPostInstallProvisioner.provision();
        TubotExtraPostInstallProvisioner.provision();

        System.assertEquals(1, [
            SELECT COUNT()
            FROM QueueRoutingConfig
            WHERE DeveloperName = 'Chat_Routing_Config'
        ]);
        System.assertEquals(1, [
            SELECT COUNT()
            FROM QueueRoutingConfig
            WHERE DeveloperName = 'Holding_Routing_Config'
        ]);
        System.assertEquals(1, [
            SELECT COUNT()
            FROM Skill
            WHERE DeveloperName = 'TuBot_On_Hold_DO_NOT_EDIT'
        ]);
        System.assertEquals(1, [
            SELECT COUNT()
            FROM Group
            WHERE Type = 'Queue' AND DeveloperName = 'Chat_Queue'
        ]);
        System.assertEquals(1, [
            SELECT COUNT()
            FROM Group
            WHERE Type = 'Queue' AND DeveloperName = 'AI_Bot_Holding_Queue_100'
        ]);
    }
}
