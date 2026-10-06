/** Restores mappings and org-level messaging settings from a backup snapshot. */
public with sharing class MessagingBackupRestoreSettingsService {
    public static void restoreAgentSelectSettings(List<Object> snapshots, List<String> logs) {
        PanelAuthSupportService.requireSettingsAdmin();
        String activeTeam = activeTeamId();
        if (String.isBlank(activeTeam)) { return; }
        Map<String, Agentforce_Agent_Select__c> existing = Agentforce_Agent_Select__c.getAll();
        List<Agentforce_Agent_Select__c> pending = new List<Agentforce_Agent_Select__c>();
        for (Object value : snapshots) {
            addTenantMapping(new Map<String, Object>{
                'snapshot' => (Map<String, Object>) value, 'teamId' => activeTeam,
                'existing' => existing, 'pending' => pending
            });
        }
        if (!pending.isEmpty()) {
            // Agent_Id__c is a required custom field, so Salesforce does not allow
            // its edit permission to be granted through permission-set metadata.
            // Keep this elevated write behind the admin permission and active-team filter above.
            Database.upsert(pending, AccessLevel.SYSTEM_MODE);
            logs.add('Restored ' + pending.size() + ' Agent Select mappings for the connected Panel team.');
        }
    }

    private static String activeTeamId() {
        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        return config == null ? null : config.Panel_Team_Id__c;
    }

    private static void addTenantMapping(Map<String, Object> context) {
        Map<String, Object> snapshot = (Map<String, Object>) context.get('snapshot');
        String activeTeam = (String) context.get('teamId');
        Map<String, Agentforce_Agent_Select__c> existing = (Map<String, Agentforce_Agent_Select__c>) context.get('existing');
        List<Agentforce_Agent_Select__c> pending = (List<Agentforce_Agent_Select__c>) context.get('pending');
        String name = (String) snapshot.get('name');
        if (String.isBlank(name) || snapshot.get('tenantId') != activeTeam) { return; }
        Agentforce_Agent_Select__c record = existing.get(name);
        if (record != null && String.isNotBlank(record.Tenant_Id__c) && record.Tenant_Id__c != activeTeam) {
            return;
        }
        if (record == null) { record = new Agentforce_Agent_Select__c(Name = name); }
        record.Agent_Id__c = (String) snapshot.get('agentId');
        record.Agent_Name__c = (String) snapshot.get('agentName');
        record.Deployment_Label__c = (String) snapshot.get('deploymentLabel');
        record.Tenant_Id__c = activeTeam;
        pending.add(record);
    }

    public static void restoreTubotSettings(Map<String, Object> snapshot, List<String> logs) {
        try {
            String request = JSON.serialize(new Map<String, String>{
                'fallbackQueueApiName' => (String) snapshot.get('fallbackQueueApiName'),
                'aiRouting' => (String) snapshot.get('aiRouting'),
                'queuesAndSkills' => (String) snapshot.get('queuesAndSkills'),
                'varFlowHuman' => (String) snapshot.get('varFlowHuman')
            });
            Map<String, Object> result = TubotSettingsMetadataService.saveSettings(request);
            if (result.get('success') != true) {
                throw new AuraHandledException('TuBot routing metadata could not be submitted for restoration.');
            }
            logs.add('Queued TuBot routing metadata restoration (job ' + result.get('jobId') + ').');
        } catch (Exception ex) {
            logs.add('TuBot settings restore failed: ' + ex.getMessage());
            throw ex;
        }
    }

    public static void restoreMessagingSettings(Map<String, Object> snapshot, List<String> logs) {
        try {
            Messaging_Config__c settings = loadMessagingSettings();
            applyMessagingSettings(settings, snapshot);
            Database.upsert(settings, AccessLevel.SYSTEM_MODE);
            logs.add('Restored messaging settings.');
        } catch (Exception ex) {
            logs.add('Messaging settings restore failed: ' + ex.getMessage());
            throw ex;
        }
    }

    private static Messaging_Config__c loadMessagingSettings() {
        Messaging_Config__c settings = Messaging_Config__c.getOrgDefaults();
        if (settings == null || settings.Id == null) {
            settings = new Messaging_Config__c(SetupOwnerId = UserInfo.getOrganizationId());
        }
        return settings;
    }

    private static void applyMessagingSettings(Messaging_Config__c settings, Map<String, Object> snapshot) {
        Map<String, String> fields = new Map<String, String>{
            'selectedChannelId' => 'Selected_Messaging_Channel_Id__c', 'targetGroupId' => 'Target_Group_Id__c',
            'useFlowRouting' => 'Use_Flow_Routing__c', 'autoQueueDetector' => 'Auto_Queue_Detector__c',
            'agentKeyword' => 'Agent_Keyword__c', 'reactivationKeyword' => 'Reactivation_Keyword__c',
            'detectJoinedAgent' => 'Detect_Joined_Agent__c', 'reminderEnabled' => 'Reminder_Enabled__c',
            'reminderTemplate' => 'Reminder_Message_Template__c', 'confirmationText' => 'Confirmation_Text__c',
            'disabledChannelIds' => 'Disabled_Channel_Ids__c'
        };
        for (String key : fields.keySet()) {
            if (snapshot.containsKey(key)) { settings.put(fields.get(key), snapshot.get(key)); }
        }
        if (snapshot.containsKey('reminderMinutes') && snapshot.get('reminderMinutes') != null) {
            settings.Reminder_Minutes__c = Decimal.valueOf(String.valueOf(snapshot.get('reminderMinutes')));
        }
    }
}
