/**
 * Authenticated API requests to this Salesforce org.
 *
 * The Panel broker refreshes the PKCE grant and performs the Salesforce
 * callout server-side. Apex receives the Salesforce API response, never an
 * access token or a Salesforce session ID.
 */
public inherited sharing class TuBotSelfOrgApiCallout {
    public static HttpResponse send(HttpRequest request) {
        requireConnectionPermission();
        if (request == null) {
            throw new AuraHandledException('A Salesforce API request is required.');
        }

        try {
            HttpResponse response = TuBotSelfOrgConnectionController.sendSalesforceApiRequest(request);
            rejectUnauthorizedResponse(response);
            return response;
        } catch (CalloutException ex) {
            if (isCredentialConfigurationError(ex.getMessage())) {
                throw connectionConfigurationError();
            }
            throw ex;
        }
    }

    private static void requireConnectionPermission() {
        if (!PanelAuthSupportService.checkManageTubotPermission()) {
            throw new AuraHandledException('You do not have permission to make TuBot Salesforce API requests.');
        }
    }

    private static void rejectUnauthorizedResponse(HttpResponse response) {
        if (response.getStatusCode() == 401 || response.getStatusCode() == 403) {
            throw new AuraHandledException('Salesforce rejected the API request. Reconnect Salesforce API in Panel Settings and retry.');
        }
    }

    private static Boolean isCredentialConfigurationError(String errorMessage) {
        String message = errorMessage == null ? '' : errorMessage.toLowerCase();
        return message.contains('named credential') || message.contains('external credential') ||
            message.contains('credential') || message.contains('unauthorized endpoint');
    }

    private static AuraHandledException connectionConfigurationError() {
        return new AuraHandledException(
            'The Panel or Salesforce API connection is not configured. Connect Panel and complete the PKCE setup shown in Panel Settings, then retry.'
        );
    }
}
