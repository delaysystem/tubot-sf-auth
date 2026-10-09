/**
 * @description Simple Setup ECA step: detects the packaged universal
 * execution client (TuBot Channel API) and the subscriber-side JWT
 * pre-authorization permission set. Preparation uses DML; initiating and
 * polling the ephemeral Panel authorization run in separate transactions.
 */
public with sharing class SimpleSetupEcaStep {
    public static final String APP_NAME = 'Tubot_Channel_API';
    public static final String APP_LABEL = 'TuBot Channel API';
    public static final String PREAUTH_PERMISSION_SET = 'Tubot_JWT_PreAuth';
    public static final String SETUP_PATH = '/lightning/setup/ExternalClientApps/home';
    private static final String SETUP_ROUTE = '/api/v1/salesforce/setup-oauth';

    // Test seams: packaged-ECA and subscriber-permset rows depend on org
    // shape, so tests set these overrides explicitly.
    @TestVisible
    private static Boolean forceEcaExists;
    @TestVisible
    private static Boolean forcePreAuthExists;

    /** @description True when the packaged execution client is installed. */
    public static Boolean ecaExists() {
        if (Test.isRunningTest() && forceEcaExists != null) {
            return forceEcaExists;
        }
        return [
            SELECT COUNT() FROM ExternalClientApplication
            WHERE DeveloperName = :APP_NAME
            WITH USER_MODE
        ] > 0;
    }

    /** @description True when the subscriber pre-auth permset exists. */
    public static Boolean preAuthExists() {
        if (Test.isRunningTest() && forcePreAuthExists != null) {
            return forcePreAuthExists;
        }
        return !findPreAuthPermissionSets().isEmpty();
    }

    /** @description Creates subscriber pre-authorization and assigns the selected active user. DML only. */
    public static Map<String, Object> prepare(Id userId) {
        PanelAuthSupportService.requireSettingsAdmin();
        List<User> users = [SELECT Id FROM User WHERE Id = :userId AND IsActive = true WITH USER_MODE LIMIT 1];
        if (users.isEmpty()) {
            throw new AuraHandledException('Select an active integration user before authorizing the app.');
        }
        List<PermissionSet> sets = findPreAuthPermissionSets();
        Id permissionSetId;
        if (sets.isEmpty()) {
            PermissionSet preAuth = new PermissionSet(Name = PREAUTH_PERMISSION_SET, Label = 'Tubot JWT PreAuth');
            insert as user preAuth;
            permissionSetId = preAuth.Id;
        } else {
            permissionSetId = sets[0].Id;
        }
        List<PermissionSetAssignment> assignments = [
            SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = :userId AND PermissionSetId = :permissionSetId
            WITH USER_MODE LIMIT 1
        ];
        if (assignments.isEmpty()) {
            insert as user new PermissionSetAssignment(AssigneeId = userId, PermissionSetId = permissionSetId);
        }
        return new Map<String, Object>{
            'status' => 'popup-required',
            'message' => 'Pre-authorization membership prepared. Approve the policy change or use the manual steps.',
            'eca' => getPoliciesGuidance()
        };
    }

    /** @description Starts a setup-scoped authorization through the existing Panel Named Credential. Callout only. */
    public static Map<String, Object> initiate() {
        PanelAuthSupportService.requireSettingsAdmin();
        HttpResponse response = PanelAuthSupportService.executePanelCallout(SETUP_ROUTE, 'POST', JSON.serialize(new Map<String, Object>{
            'orgId' => UserInfo.getOrganizationId(), 'instanceUrl' => Url.getOrgDomainUrl().toExternalForm()
        }));
        Map<String, Object> result = PanelSelfOrgResponseParser.parse(response.getBody());
        String authorizationUrl = result.get('authorizationUrl') instanceof String ? (String) result.get('authorizationUrl') : null;
        String state = result.get('state') instanceof String ? (String) result.get('state') : null;
        if (response.getStatusCode() != 200 || !PanelSelfOrgResponseParser.isSalesforceAuthorizationUrl(authorizationUrl)
            || String.isBlank(state) || !Pattern.matches('setup_[A-Za-z0-9_-]{32,128}', state)) {
            throw new AuraHandledException('Could not start Salesforce setup authorization. Check Panel sign-in and retry, or use the manual steps.');
        }
        return new Map<String, Object>{ 'status' => 'done', 'authorizationUrl' => authorizationUrl, 'oauthState' => state };
    }

    /** @description Polls the tenant- and org-bound safe outcome; no Salesforce credential enters Apex. */
    public static Map<String, Object> outcome(String state) {
        PanelAuthSupportService.requireSettingsAdmin();
        if (String.isBlank(state) || !Pattern.matches('setup_[A-Za-z0-9_-]{32,128}', state)) {
            throw new AuraHandledException('Setup authorization is missing or expired. Retry authorization.');
        }
        HttpResponse response = PanelAuthSupportService.executePanelCallout(
            SETUP_ROUTE + '/status?orgId=' + UserInfo.getOrganizationId() + '&state=' + EncodingUtil.urlEncode(state, 'UTF-8'), 'GET', null
        );
        if (response.getStatusCode() != 200) {
            throw new AuraHandledException('Could not read the setup authorization outcome. Check Panel sign-in and retry.');
        }
        Map<String, Object> result = PanelSelfOrgResponseParser.parse(response.getBody());
        String status = result.get('status') instanceof String ? (String) result.get('status') : null;
        if (!new Set<String>{ 'pending', 'done', 'failed' }.contains(status)) {
            throw new AuraHandledException('The setup authorization service returned an invalid outcome. Retry authorization.');
        }
        return result;
    }

    /** @description Verifies membership locally. Final registration independently proves policy with a live JWT grant. */
    public static Map<String, Object> checkMembership(Id userId) {
        PanelAuthSupportService.requireSettingsAdmin();
        Set<Id> preAuthIds = new Set<Id>();
        for (PermissionSet preAuth : findPreAuthPermissionSets()) {
            preAuthIds.add(preAuth.Id);
        }
        Integer count = preAuthIds.isEmpty() ? 0 : [SELECT COUNT() FROM PermissionSetAssignment
            WHERE AssigneeId = :userId AND PermissionSetId IN :preAuthIds
            WITH USER_MODE];
        if (count != 1) {
            throw new AuraHandledException('Assign Tubot_JWT_PreAuth to the selected integration user, then re-check.');
        }
        return new Map<String, Object>{ 'status' => 'done', 'message' => 'Pre-authorization membership verified. Registration will verify the Salesforce policy with a live JWT grant.' };
    }

    /**
     * @description Policies-command guidance for a missing pre-auth setup: the
     * exact CLI command plus the Setup console URL for manual review.
     */
    public static Map<String, Object> getPoliciesGuidance() {
        return new Map<String, Object>{
            'appName' => APP_NAME,
            'appLabel' => APP_LABEL,
            'cliCommand' => 'bun scripts/setup-eca-policies.mjs --target-org YOUR_ORG_ALIAS',
            'setupUrl' => Url.getOrgDomainUrl().toExternalForm() + SETUP_PATH
        };
    }

    private static List<PermissionSet> findPreAuthPermissionSets() {
        String className = SimpleSetupEcaStep.class.getName();
        String namespace = className.contains('.') ? className.substringBefore('.') : null;
        String qualifiedName = String.isBlank(namespace)
            ? PREAUTH_PERMISSION_SET
            : namespace + '__' + PREAUTH_PERMISSION_SET;
        List<PermissionSet> candidates = [
            SELECT Id, NamespacePrefix
            FROM PermissionSet
            WHERE Name = :PREAUTH_PERMISSION_SET OR Name = :qualifiedName
            WITH USER_MODE
        ];
        List<PermissionSet> matching = new List<PermissionSet>();
        for (PermissionSet candidate : candidates) {
            Boolean belongsToPackage = String.isBlank(namespace)
                ? String.isBlank(candidate.NamespacePrefix)
                : candidate.NamespacePrefix == namespace;
            if (belongsToPackage) {
                matching.add(candidate);
            }
        }
        return matching;
    }
}
