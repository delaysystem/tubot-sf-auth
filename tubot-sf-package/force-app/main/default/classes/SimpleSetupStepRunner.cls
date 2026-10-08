/**
 * @description Executes Simple Setup steps (user -> channel -> eca ->
 * finalize -> finalize-register). Split from SimpleSetupController so each
 * class stays under the complexity budget. All failures are returned as
 * failed maps (never thrown) so the UI can render per-step progress.
 */
public with sharing class SimpleSetupStepRunner {
    // Step 1: honor the UI-selected integration user when present, else
    // auto-select; then assign the API permission set.
    public static Map<String, Object> runUserStep(Map<String, Object> input) {
        Map<String, Object> candidate = SimpleSetupInput.resolveSelectedUser(input);
        if (candidate == null) {
            return SimpleSetupInput.failed('Selected integration user is no longer available. Pick another user and retry.');
        }
        Map<String, Object> assigned =
            TubotSetupWizardController.assignApiPermissionSet((String) candidate.get('id'));
        if (assigned == null || assigned.get('success') != true) {
            return SimpleSetupInput.failed('Permission assignment did not report success for '
                + String.valueOf(candidate.get('username')) + '.');
        }
        return new Map<String, Object>{
            'status' => 'done',
            'message' => 'Integration user ' + String.valueOf(candidate.get('username'))
                + ' confirmed with API access.',
            'user' => candidate
        };
    }

    // Step 2: honor the UI-selected channel when present, else select the
    // existing channel or create the channel/queue pair with DML.
    public static Map<String, Object> runChannelStep(Map<String, Object> input) {
        Map<String, Object> seed = SimpleSetupInput.asMap(input.get('channel'));
        String requestedId = seed == null ? null : SimpleSetupInput.stringValue(seed.get('id'));
        if (!String.isBlank(requestedId)) {
            try {
                Id validated = (Id) requestedId;
                Map<String, Object> selected = SimpleSetupChannelStep.ensureActive(
                    String.valueOf(validated)
                );
                return new Map<String, Object>{
                    'status' => 'done',
                    'message' => 'Using selected channel ' + String.valueOf(selected.get('label')) + '.',
                    'channel' => selected,
                    'created' => false
                };
            } catch (SimpleSetupChannelStep.ChannelStepException e) {
                return SimpleSetupInput.failed('Selected messaging channel is no longer available. Pick another channel and retry.');
            } catch (Exception e) {
                return SimpleSetupInput.failed('Selected messaging channel ID is invalid.');
            }
        }
        Map<String, Object> existing = SimpleSetupChannelStep.findExistingChannel();
        if (existing != null) {
            Map<String, Object> channel = SimpleSetupChannelStep.ensureActive(
                (String) existing.get('id')
            );
            return new Map<String, Object>{
                'status' => 'done',
                'message' => 'Using existing channel ' + String.valueOf(channel.get('label')) + '.',
                'channel' => channel,
                'created' => false
            };
        }
        Map<String, Object> user = SimpleSetupInput.requireUser(input);
        if (user == null) {
            return SimpleSetupInput.failed('Select the integration user step first: channel creation needs it.');
        }
        try {
            SimpleSetupChannelStep.ChannelSpec spec = new SimpleSetupChannelStep.ChannelSpec();
            spec.channelName = SimpleSetupChannelStep.DEFAULT_CHANNEL_NAME;
            spec.channelLabel = SimpleSetupChannelStep.DEFAULT_CHANNEL_LABEL;
            spec.queueName = SimpleSetupChannelStep.DEFAULT_QUEUE_NAME;
            spec.queueLabel = SimpleSetupChannelStep.DEFAULT_QUEUE_LABEL;
            spec.userId = (Id) user.get('id');
            Map<String, Object> channel = SimpleSetupChannelStep.createChannelWithQueue(spec);
            return new Map<String, Object>{
                'status' => 'done',
                'message' => 'Channel ' + String.valueOf(channel.get('label')) + ' created and verified.',
                'channel' => channel,
                'created' => true
            };
        } catch (SimpleSetupChannelStep.ChannelStepException e) {
            return SimpleSetupInput.failed(e.getMessage());
        }
    }

    // Step 3: confirm the packaged execution client is installed and the
    // subscriber pre-authorization exists (SOQL). When the pre-auth setup is
    // missing, stop with the exact policies CLI command; re-running setup
    // resumes after it (the user step then picks up the pre-auth assignment).
    public static Map<String, Object> runEcaStep(Map<String, Object> input) {
        if (!SimpleSetupEcaStep.ecaExists()) {
            return SimpleSetupInput.failed('The packaged execution client is missing. Reinstall or upgrade the TuBot package, then re-run Simple Setup.');
        }
        if (!SimpleSetupEcaStep.preAuthExists()) {
            return new Map<String, Object>{
                'status' => 'action-required',
                'message' => 'Subscriber pre-authorization is not configured yet. '
                    + 'Run the policies command below (it uses your own authenticated session), '
                    + 'then re-run Simple Setup.',
                'eca' => SimpleSetupEcaStep.getPoliciesGuidance()
            };
        }
        return new Map<String, Object>{
            'status' => 'done',
            'message' => 'Packaged execution client installed and pre-authorized.',
            'ecaExists' => true
        };
    }

    // Step 4a: prepare the local channel record (DML). Runs in its own
    // transaction: callouts are illegal after DML, so registration follows
    // as a separate step.
    public static Map<String, Object> runFinalizeStep(Map<String, Object> input) {
        Map<String, String> ids = requireChannelAndUser(input);
        if (ids == null) {
            return SimpleSetupInput.failed('Finalize needs the channel and integration user step results first.');
        }
        return SimpleSetupFinalizeStep.prepareChannel(ids.get('channelId'), ids.get('userId'));
    }

    // Step 4b: register with Panel (Panel mints with the packaged execution
    // client and verifies the Run As mapping), then blind-verify.
    // Callouts only: no DML precedes them in this transaction.
    public static Map<String, Object> runFinalizeRegisterStep(Map<String, Object> input) {
        Map<String, String> ids = requireChannelAndUser(input);
        if (ids == null) {
            return SimpleSetupInput.failed('Finalize needs the channel and integration user step results first.');
        }
        return SimpleSetupFinalizeStep.registerAndVerify(ids.get('channelId'), ids.get('userId'));
    }

    private static Map<String, String> requireChannelAndUser(Map<String, Object> input) {
        Map<String, Object> channel = SimpleSetupInput.asMap(input.get('channel'));
        Map<String, Object> user = SimpleSetupInput.requireUser(input);
        String channelId = channel == null ? null : SimpleSetupInput.stringValue(channel.get('id'));
        String userId = user == null ? null : SimpleSetupInput.stringValue(user.get('id'));
        if (String.isBlank(channelId) || String.isBlank(userId)) {
            return null;
        }
        return new Map<String, String>{ 'channelId' => channelId, 'userId' => userId };
    }

}
