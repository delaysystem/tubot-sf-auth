/** Shared access checks, org configuration access, and named credential callouts for Panel APIs. */
public with sharing class PanelAuthSupportService {
    public static final String DEFAULT_PANEL_URL = 'https://panel.tubot.lat';
    public static final String DEFAULT_CLIENT_ID = 'pnl_client_salesforce_mcp';
    public static final String EXTERNAL_AUTH_NAME = 'Panel_External_Credential';
    public static final String NAMED_AUTH_ALIAS = 'Panel_Named_Credential';
    public static final String PRINCIPAL_NAME = 'Panel_Principal';
    private static Integer panelCalloutsCompleted = 0;
    private static final String SETTINGS_ADMIN_PERMISSION_SET = 'Panel_Settings_Admin_Access';

    // Test-only seam for existing Apex tests. Production authorization below
    // checks the current user's actual assignment to the packaged permission set.
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
        return qualifyName(getExternalCredentialApiName());
    }

    public static String getExternalCredentialApiName() {
        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        Panel_Environment__mdt environment = PanelEnvironmentResolver.resolve(config);
        return environment.External_Credential__c;
    }

    public static String getNamedCredentialName() {
        return qualifyName(getNamedCredentialApiName());
    }

    public static String getNamedCredentialApiName() {
        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        return PanelEnvironmentResolver.resolve(config).Named_Credential__c;
    }

    public static String getRefreshNamedCredentialName() {
        return qualifyName(getRefreshNamedCredentialApiName());
    }

    public static String getRefreshNamedCredentialApiName() {
        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        return PanelEnvironmentResolver.resolve(config).Refresh_Named_Credential__c;
    }

    public static String getRefreshExternalCredentialName() {
        return qualifyName(getRefreshExternalCredentialApiName());
    }

    public static String getRefreshExternalCredentialApiName() {
        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        Panel_Environment__mdt environment = PanelEnvironmentResolver.resolve(config);
        return environment.Refresh_External_Credential__c;
    }

    public static String getPanelBaseUrl() {
        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        return PanelEnvironmentResolver.panelBaseUrl(config);
    }

    private static String qualifyName(String baseName) {
        String namespace = getNamespacePrefix();
        return String.isNotBlank(namespace) ? namespace + baseName : baseName;
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
        String apiName = getNamedCredentialApiName();
        String qualified = qualifyName(apiName);
        targetAliases.add(qualified);
        if (qualified != apiName) {
            targetAliases.add(apiName);
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
                HttpResponse response = new Http().send(request);
                if (response.getStatusCode() == 401 && response.getHeader('WWW-Authenticate') == 'Bearer error="invalid_token"') {
                    // Retry a whole UI action only if no earlier Panel callout could have mutated remote state.
                    String marker = panelCalloutsCompleted == 0 ? 'PANEL_REFRESH_REQUIRED' : 'PANEL_REAUTH_REQUIRED';
                    String message = marker + ': Refresh the Panel session in a separate transaction.';
                    AuraHandledException renewal = new AuraHandledException(message);
                    renewal.setMessage(message);
                    throw renewal;
                }
                panelCalloutsCompleted++;
                return response;
            } catch (CalloutException e) {
                lastException = e;
            }
        }
        if (lastException != null) {
            throw mapCredentialAccessError(lastException);
        }
        return null;
    }

    // Platform credential-access failures mean the running user lacks the
    // External Credential principal grant. Point at the in-app repair instead
    // of surfacing only the raw platform text.
    private static CalloutException mapCredentialAccessError(CalloutException e) {
        String message = e.getMessage();
        if (message != null && message.contains('couldn\'t access the credential')) {
            return new CalloutException(
                message + ' Open Panel Settings and run "Repair Panel credential access", then retry.'
            );
        }
        return e;
    }

    public static Boolean checkManageTubotPermission() {
        if (Test.isRunningTest() && managePermissionTestOverride != null) {
            return managePermissionTestOverride;
        }
        return hasSettingsAdminPermissionSetAssignment();
    }

    /**
     * Returns true only for a user directly assigned the package's settings
     * permission set. A matching custom permission granted by some other
     * profile or permission set is not sufficient.
     */
    private static Boolean hasSettingsAdminPermissionSetAssignment() {
        String className = PanelAuthSupportService.class.getName();
        String namespace = className.contains('.') ? className.substringBefore('.') : null;
        String qualifiedName = String.isBlank(namespace)
            ? SETTINGS_ADMIN_PERMISSION_SET
            : namespace + '__' + SETTINGS_ADMIN_PERMISSION_SET;

        List<PermissionSet> candidates = [
            SELECT Id, NamespacePrefix
            FROM PermissionSet
            WHERE Name = :SETTINGS_ADMIN_PERMISSION_SET OR Name = :qualifiedName
            WITH SYSTEM_MODE
        ];
        Set<Id> packagePermissionSetIds = new Set<Id>();
        for (PermissionSet candidate : candidates) {
            Boolean isThisPackageSet = String.isBlank(namespace)
                ? String.isBlank(candidate.NamespacePrefix)
                : candidate.NamespacePrefix == namespace;
            if (isThisPackageSet) {
                packagePermissionSetIds.add(candidate.Id);
            }
        }
        if (packagePermissionSetIds.isEmpty()) {
            return false;
        }

        return [
            SELECT COUNT()
            FROM PermissionSetAssignment
            WHERE AssigneeId = :UserInfo.getUserId()
                AND PermissionSetId IN :packagePermissionSetIds
            WITH SYSTEM_MODE
        ] > 0;
    }

    public static void requireSettingsAdmin() {
        if (!checkManageTubotPermission()) {
            throw new AuraHandledException('You do not have permission to manage TuBot package settings.');
        }
    }
}
