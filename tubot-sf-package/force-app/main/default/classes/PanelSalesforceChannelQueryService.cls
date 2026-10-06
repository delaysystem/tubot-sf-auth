/** Loads Salesforce channel connections and their callable-tool proxy URLs. */
public with sharing class PanelSalesforceChannelQueryService {
    public static List<Map<String, String>> listConnections() {
        PanelSalesforceChannelSupportService.requireAdmin();
        String teamId = PanelAuthSupportService.getConfig().Panel_Team_Id__c;
        String path = '/api/v1/salesforce/channels?orgId=' + EncodingUtil.urlEncode(UserInfo.getOrganizationId(), 'UTF-8');
        HttpResponse response = PanelAuthSupportService.executePanelCallout(path, 'GET', null);
        if (response.getStatusCode() != 200) {
            throw PanelSalesforceChannelSupportService.newException(
                PanelSalesforceChannelSupportService.panelFailure(response, 'Loading Salesforce channel connections failed')
            );
        }
        Map<String, Map<String, Boolean>> remote = remoteUsers(response);
        return localConnections(teamId, remote);
    }

    public static List<String> getToolProxyList(String channelId) {
        PanelSalesforceChannelSupportService.requireAdmin();
        if (String.isBlank(channelId)) { throw PanelSalesforceChannelSupportService.newException('Enter a valid Salesforce channel ID.'); }
        String path = '/api/v1/salesforce/channels/' + EncodingUtil.urlEncode(channelId, 'UTF-8') + '/callable-tools';
        String body = JSON.serialize(new Map<String, Object>{ 'orgId' => UserInfo.getOrganizationId() });
        HttpResponse response = PanelAuthSupportService.executePanelCalloutWithTimeout(JSON.serialize(new Map<String, Object>{
            'path' => path, 'method' => 'POST', 'body' => body, 'timeoutMs' => 120000
        }));
        if (response.getStatusCode() != 200) {
            throw PanelSalesforceChannelSupportService.newException(
                PanelSalesforceChannelSupportService.panelFailure(response, 'Fetching callable tool proxy list failed')
            );
        }
        return proxyUrls((Map<String, Object>) JSON.deserializeUntyped(response.getBody()));
    }

    private static Map<String, Map<String, Boolean>> remoteUsers(HttpResponse response) {
        Map<String, Map<String, Boolean>> byChannel = new Map<String, Map<String, Boolean>>();
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
        List<Object> channels = (List<Object>) body.get('channels');
        if (channels == null) { return byChannel; }
        for (Object item : channels) { addRemoteChannel(byChannel, (Map<String, Object>) item); }
        return byChannel;
    }

    private static void addRemoteChannel(Map<String, Map<String, Boolean>> byChannel, Map<String, Object> channel) {
        String channelId = String.valueOf(channel.get('channelId'));
        Map<String, Boolean> users = new Map<String, Boolean>();
        List<Object> executions = (List<Object>) channel.get('executionUsers');
        if (executions != null) {
            for (Object item : executions) {
                Map<String, Object> execution = (Map<String, Object>) item;
                users.put(String.valueOf(execution.get('integrationUserId')), execution.get('isPrimary') == true);
            }
        }
        byChannel.put(channelId, users);
    }

    private static List<Map<String, String>> localConnections(String teamId, Map<String, Map<String, Boolean>> remote) {
        List<Map<String, String>> result = new List<Map<String, String>>();
        for (Tubot_API_Channel__c row : [
            SELECT Channel_Id__c, Integration_User_Id__c FROM Tubot_API_Channel__c
            WHERE Team_Id__c = :teamId WITH USER_MODE ORDER BY Channel_Id__c, CreatedDate
        ]) {
            Map<String, Boolean> users = remote.get(row.Channel_Id__c);
            Boolean active = users != null && users.containsKey(row.Integration_User_Id__c);
            result.add(new Map<String, String>{
                'channelId' => row.Channel_Id__c, 'integrationUserId' => row.Integration_User_Id__c,
                'isActive' => String.valueOf(active),
                'isPrimary' => String.valueOf(active && users.get(row.Integration_User_Id__c))
            });
        }
        return result;
    }

    private static List<String> proxyUrls(Map<String, Object> data) {
        List<Object> values = (List<Object>) data.get('urls');
        if (values == null) { values = (List<Object>) data.get('callableToolUrls'); }
        List<String> result = new List<String>();
        if (values != null) {
            for (Object value : values) { if (value != null) { result.add(String.valueOf(value)); } }
        }
        return result;
    }
}
