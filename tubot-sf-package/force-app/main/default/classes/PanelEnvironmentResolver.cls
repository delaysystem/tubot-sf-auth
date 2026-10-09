/** Resolves supported Panel and auth environments from protected package metadata. */
public with sharing class PanelEnvironmentResolver {
    public static final String PRODUCTION = 'production';
    public static final String STAGING = 'staging';

    public static String selectedKey(MCP_Config__c config) {
        return normalize(config == null ? null : config.Panel_Environment__c);
    }

    public static String normalize(String environment) {
        String key = String.isBlank(environment) ? PRODUCTION : environment.trim().toLowerCase();
        if (key != PRODUCTION && key != STAGING) {
            throw new AuraHandledException('Choose either the production or staging Panel environment.');
        }
        return key;
    }

    public static Panel_Environment__mdt resolve(MCP_Config__c config) {
        return resolve(selectedKey(config));
    }

    public static Panel_Environment__mdt resolve(String environment) {
        String key = normalize(environment);
        String developerName = key == STAGING ? 'Staging' : 'Production';
        Panel_Environment__mdt target = Panel_Environment__mdt.getInstance(developerName);
        if (target == null || String.isBlank(target.Panel_Base_URL__c) ||
            String.isBlank(target.Client_Id__c) || String.isBlank(target.Named_Credential__c) ||
            String.isBlank(target.Refresh_Named_Credential__c) ||
            String.isBlank(target.External_Credential__c) ||
            String.isBlank(target.Refresh_External_Credential__c) ||
            String.isBlank(target.Environment_Label__c) ||
            !isValidOrigin(target.Panel_Base_URL__c) ||
            !isApiName(target.Named_Credential__c) || !isApiName(target.Refresh_Named_Credential__c) ||
            !isApiName(target.External_Credential__c) || !isApiName(target.Refresh_External_Credential__c)) {
            throw new AuraHandledException('The selected Panel environment is not configured correctly.');
        }
        return target;
    }

    public static String panelBaseUrl(MCP_Config__c config) {
        return resolve(config).Panel_Base_URL__c.removeEnd('/');
    }

    private static Boolean isValidOrigin(String value) {
        try {
            Url parsed = new Url(value);
            return parsed.getProtocol() == 'https' && String.isNotBlank(parsed.getHost()) &&
                String.isBlank(parsed.getUserInfo()) && (parsed.getPort() == null || parsed.getPort() == -1) &&
                (String.isBlank(parsed.getPath()) || parsed.getPath() == '/') &&
                String.isBlank(parsed.getQuery()) && String.isBlank(parsed.getRef());
        } catch (Exception ex) {
            return false;
        }
    }

    private static Boolean isApiName(String value) {
        return Pattern.matches('[A-Za-z][A-Za-z0-9_]*', value);
    }
}
