/**
 * @description Simple Setup ECA step: detects the packaged universal
 * execution client (TuBot Channel API) and the subscriber-side JWT
 * pre-authorization permission set with plain SOQL (no REST, no sessions, no
 * callouts). The app ships in the package; the pre-auth membership is created
 * by the policies CLI command (admin's own CLI session, no secrets) because
 * managed components cannot carry ECA policies. Panel holds the JWT private
 * key and mints short-lived tokens only for pre-authorized users.
 */
public with sharing class SimpleSetupEcaStep {
    public static final String APP_NAME = 'Tubot_Channel_API';
    public static final String APP_LABEL = 'TuBot Channel API';
    public static final String PREAUTH_PERMISSION_SET = 'Tubot_JWT_PreAuth';
    public static final String SETUP_PATH = '/lightning/setup/ExternalClientApps/home';

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
        return [
            SELECT COUNT() FROM PermissionSet
            WHERE Name = :PREAUTH_PERMISSION_SET AND NamespacePrefix = null
            WITH USER_MODE
        ] > 0;
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
}
