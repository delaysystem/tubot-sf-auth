/** SettingsCaptureService for messaging configuration backups. */
public with sharing class MessagingBackupSettingsCaptureService {
    public static Map<String, Object> captureSettings(List<String> logs) {
        Map<String, Object> res = new Map<String, Object>();
        try {
            Map<String, Object> tSettings = TubotSettingsMetadataService.getSettings();
            if (tSettings != null && tSettings.containsKey('settings')) {
                res.put('tubotSettings', tSettings.get('settings'));
            } else if (tSettings != null) {
                res.put('tubotSettings', tSettings);
            }

            Messaging_Config__c mc = Messaging_Config__c.getOrgDefaults();
            if (mc != null) {
                res.put('messagingConfig', new Map<String, Object>{
                    'selectedChannelId' => mc.Selected_Messaging_Channel_Id__c,
                    'targetGroupId' => mc.Target_Group_Id__c,
                    'useFlowRouting' => mc.Use_Flow_Routing__c,
                    'autoQueueDetector' => mc.Auto_Queue_Detector__c,
                    'agentKeyword' => mc.Agent_Keyword__c,
                    'reactivationKeyword' => mc.Reactivation_Keyword__c,
                    'detectJoinedAgent' => mc.Detect_Joined_Agent__c,
                    'reminderEnabled' => mc.Reminder_Enabled__c,
                    'reminderMinutes' => mc.Reminder_Minutes__c,
                    'reminderTemplate' => mc.Reminder_Message_Template__c,
                    'confirmationText' => mc.Confirmation_Text__c,
                    'disabledChannelIds' => mc.Disabled_Channel_Ids__c
                });
            }
        } catch (Exception ex) {
            logs.add('  Settings capture note: ' + ex.getMessage());
        }
        return res;
    }

    // =========================================================================
    // RESTORE HELPERS
    // =========================================================================
}
