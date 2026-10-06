/**
 * @description Autonomous service orchestrating operational routing queues, agent provisioning,
 * Omni-Channel presence access, and permission assignments for Embedded Messaging.
 */
public with sharing class OmniChannelSetupService {

    public class SetupResult {
        @AuraEnabled public Boolean success;
        @AuraEnabled public String message;
        @AuraEnabled public String userId;
        @AuraEnabled public String username;
        @AuraEnabled public String userEmail;
        @AuraEnabled public String queueId;
        @AuraEnabled public String queueDevName;
        @AuraEnabled public String permissionSetId;
        @AuraEnabled public String presenceStatusId;
        @AuraEnabled public List<String> logs;

        public SetupResult() {
            this.success = false;
            this.logs = new List<String>();
        }
    }

    /**
     * @description Resolves multiple users given a comma- or semicolon-separated identifier string.
     * Supports matching by Full Name, Username, Email, 15/18-character Id, or 'default'/'current'.
     */
    public static List<User> resolveTargetUsers(String userIdentifiers) {
        return TargetSalesforceUserResolver.resolve(userIdentifiers);
    }

    /**
     * @description Resolves a single user (backward-compatible).
     */
    public static User resolveTargetUser(String userIdentifier) {
        List<User> users = resolveTargetUsers(userIdentifier);
        return users[0];
    }

    /**
     * @description Creates or resolves an operational routing queue and binds it to MessagingSession.
     */
    public static Group setupMessagingQueue(String queueDevName, String queueLabel, List<String> logs) {
        OmniChannelQueueSetupService.QueueSetupRequest request = new OmniChannelQueueSetupService.QueueSetupRequest();
        request.queueDeveloperName = queueDevName;
        request.queueLabel = queueLabel;
        request.routingConfigDeveloperName = 'Chat_Routing_Config';
        request.logs = logs;
        return OmniChannelQueueSetupService.setup(request);
    }

    /**
     * @description Provisions multiple agents: adds users to Queue, creates PermissionSet,
     * links ServicePresenceStatus via SetupEntityAccess, and assigns PermissionSet to each user.
     */
    public static SetupResult provisionAgentUsers(OmniChannelAgentProvisioningService.ProvisionRequest request) {
        return OmniChannelAgentProvisioningService.provision(request);
    }

    /**
     * @description Provisions a single agent (backward-compatible).
     */
    public static SetupResult provisionAgentUser(OmniChannelAgentProvisioningService.ProvisionRequest request) {
        if (request == null || request.targetUsers == null || request.targetUsers.size() != 1) {
            throw new IllegalArgumentException('Exactly one target user is required for single-agent provisioning.');
        }
        return OmniChannelAgentProvisioningService.provision(request);
    }

    /**
     * @description Complete end-to-end setup orchestration method.
     */
    @AuraEnabled
    public static SetupResult setupOmniChannelEndToEnd(Map<String, String> config) {
        TubotPackageFeatureGate.reject('Omni-Channel setup');
        requireSettingsAdmin();
        return new SetupResult();
    }

    private static SetupResult setupOmniChannelForExternalCli(Map<String, String> config) {
        Map<String, String> settings = new Map<String, String>{
            'queueDevName' => 'Chat_Queue',
            'queueLabel' => 'Chat Queue',
            'routingConfigDevName' => 'Chat_Routing_Config',
            'userIdentifier' => 'default',
            'presenceStatusDevName' => 'Available_Messaging',
            'permSetDevName' => 'Omni_Channel_Messaging_Agent',
            'permSetLabel' => 'Omni-Channel Messaging Agent'
        };
        if (config != null) {
            settings.putAll(config);
        }

        String queueDevName = settings.get('queueDevName');
        String queueLabel = settings.get('queueLabel');
        String routingConfigDevName = settings.get('routingConfigDevName');
        String userIdentifier = settings.get('userIdentifier');
        String presenceStatusDevName = settings.get('presenceStatusDevName');
        String permSetDevName = settings.get('permSetDevName');
        String permSetLabel = settings.get('permSetLabel');

        List<String> logs = new List<String>();
        SetupResult result = new SetupResult();

        try {
            logs.add('Starting Omni-Channel setup with target agent(s): ' + userIdentifier);
            List<User> targetUsers = resolveTargetUsers(userIdentifier);
            logs.add('Resolved ' + targetUsers.size() + ' target agent(s)');

            OmniChannelQueueSetupService.QueueSetupRequest queueRequest = new OmniChannelQueueSetupService.QueueSetupRequest();
            queueRequest.queueDeveloperName = queueDevName;
            queueRequest.queueLabel = queueLabel;
            queueRequest.routingConfigDeveloperName = routingConfigDevName;
            queueRequest.logs = logs;
            Group queueGrp = OmniChannelQueueSetupService.setup(queueRequest);

            OmniChannelAgentProvisioningService.ProvisionRequest provisionRequest = new OmniChannelAgentProvisioningService.ProvisionRequest();
            provisionRequest.queue = queueGrp;
            provisionRequest.targetUsers = targetUsers;
            provisionRequest.presenceStatusDeveloperName = presenceStatusDevName;
            provisionRequest.permissionSetDeveloperName = permSetDevName;
            provisionRequest.permissionSetLabel = permSetLabel;
            provisionRequest.logs = logs;
            result = OmniChannelAgentProvisioningService.provision(provisionRequest);
        } catch (Exception ex) {
            result.success = false;
            result.message = 'Error executing Omni-Channel setup: ' + ex.getMessage();
            logs.add('ERROR: ' + ex.getMessage() + '\n' + ex.getStackTraceString());
            result.logs = logs;
        }

        return result;
    }

    /**
     * @description Helper invoked via `sf apex run` to return structured JSON output to CLI scripts.
     */
    public static SetupResult executeSetupScript(String jsonConfig) {
        requireSettingsAdmin();
        Map<String, String> config = new Map<String, String>();
        if (String.isNotBlank(jsonConfig)) {
            try {
                Map<String, Object> raw = (Map<String, Object>) JSON.deserializeUntyped(jsonConfig);
                for (String key : raw.keySet()) {
                    config.put(key, String.valueOf(raw.get(key)));
                }
            } catch (Exception e) {
                System.debug('JSON config parse note: ' + e.getMessage());
            }
        }
        SetupResult res = setupOmniChannelForExternalCli(config);
        System.debug('<<<OMNI_SETUP_RESULT>>>' + JSON.serialize(res) + '<<<END_OMNI_SETUP_RESULT>>>');
        return res;
    }

    private static void requireSettingsAdmin() {
        PanelAuthSupportService.requireSettingsAdmin();
    }
}
