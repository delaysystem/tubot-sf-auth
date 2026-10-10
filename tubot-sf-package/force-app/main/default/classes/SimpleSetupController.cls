/**
 * @description AuraEnabled entry points for Simple Setup: the guided,
 * session-free in-app replacement for the Python post-install wizard.
 * The UI calls runStep sequentially (user -> channel -> eca -> finalize ->
 * finalize-register). ECA preparation uses DML, followed by a separate
 * setup-scoped OAuth popup and outcome poll. The manual Setup UI path is
 * an alternative; final registration verifies the live JWT grant.
 * All methods require the settings-admin permission.
 */
public with sharing class SimpleSetupController {
    /** @description Separate transaction: no permission-set DML precedes this callout. */
    @AuraEnabled
    public static Map<String, Object> initiateEcaAuthorization() {
        return SimpleSetupEcaStep.initiate();
    }

    /** @description Polls only the non-sensitive setup outcome. */
    @AuraEnabled
    public static Map<String, Object> pollEcaAuthorization(String state) {
        return SimpleSetupEcaStep.outcome(state);
    }

    /** @description Manual and popup paths both verify the selected user's pre-auth membership. */
    @AuraEnabled
    public static Map<String, Object> checkEcaAuthorization(String userId) {
        PanelAuthSupportService.requireSettingsAdmin();
        return SimpleSetupEcaStep.checkMembership((Id) userId);
    }

    /**
     * @description Read-only preflight for the setup card: Panel connection,
     * existing channel, ECA presence, and the auto-selected integration user.
     * No callouts.
     */
    @AuraEnabled
    public static Map<String, Object> getStatus() {
        PanelAuthSupportService.requireSettingsAdmin();
        Map<String, Object> auth = PanelAuthController.getPanelAuthStatus();
        Map<String, Object> status = new Map<String, Object>{
            'orgId' => UserInfo.getOrganizationId(),
            'panelConnected' => auth.get('isConnected') == true,
            'channel' => SimpleSetupChannelStep.findExistingChannel(),
            'ecaAppName' => SimpleSetupEcaStep.APP_NAME,
            'ecaExists' => SimpleSetupEcaStep.ecaExists()
        };
        try {
            status.put('candidate', SimpleSetupInput.selectIntegrationUser());
        } catch (Exception e) {
            status.put('candidate', null);
            status.put('candidateError', e.getMessage());
        }
        return status;
    }

    /**
     * @description Execute one setup step. Returns status done|failed (plus
     * action-required for the ECA CLI handoff) with message/detail and
     * optional state for the next call. All failures are returned (never
     * thrown) so the UI can render per-step progress.
     */
    @AuraEnabled
    public static Map<String, Object> runStep(String step, Map<String, Object> state) {
        Map<String, Object> input = state == null ? new Map<String, Object>() : state;
        try {
            if (!PanelAuthSupportService.checkManageTubotPermission()) {
                return SimpleSetupInput.failed(
                    'You do not have permission to run setup (TuBot settings admin required).'
                );
            }
            if (step == 'user') { return SimpleSetupStepRunner.runUserStep(input); }
            if (step == 'channel') { return SimpleSetupStepRunner.runChannelStep(input); }
            if (step == 'eca') { return SimpleSetupStepRunner.runEcaStep(input); }
            if (step == 'finalize') { return SimpleSetupStepRunner.runFinalizeStep(input); }
            if (step == 'finalize-register') { return SimpleSetupStepRunner.runFinalizeRegisterStep(input); }
            return SimpleSetupInput.failed('Unknown setup step: ' + step + '.');
        } catch (AuraHandledException aura) {
            // Deliberately rethrown: the framework delivers its message to the
            // LWC verbatim (err.body.message), which is how service
            // validations (Panel errors, permission propagation) surface
            // precisely. Mapping it here can only replace the real message
            // with a generic one, because getMessage() is opaque server-side
            // ('Script-thrown exception').
            throw aura;
        } catch (Exception e) {
            return SimpleSetupInput.failed(friendlyError(e));
        }
    }

    private static String friendlyError(Exception e) {
        String message = e.getMessage();
        if (message != null
            && (message.contains('Panel is not connected')
                || message.contains('pre-authorization')
                || message.contains('Messaging'))) {
            return message;
        }
        return 'Setup step failed: ' + message;
    }
}
