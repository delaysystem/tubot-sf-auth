/**
 * @description Simple Setup final step: registers the channel with Panel
 * through the packaged prepare + connect flow (no secrets cross this path:
 * Panel mints with the packaged universal execution client and verifies the
 * subscriber-configured Run As user during registration), then blind-verifies
 * the end state (Panel listing, local record) before reporting.
 */
public with sharing class SimpleSetupFinalizeStep {
    public class FinalizeException extends Exception {
    }

    /**
     * @description Prepare the local channel record (DML). Must run in its own
     * transaction: callouts are illegal after DML, so registration follows as
     * a separate step.
     */
    public static Map<String, Object> prepareChannel(String channelId, String userId) {
        requirePanelConnection();
        PanelSalesforceChannelPreparationService.prepare(channelId, userId);
        return new Map<String, Object>{
            'status' => 'done',
            'message' => 'Channel prepared for registration.'
        };
    }

    /**
     * @description Run registration + verification for a prepared channel.
     * Callouts only: no DML precedes them in this transaction.
     */
    public static Map<String, Object> registerAndVerify(String channelId, String userId) {
        requirePanelConnection();
        PanelSalesforceChannelConnectService.connect(JSON.serialize(new Map<String, Object>{
            'channelId' => channelId,
            'integrationUserId' => userId
        }));
        Map<String, Object> verification = blindVerify(channelId, userId);
        return new Map<String, Object>{
            'status' => 'done',
            'message' => 'Channel registered and verified end to end.',
            'verification' => verification
        };
    }

    private static void requirePanelConnection() {
        Map<String, Object> auth = PanelAuthController.getPanelAuthStatus();
        if (auth.get('isConnected') != true) {
            throw new FinalizeException(
                'Panel is not connected. Complete Panel sign-in first, then re-run Simple Setup.'
            );
        }
    }

    private static Map<String, Object> blindVerify(String channelId, String userId) {
        Map<String, Object> checks = new Map<String, Object>();
        HttpResponse listRes = PanelAuthSupportService.executePanelCallout(
            '/api/v1/salesforce/channels?orgId=' + UserInfo.getOrganizationId(), 'GET', null
        );
        Boolean listed = listRes.getStatusCode() == 200
            && listRes.getBody() != null && listRes.getBody().contains(channelId);
        checks.put('panelListing', listed);
        if (!listed) {
            throw new FinalizeException(
                'Panel does not list the registered channel (HTTP ' + listRes.getStatusCode() + ').'
            );
        }

        Integer recordCount = [
            SELECT COUNT() FROM Tubot_API_Channel__c
            WHERE Channel_Id__c = :channelId AND Integration_User_Id__c = :userId
            WITH USER_MODE
        ];
        checks.put('localRecord', recordCount > 0);
        if (recordCount < 1) {
            throw new FinalizeException('Local channel record is missing after registration.');
        }
        return checks;
    }
}
