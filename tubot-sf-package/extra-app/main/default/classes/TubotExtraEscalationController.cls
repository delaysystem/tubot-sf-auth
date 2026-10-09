/** Exposes the package-local Messaging Session escalation operation to its LWC. */
public with sharing class TubotExtraEscalationController {
    @AuraEnabled
    public static Map<String, Object> escalateSessionRecord(String requestJson) {
        return TubotExtraEscalationService.escalate(requestJson);
    }
}
