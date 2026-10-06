/** Parses Panel self-org relay responses while limiting the surfaced upstream error text. */
public with sharing class PanelSelfOrgResponseParser {
    public static Map<String, Object> parse(String body) {
        try {
            Object parsed = JSON.deserializeUntyped(body);
            if (parsed instanceof Map<String, Object>) { return (Map<String, Object>) parsed; }
        } catch (Exception ignored) {
            return new Map<String, Object>();
        }
        return new Map<String, Object>();
    }

    public static String safeError(Map<String, Object> payload, String fallback) {
        String message = payload != null && payload.get('error_description') instanceof String
            ? (String) payload.get('error_description') : fallback;
        return message.length() > 300 ? fallback : message;
    }

    public static Boolean isSalesforceAuthorizationUrl(String value) {
        try {
            Url parsed = new Url(value);
            String host = parsed.getHost().toLowerCase();
            return parsed.getProtocol() == 'https' && String.isBlank(parsed.getUserInfo()) &&
                (host.endsWith('.salesforce.com') || host.endsWith('.salesforce.mil')) &&
                parsed.getPath() == '/services/oauth2/authorize';
        } catch (Exception ex) {
            return false;
        }
    }
}
