/** Validates and normalizes a configured Panel HTTPS origin. */
public with sharing class PanelBaseUrlResolver {
    public static String resolve(MCP_Config__c config) {
        // Preserve legacy custom origins only for records created before the
        // environment selector existed. Explicit environment choices always
        // resolve through protected package metadata.
        if (config != null && String.isBlank(config.Panel_Environment__c) &&
            String.isNotBlank(config.Panel_Base_URL__c)) {
            return validateOrigin(config.Panel_Base_URL__c);
        }
        return PanelEnvironmentResolver.panelBaseUrl(config);
    }

    private static String validateOrigin(String baseUrl) {
        try {
            Url parsed = new Url(baseUrl);
            if (!isValidOrigin(parsed)) {
                throw new AuraHandledException('The configured Panel URL is invalid. Reconnect Panel and retry.');
            }
            return baseUrl.removeEnd('/');
        } catch (AuraHandledException ex) {
            throw ex;
        } catch (Exception ex) {
            throw new AuraHandledException('The configured Panel URL is invalid. Reconnect Panel and retry.');
        }
    }

    private static Boolean isValidOrigin(Url parsed) {
        return parsed.getProtocol() == 'https' && String.isNotBlank(parsed.getHost()) &&
            String.isBlank(parsed.getUserInfo()) && (parsed.getPort() == null || parsed.getPort() == -1) &&
            (String.isBlank(parsed.getPath()) || parsed.getPath() == '/');
    }
}
