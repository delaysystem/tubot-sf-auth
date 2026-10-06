/** OmniCaptureService for messaging configuration backups. */
public with sharing class MessagingBackupOmniCaptureService {
    public static List<Map<String, Object>> captureMessagingChannels(List<String> logs) {
        List<Map<String, Object>> channels = new List<Map<String, Object>>();
        try {
            Map<String, Schema.SObjectField> fields = Schema.SObjectType.MessagingChannel.fields.getMap();
            Boolean hasRoutingConfiguration = fields.containsKey('RoutingConfigurationId');
            String query = 'SELECT Id, DeveloperName, MasterLabel, MessageType, RoutingType, SessionHandlerId, FallbackQueueId, TargetQueueId, IsActive';
            if (hasRoutingConfiguration) { query += ', RoutingConfigurationId'; }
            query += ' FROM MessagingChannel ORDER BY DeveloperName ASC';

            for (SObject mc : Database.query(query, AccessLevel.USER_MODE)) {
                channels.add(new Map<String, Object>{
                    'id' => mc.get('Id'),
                    'developerName' => mc.get('DeveloperName'),
                    'masterLabel' => mc.get('MasterLabel'),
                    'messageType' => mc.get('MessageType'),
                    'routingType' => mc.get('RoutingType'),
                    'sessionHandlerId' => mc.get('SessionHandlerId'),
                    'fallbackQueueId' => mc.get('FallbackQueueId'),
                    'targetQueueId' => mc.get('TargetQueueId'),
                    'routingConfigurationId' => hasRoutingConfiguration ? mc.get('RoutingConfigurationId') : null,
                    'isActive' => mc.get('IsActive')
                });
            }
        } catch (Exception ex) {
            logs.add('  Channels capture note: ' + ex.getMessage());
        }
        return channels;
    }

    public static Map<String, Object> captureQueues(List<String> logs) {
        Map<String, Object> res = new Map<String, Object>();
        List<Map<String, Object>> queues = new List<Map<String, Object>>();
        List<Map<String, Object>> queueSobjs = new List<Map<String, Object>>();
        List<Map<String, Object>> members = new List<Map<String, Object>>();

        try {
            List<Group> qRecs = [
                SELECT Id, DeveloperName, Name, Type, Email, DoesSendEmailToMembers
                FROM Group
                WHERE Type = 'Queue'
                WITH USER_MODE ORDER BY DeveloperName ASC
            ];
            for (Group g : qRecs) {
                queues.add(new Map<String, Object>{
                    'id' => g.Id,
                    'developerName' => g.DeveloperName,
                    'name' => g.Name,
                    'type' => g.Type,
                    'email' => g.Email
                });
            }

            List<QueueSobject> qsRecs = [
                SELECT Id, QueueId, Queue.DeveloperName, SobjectType
                FROM QueueSobject
                WHERE SobjectType IN ('MessagingSession', 'LiveChatTranscript', 'Case') WITH USER_MODE
            ];
            for (QueueSobject qs : qsRecs) {
                queueSobjs.add(new Map<String, Object>{
                    'id' => qs.Id,
                    'queueId' => qs.QueueId,
                    'queueDevName' => qs.Queue != null ? qs.Queue.DeveloperName : null,
                    'sobjectType' => qs.SobjectType
                });
            }

            List<GroupMember> gmRecs = [
                SELECT Id, GroupId, Group.DeveloperName, UserOrGroupId
                FROM GroupMember
                WHERE Group.Type = 'Queue'
                WITH USER_MODE LIMIT 100
            ];
            for (GroupMember gm : gmRecs) {
                members.add(new Map<String, Object>{
                    'id' => gm.Id,
                    'groupId' => gm.GroupId,
                    'queueDevName' => gm.Group != null ? gm.Group.DeveloperName : null,
                    'userOrGroupId' => gm.UserOrGroupId
                });
            }
        } catch (Exception ex) {
            logs.add('  Queues capture note: ' + ex.getMessage());
        }

        res.put('queues', queues);
        res.put('queueSobjects', queueSobjs);
        res.put('groupMembers', members);
        return res;
    }

    public static Map<String, Object> captureSkills(List<String> logs) {
        Map<String, Object> res = new Map<String, Object>();
        List<Map<String, Object>> skills = new List<Map<String, Object>>();
        List<Map<String, Object>> skillUsers = new List<Map<String, Object>>();
        List<Map<String, Object>> routingConfigs = new List<Map<String, Object>>();

        try {
            Map<String, Schema.SObjectType> gd = Schema.getGlobalDescribe();

            if (findObjectType(gd, 'Skill') != null) {
                List<sObject> sRecs = Database.query('SELECT Id, DeveloperName, MasterLabel, Description FROM Skill LIMIT 100', AccessLevel.USER_MODE);
                for (sObject s : sRecs) {
                    skills.add(new Map<String, Object>{
                        'id' => (String) s.get('Id'),
                        'developerName' => (String) s.get('DeveloperName'),
                        'masterLabel' => (String) s.get('MasterLabel'),
                        'description' => (String) s.get('Description')
                    });
                }
            }

            if (findObjectType(gd, 'SkillUser') != null) {
                List<sObject> suRecs = Database.query('SELECT Id, SkillId, UserId, SkillLevel FROM SkillUser LIMIT 100', AccessLevel.USER_MODE);
                for (sObject su : suRecs) {
                    skillUsers.add(new Map<String, Object>{
                        'id' => (String) su.get('Id'),
                        'skillId' => (String) su.get('SkillId'),
                        'userId' => (String) su.get('UserId'),
                        'skillLevel' => su.get('SkillLevel')
                    });
                }
            }

            if (findObjectType(gd, 'QueueRoutingConfig') != null) {
                List<sObject> qrcRecs = Database.query('SELECT Id, DeveloperName, MasterLabel, RoutingModel, RoutingPriority, CapacityWeight FROM QueueRoutingConfig LIMIT 100', AccessLevel.USER_MODE);
                for (sObject qrc : qrcRecs) {
                    routingConfigs.add(new Map<String, Object>{
                        'id' => (String) qrc.get('Id'),
                        'developerName' => (String) qrc.get('DeveloperName'),
                        'masterLabel' => (String) qrc.get('MasterLabel'),
                        'routingModel' => (String) qrc.get('RoutingModel'),
                        'routingPriority' => qrc.get('RoutingPriority'),
                        'capacityWeight' => qrc.get('CapacityWeight')
                    });
                }
            }
        } catch (Exception ex) {
            logs.add('  Skills capture note: ' + ex.getMessage());
        }

        res.put('skills', skills);
        res.put('skillUsers', skillUsers);
        res.put('routingConfigs', routingConfigs);
        return res;
    }

    private static Schema.SObjectType findObjectType(Map<String, Schema.SObjectType> types, String apiName) {
        for (String candidate : types.keySet()) {
            if (candidate.equalsIgnoreCase(apiName)) { return types.get(candidate); }
        }
        return null;
    }

    public static List<Map<String, Object>> captureFlows(List<String> logs) {
        List<Map<String, Object>> flows = new List<Map<String, Object>>();
        try {
            Map<Id, FlowDefinitionView> flowMap = new Map<Id, FlowDefinitionView>();
            try {
                for (FlowDefinitionView f : [
                    SELECT Id, ApiName, Label, ActiveVersionId, LatestVersionId, IsActive, ProcessType
                    FROM FlowDefinitionView
                    WHERE ProcessType = 'RoutingFlow' WITH USER_MODE
                ]) {
                    flowMap.put(f.Id, f);
                }
            } catch (Exception ex1) {
                logs.add('  RoutingFlow query note: ' + ex1.getMessage());
            }

            try {
                for (FlowDefinitionView f : [
                    SELECT Id, ApiName, Label, ActiveVersionId, LatestVersionId, IsActive, ProcessType
                    FROM FlowDefinitionView
                    WHERE ApiName IN ('t2', 'OmniMessagingRoutingFlow', 't100', 'RouteWebChat', 'defaultFlowTuBot') WITH USER_MODE
                ]) {
                    flowMap.put(f.Id, f);
                }
            } catch (Exception ex2) {
                logs.add('  ApiName flow query note: ' + ex2.getMessage());
            }

            for (FlowDefinitionView f : flowMap.values()) {
                flows.add(new Map<String, Object>{
                    'id' => f.Id,
                    'apiName' => f.ApiName,
                    'label' => f.Label,
                    'activeVersionNumber' => f.VersionNumber,
                    'activeVersionId' => f.ActiveVersionId,
                    'latestVersionId' => f.LatestVersionId,
                    'isActive' => f.IsActive,
                    'processType' => f.ProcessType
                });
            }
        } catch (Exception ex) {
            logs.add('  Flows capture note: ' + ex.getMessage());
        }
        return flows;
    }
}
