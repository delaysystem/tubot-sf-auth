/** Applies the package's initial Messaging_Config__c defaults. */
public with sharing class PackagePostInstallDefaultsService {
    public static Boolean applyMessagingDefaults(Messaging_Config__c config) {
        Boolean modified = false;
        Map<String, Object> defaults = messagingDefaults();
        for (String fieldName : defaults.keySet()) {
            if (isMissing(config.get(fieldName))) {
                config.put(fieldName, defaults.get(fieldName));
                modified = true;
            }
        }
        return modified;
    }

    private static Map<String, Object> messagingDefaults() {
        return new Map<String, Object>{
            'Selected_Messaging_Channel_Id__c' => 'ALL',
            'Agent_Keyword__c' => 'agent',
            'Confirmation_Text__c' => 'transmited notification',
            'Reactivation_Keyword__c' => 'reset',
            'Auto_Queue_Detector__c' => true,
            'Detect_Joined_Agent__c' => true,
            'Use_Flow_Routing__c' => false
        };
    }

    private static Boolean isMissing(Object value) {
        if (value == null) {
            return true;
        }
        return value instanceof String && String.isBlank((String) value);
    }
}
