/** Shared access checks, org configuration access, and named credential callouts for Panel APIs. */
public with sharing class PanelAuthSupportService {
    public static final String DEFAULT_PANEL_URL = 'https://panel.tubot.lat';
    public static final String DEFAULT_CLIENT_ID = 'pnl_client_salesforce_mcp';
    public static final String EXTERNAL_AUTH_NAME = 'Panel_External_Credential';
    public static final String NAMED_AUTH_ALIAS = 'Panel_Named_Credential';
    public static final String PRINCIPAL_NAME = 'Panel_Principal';

    // Test-only simulation of the settings-admin grant. FeatureManagement
    // ignores permission grants made inside test context, so authorized-path
    // tests set this instead. Test.isRunningTest guard: unreachable outside
    // test execution, production behavior unchanged.
    @TestVisible
    private static Boolean managePermissionTestOverride;

    public static String getNamespacePrefix() {
        String clsName = PanelAuthSupportService.class.getName();
        if (clsName.contains('.')) {
            return clsName.substringBefore('.') + '__';
        }
        return '';
    }

    public static String getExternalCredentialName() {
        String ns = getNamespacePrefix();
        return String.isNotBlank(ns) ? ns + EXTERNAL_AUTH_NAME : EXTERNAL_AUTH_NAME;
    }

    public static String getNamedCredentialName() {
        String ns = getNamespacePrefix();
        return String.isNotBlank(ns) ? ns + NAMED_AUTH_ALIAS : NAMED_AUTH_ALIAS;
    }

    public static MCP_Config__c getConfig() {
        requireSettingsAdmin();
        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        return config == null ? new MCP_Config__c() : config;
    }

    public static HttpResponse executePanelCallout(String path, String method, String body) {
        return executePanelCallout(new Map<String, Object>{
            'path' => path, 'method' => method, 'body' => body, 'timeoutMs' => 20000
        });
    }

    public static HttpResponse executePanelCalloutWithTimeout(String requestJson) {
        return executePanelCallout((Map<String, Object>) JSON.deserializeUntyped(requestJson));
    }

    private static HttpResponse executePanelCallout(Map<String, Object> input) {
        requireSettingsAdmin();
        String path = (String) input.get('path');
        String method = (String) input.get('method');
        String body = (String) input.get('body');
        Integer timeoutMs = input.get('timeoutMs') == null ? 20000 : Integer.valueOf(String.valueOf(input.get('timeoutMs')));
        if (String.isBlank(path) || !path.startsWith('/') || String.isBlank(method)) {
            throw new AuraHandledException('A valid Panel API path and HTTP method are required.');
        }

        List<String> targetAliases = new List<String>();
        String qualified = getNamedCredentialName();
        targetAliases.add(qualified);
        if (qualified != NAMED_AUTH_ALIAS) {
            targetAliases.add(NAMED_AUTH_ALIAS);
        }

        CalloutException lastException;
        for (String alias : targetAliases) {
            try {
                HttpRequest request = new HttpRequest();
                request.setMethod(method);
                request.setTimeout(timeoutMs != null && timeoutMs > 0 ? timeoutMs : 20000);
                if (String.isNotBlank(body)) {
                    request.setHeader('Content-Type', 'application/json');
                    request.setBody(body);
                }
                request.setEndpoint('callout:' + alias + path);
                return new Http().send(request);
            } catch (CalloutException e) {
                lastException = e;
            }
        }
        if (lastException != null) {
            throw lastException;
        }
        return null;
    }

    public static Boolean checkManageTubotPermission() {
        if (Test.isRunningTest() && managePermissionTestOverride != null) {
            return managePermissionTestOverride;
        }
        String ns = getNamespacePrefix();
        String qualified = String.isNotBlank(ns) ? ns + 'Manage_Tubot_API_Connections' : 'Manage_Tubot_API_Connections';
        return FeatureManagement.checkPermission(qualified) || FeatureManagement.checkPermission('Manage_Tubot_API_Connections');
    }

    public static void requireSettingsAdmin() {
        if (!checkManageTubotPermission()) {
            throw new AuraHandledException('You do not have permission to manage TuBot package settings.');
        }
    }
}
