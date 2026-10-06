/** Creates or updates the MessagingSession Escalate quick action through Tooling API. */
public with sharing class IGNORE_EscalateQuickActionService {
    private static final String ACTION_NAME = 'Escalate_To_Human';
    private static final String ACTION_LABEL = 'Escalate to Human';

    public static void provision(Map<String, Object> context) {
        loadExistingAction(context);
        Map<String, Object> metadata = quickActionMetadata((Map<String, Schema.SObjectField>) context.get('fieldMap'));
        if (String.isNotBlank((String) context.get('quickActionId'))) {
            updateQuickAction(context, metadata);
        } else {
            createQuickAction(context, metadata);
        }
    }

    private static void loadExistingAction(Map<String, Object> context) {
        String query = 'SELECT Id, DeveloperName, FullName FROM QuickActionDefinition ' +
            'WHERE SobjectType = \'MessagingSession\' AND DeveloperName = \'Escalate_To_Human\'';
        HttpResponse response = sendTooling(new Map<String, Object>{
            'baseUrl' => context.get('baseUrl'),
            'path' => '/tooling/query?q=' + EncodingUtil.urlEncode(query, 'UTF-8'),
            'method' => 'GET'
        });
        if (response.getStatusCode() != 200) { return; }
        List<Object> records = (List<Object>) ((Map<String, Object>) JSON.deserializeUntyped(response.getBody())).get('records');
        if (records == null || records.isEmpty()) { return; }
        Map<String, Object> record = (Map<String, Object>) records[0];
        context.put('quickActionId', (String) record.get('Id'));
        if (String.isNotBlank((String) record.get('FullName'))) { context.put('actionFullName', record.get('FullName')); }
        logs(context).add('[Step 2] QuickActionDefinition ' + context.get('actionFullName') +
            ' already exists (Id: ' + context.get('quickActionId') + ').');
    }

    private static Map<String, Object> quickActionMetadata(Map<String, Schema.SObjectField> fieldMap) {
        return new Map<String, Object>{
            'type' => 'Update',
            'label' => ACTION_LABEL,
            'description' => 'Escalates the messaging session to a human agent with optional reason, summary, and routing parameters.',
            'optionsCreateFeedItem' => false,
            'quickActionLayout' => new Map<String, Object>{
                'layoutSectionStyle' => 'TwoColumnsLeftToRight',
                'quickActionLayoutColumns' => new List<Object>{
                    new Map<String, Object>{ 'quickActionLayoutItems' => firstColumn(fieldMap) },
                    new Map<String, Object>{ 'quickActionLayoutItems' => secondColumn(fieldMap) }
                }
            }
        };
    }

    private static List<Object> firstColumn(Map<String, Schema.SObjectField> fieldMap) {
        return new List<Object>{
            layoutField('Escalate_To_Human__c', fieldMap),
            layoutField('Escalation_Reason__c', fieldMap),
            layoutField('varTargetQueueName__c', fieldMap),
            layoutField('varRouting__c', fieldMap)
        };
    }

    private static List<Object> secondColumn(Map<String, Schema.SObjectField> fieldMap) {
        return new List<Object>{
            layoutField('AI_Conversation_Summary__c', fieldMap),
            layoutField('varSkillLevel__c', fieldMap),
            layoutField('varTargetSkillName__c', fieldMap)
        };
    }

    private static Map<String, Object> layoutField(String fieldName, Map<String, Schema.SObjectField> fieldMap) {
        return new Map<String, Object>{
            'emptySpace' => false,
            'field' => SessionFieldsProvisioningService.resolveFieldApiName(fieldName, fieldMap),
            'uiBehavior' => 'Edit'
        };
    }

    private static void updateQuickAction(Map<String, Object> context, Map<String, Object> metadata) {
        logs(context).add('[Step 2] Updating existing QuickActionDefinition layout ' + context.get('actionFullName') + ' via Tooling API PATCH...');
        HttpResponse response = sendTooling(new Map<String, Object>{
            'baseUrl' => context.get('baseUrl'),
            'path' => '/tooling/sobjects/QuickActionDefinition/' + context.get('quickActionId'),
            'method' => 'PATCH',
            'body' => JSON.serialize(new Map<String, Object>{ 'Metadata' => metadata })
        });
        if (response.getStatusCode() == 200 || response.getStatusCode() == 204) {
            logs(context).add('[Step 2] Successfully updated QuickActionDefinition layout with all 7 fields: ' + context.get('actionFullName'));
        } else {
            logs(context).add('[Step 2] Note: Tooling API QuickAction patch returned HTTP ' + response.getStatusCode() + ': ' + response.getBody());
        }
    }

    private static void createQuickAction(Map<String, Object> context, Map<String, Object> metadata) {
        logs(context).add('[Step 2] Creating QuickActionDefinition ' + context.get('actionFullName') + ' via Tooling API POST...');
        HttpResponse response = sendTooling(new Map<String, Object>{
            'baseUrl' => context.get('baseUrl'),
            'path' => '/tooling/sobjects/QuickActionDefinition/',
            'method' => 'POST',
            'body' => JSON.serialize(new Map<String, Object>{
                'FullName' => context.get('actionFullName'), 'Metadata' => metadata
            })
        });
        if (response.getStatusCode() == 200 || response.getStatusCode() == 201) {
            context.put('quickActionId', ((Map<String, Object>) JSON.deserializeUntyped(response.getBody())).get('id'));
            logs(context).add('[Step 2] Successfully created QuickActionDefinition: ' + context.get('actionFullName') +
                ' (Id: ' + context.get('quickActionId') + ')');
        } else {
            logs(context).add('[Step 2] Note: Tooling API QuickAction create returned HTTP ' + response.getStatusCode() + ': ' + response.getBody());
        }
    }

    private static HttpResponse sendTooling(Map<String, Object> input) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint((String) input.get('baseUrl') + '/services/data/v67.0' + (String) input.get('path'));
        request.setMethod((String) input.get('method'));
        request.setHeader('Content-Type', 'application/json');
        if (String.isNotBlank((String) input.get('body'))) { request.setBody((String) input.get('body')); }
        return TuBotSelfOrgApiCallout.send(request);
    }

    private static List<String> logs(Map<String, Object> context) {
        return (List<String>) context.get('logs');
    }
}
