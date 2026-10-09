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
    private static final Map<String, Type> STEP_HANDLERS = new Map<String, Type>{
        'user' => UserStepHandler.class,
        'channel' => ChannelStepHandler.class,
        'eca' => EcaStepHandler.class,
        'finalize' => FinalizeStepHandler.class,
        'finalize-register' => FinalizeRegisterStepHandler.class
    };

    private interface StepHandler {
        Map<String, Object> run(Map<String, Object> input);
    }

    private class UserStepHandler implements StepHandler {
        public Map<String, Object> run(Map<String, Object> input) { return SimpleSetupStepRunner.runUserStep(input); }
    }
    private class ChannelStepHandler implements StepHandler {
        public Map<String, Object> run(Map<String, Object> input) { return SimpleSetupStepRunner.runChannelStep(input); }
    }
    private class EcaStepHandler implements StepHandler {
        public Map<String, Object> run(Map<String, Object> input) { return SimpleSetupStepRunner.runEcaStep(input); }
    }
    private class FinalizeStepHandler implements StepHandler {
        public Map<String, Object> run(Map<String, Object> input) { return SimpleSetupStepRunner.runFinalizeStep(input); }
    }
    private class FinalizeRegisterStepHandler implements StepHandler {
        public Map<String, Object> run(Map<String, Object> input) { return SimpleSetupStepRunner.runFinalizeRegisterStep(input); }
    }

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
                return failed(
                    'You do not have permission to run setup (TuBot settings admin required).'
                );
            }
            Type handlerType = STEP_HANDLERS.get(step);
            if (handlerType == null) {
                return failed('Unknown setup step: ' + step + '.');
            }
            StepHandler handler = (StepHandler) handlerType.newInstance();
            return handler.run(input);
        } catch (AuraHandledException aura) {
            // Deliberately rethrown: the framework delivers its message to the
            // LWC verbatim (err.body.message), which is how service
            // validations (Panel errors, permission propagation) surface
            // precisely. Mapping it here can only replace the real message
            // with a generic one, because getMessage() is opaque server-side
            // ('Script-thrown exception').
            throw aura;
        } catch (Exception e) {
            return failed(friendlyError(e));
        }
    }

    private static Map<String, Object> failed(String message) {
        return new Map<String, Object>{ 'status' => 'failed', 'message' => message };
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
