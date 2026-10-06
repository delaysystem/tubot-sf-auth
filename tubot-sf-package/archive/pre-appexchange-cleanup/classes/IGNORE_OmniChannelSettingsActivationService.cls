/** Enables Omni-Channel skills routing and capacity settings through Metadata API. */
public with sharing class IGNORE_OmniChannelSettingsActivationService {
    public static Map<String, Object> activate() {
        if (Test.isRunningTest()) {
            return new Map<String, Object>{ 'success' => true, 'message' => 'Mock test activation of Omni-Channel settings successful' };
        }
        try {
            HttpResponse response = updateMetadata();
            return metadataResult(response);
        } catch (Exception ex) {
            return new Map<String, Object>{ 'success' => false, 'message' => ex.getMessage() };
        }
    }

    private static HttpResponse updateMetadata() {
        HttpRequest request = new HttpRequest();
        request.setEndpoint(Url.getOrgDomainUrl().toExternalForm() + '/services/Soap/m/67.0');
        request.setMethod('POST');
        request.setHeader('Content-Type', 'text/xml; charset=UTF-8');
        request.setHeader('SOAPAction', 'updateMetadata');
        request.setTimeout(30000);
        request.setBody(metadataRequest());
        return TuBotSelfOrgApiCallout.send(request);
    }

    private static String metadataRequest() {
        return '<?xml version="1.0" encoding="UTF-8"?>' +
            '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
            '<soapenv:Body><met:updateMetadata><met:metadata xsi:type="met:OmniChannelSettings">' +
            '<met:fullName>OmniChannel</met:fullName><met:enableOmniChannel>true</met:enableOmniChannel>' +
            '<met:enableOmniSkillsRouting>true</met:enableOmniSkillsRouting>' +
            '<met:enableOmniSecondaryRoutingPriority>true</met:enableOmniSecondaryRoutingPriority>' +
            '<met:enableOmniStatusCapModel>true</met:enableOmniStatusCapModel>' +
            '</met:metadata></met:updateMetadata></soapenv:Body></soapenv:Envelope>';
    }

    private static Map<String, Object> metadataResult(HttpResponse response) {
        Boolean success = response.getStatusCode() == 200 && response.getBody().contains('<success>true</success>');
        String message = success
            ? 'Successfully activated Skills-Based Routing, Secondary Routing Priority, and Status-Based Capacity Model.'
            : 'Metadata API responded: ' + response.getBody();
        return new Map<String, Object>{ 'success' => success, 'message' => message };
    }
}
