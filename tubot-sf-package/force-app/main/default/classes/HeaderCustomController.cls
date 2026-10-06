/**
 * @description DEPRECATED: chat handling is disabled in this package release. Retained (global
 * surface unchanged) because second-generation managed packages cannot delete components shipped
 * in a released version without Salesforce Partner approval. Scheduled for true removal once the
 * metadata-removal entitlement is granted.
 */
@RestResource(urlMapping='/HeaderCustomController/v1/*')
global without sharing class HeaderCustomController {
    @HttpPost
    global static String doPost() {
        String responseJson = '{"error":"Chat handling and human escalation are disabled in this package release."}';
        if (RestContext.response != null) {
            RestContext.response.statusCode = 410;
            RestContext.response.addHeader('Content-Type', 'application/json');
            RestContext.response.responseBody = Blob.valueOf(responseJson);
        }
        return responseJson;
    }
}
