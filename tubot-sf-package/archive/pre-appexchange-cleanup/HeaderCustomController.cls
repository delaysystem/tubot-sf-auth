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
