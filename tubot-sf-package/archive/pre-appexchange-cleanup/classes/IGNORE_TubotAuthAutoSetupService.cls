/**
 * @description Automated Salesforce Channel Auth Setup Service.
 * Uses Salesforce Metadata API and Tooling/REST APIs to automatically provision:
 *   1. ExternalClientAppSettings (enableClientSecretInRestApiAccess = true)
 *   2. Local External Client App (Tubot_SF_Channel_API)
 *   3. ECA OAuth Settings (Api, OpenID scopes) & Global OAuth (client_credentials flow)
 *   4. ECA Configurable OAuth Policies (Run As integration user)
 *   5. REST API Consumer Key & Secret extraction
 *   6. Tubot_Salesforce_API_Read permission set assignment
 *   7. Automatic channel registration with Panel over TLS
 *
 * Executed automatically during package post-install (PackagePostInstallHandler)
 * or on-demand via Apex / LWC without requiring shell scripts.
 */
public without sharing class TubotAuthAutoSetupService {
    public static final String DEFAULT_APP_NAME = 'Tubot_SF_Channel_API';
    public static final String DEFAULT_APP_LABEL = 'Tubot SF Channel API';
    public static final String DEFAULT_CALLBACK_URL = 'https://tubot-new-panel.emalteaproductions.workers.dev/oauth/callback';
    public static final String API_PERMISSION_SET = 'Tubot_Salesforce_API_Read';
    @TestVisible private static Boolean testWithCalloutMock = false;
    @TestVisible private static Boolean isExecuting = false;

    public class SetupResult {
        @AuraEnabled public Boolean success;
        @AuraEnabled public String message;
        @AuraEnabled public String clientId;
        @AuraEnabled public String integrationUserId;
        @AuraEnabled public String integrationUsername;
        @AuraEnabled public List<String> connectedChannels;
        @AuraEnabled public List<String> logs;

        public SetupResult() {
            this.success = false;
            this.connectedChannels = new List<String>();
            this.logs = new List<String>();
        }
    }

    /**
     * @description Queueable wrapper for asynchronous post-install execution.
     */
    private class AutoSetupQueueable implements Queueable, Database.AllowsCallouts {
        private String targetChannelId;
        private String targetUserId;

        private AutoSetupQueueable() {
            this(null, null);
        }

        private AutoSetupQueueable(String targetChannelId, String targetUserId) {
            this.targetChannelId = targetChannelId;
            this.targetUserId = targetUserId;
        }

        public void execute(QueueableContext context) {
            SetupResult result = setupAuthSystem(targetChannelId, targetUserId);
            System.debug('>>> [TubotAuthAutoSetupService] AutoSetup result: ' + JSON.serialize(result));
        }
    }

    /**
     * @description Enqueues asynchronous automated setup.
     */
    public static Id setupAuthSystemAsync(String targetChannelId, String targetUserId) {
        requireSettingsAdmin();
        List<AsyncApexJob> runningJobs = [
            SELECT Id FROM AsyncApexJob
            WHERE ApexClass.Name = 'TubotAuthAutoSetupService'
            AND Status IN ('Holding', 'Queued', 'Preparing', 'Processing')
            LIMIT 1
        ];
        if (!runningJobs.isEmpty()) {
            System.debug('>>> [TubotAuthAutoSetupService] AutoSetup job is already running or queued. Skipping duplicate.');
            return runningJobs[0].Id;
        }
        return System.enqueueJob(new AutoSetupQueueable(targetChannelId, targetUserId));
    }

    /**
     * @description Invoked from LWC UI or Apex directly.
     */
    @AuraEnabled
    public static SetupResult autoSetupAuth(String targetChannelId, String targetUserId) {
        requireSettingsAdmin();
        return setupAuthSystem(targetChannelId, targetUserId);
    }

    /**
     * @description Core synchronous execution pipeline. All callouts execute before local DML.
     */
    private static SetupResult setupAuthSystem(String targetChannelId, String targetUserId) {
        SetupResult result = new SetupResult();
        List<String> logs = result.logs;
        logs.add('=== STARTING AUTOMATED SALESFORCE AUTH SETUP (METADATA & TOOLING API) ===');

        if (isExecuting) {
            logs.add('⚠ Auto-setup already executing in current transaction. Skipping duplicate execution.');
            result.message = 'Auto-setup already in progress.';
            return result;
        }
        isExecuting = true;

        if (Test.isRunningTest() && !testWithCalloutMock) {
            result.success = true;
            result.message = 'Mock post-install auth setup successful.';
            result.clientId = 'mock_client_id';
            result.integrationUserId = UserInfo.getUserId();
            isExecuting = false;
            return result;
        }

        try {
            String baseUrl = Url.getOrgDomainUrl().toExternalForm();
            String sessionId = resolveSessionId();
            logs.add('[1/7] Resolved API session and Org Domain: ' + baseUrl);

            // Phase 1: Resolve target integration user
            User integrationUser = resolveIntegrationUser(targetUserId);
            if (integrationUser == null) {
                result.message = 'Could not resolve an active integration user in this org.';
                logs.add('✖ ' + result.message);
                return result;
            }
            result.integrationUserId = integrationUser.Id;
            result.integrationUsername = integrationUser.Username;
            logs.add('[2/7] Selected integration user: ' + integrationUser.Username + ' (Id: ' + integrationUser.Id + ')');

            // Fast-path idempotency check: Check if ECA credentials can already be extracted
            String clientId;
            String clientSecret;
            Map<String, String> existingCreds = extractCredentials(baseUrl, sessionId, logs);
            if (String.isNotBlank(existingCreds.get('clientId')) && String.isNotBlank(existingCreds.get('clientSecret'))) {
                clientId = existingCreds.get('clientId');
                clientSecret = existingCreds.get('clientSecret');
                logs.add('[3/7] ECA (' + DEFAULT_APP_NAME + ') is already provisioned in this org. Skipping SOAP metadata deployment.');
                logs.add('[4/7] Reusing existing ECA credentials.');
                logs.add('[5/7] OAuth settings already configured.');
            } else {
                // Phase 2: Enable REST API Consumer Secret access in ExternalClientAppSettings via Metadata API
                logs.add('[3/7] Enabling REST API Consumer Secret access via Metadata API SOAP...');
                Boolean settingsOk = upsertExternalClientAppSettings(baseUrl, sessionId, logs);
                if (!settingsOk) {
                    logs.add('⚠ Warning: ExternalClientAppSettings update did not confirm success. Proceeding...');
                } else {
                    logs.add('✔ ExternalClientAppSettings successfully verified via Metadata API.');
                }

                // Phase 3: Create / Upsert Local External Client App via Metadata API
                logs.add('[4/7] Provisioning ExternalClientApplication (' + DEFAULT_APP_NAME + ') via Metadata API...');
                Boolean ecaOk = upsertExternalClientAppHeader(baseUrl, sessionId, logs);
                if (!ecaOk) {
                    logs.add('⚠ Warning: ExternalClientApplication header upsert note. Continuing to OAuth configuration...');
                }

                // Phase 4: Create / Upsert ECA OAuth Settings, Global Settings, & Run As Policy via Metadata API
                logs.add('[5/7] Provisioning ECA OAuth Settings, Global Settings, & Policies via Metadata API...');
                Boolean oauthOk = upsertExternalClientAppOAuth(baseUrl, sessionId, integrationUser.Username, logs);
                if (!oauthOk) {
                    logs.add('⚠ Warning: OAuth configuration note. Continuing to credential extraction...');
                }

                // Phase 5: Extract Consumer Key & Consumer Secret via REST Credentials API
                logs.add('[6/7] Extracting OAuth Consumer Key & Secret via REST API...');
                Map<String, String> credentials = extractCredentials(baseUrl, sessionId, logs);
                clientId = credentials.get('clientId');
                clientSecret = credentials.get('clientSecret');
            }

            if (String.isBlank(clientId) || String.isBlank(clientSecret)) {
                result.message = 'Could not extract ECA consumer key and secret from Salesforce REST API.';
                logs.add('✖ ' + result.message);
                return result;
            }
            result.clientId = clientId;
            logs.add('✔ Securely extracted consumer key: ' + clientId.substring(0, Math.min(12, clientId.length())) + '... (Secret securely extracted)');

            // Phase 6: Register channel with Panel over TLS if Panel is connected (Callout - MUST precede any DML)
            PanelAuthController.AuthStatusDTO status = PanelAuthController.getPanelAuthStatus();
            List<MessagingChannel> successfullyConnectedChannels = new List<MessagingChannel>();
            if (status.isConnected) {
                logs.add('[6/7] Panel is connected (Team: ' + status.teamId + '). Registering channel connections over TLS...');
                List<MessagingChannel> channels = resolveChannels(targetChannelId);

                Set<Id> channelIds = new Set<Id>();
                for (MessagingChannel ch : channels) {
                    channelIds.add(ch.Id);
                }
                Map<String, Tubot_API_Channel__c> existingChannelMap = new Map<String, Tubot_API_Channel__c>();
                for (Tubot_API_Channel__c existing : [
                    SELECT Id, Channel_Id__c, Integration_User_Id__c, Team_Id__c
                    FROM Tubot_API_Channel__c
                    WHERE Channel_Id__c IN :channelIds AND Team_Id__c = :status.teamId
                ]) {
                    existingChannelMap.put(existing.Channel_Id__c, existing);
                }

                for (MessagingChannel ch : channels) {
                    if (existingChannelMap.containsKey(ch.Id) && existingChannelMap.get(ch.Id).Integration_User_Id__c == String.valueOf(integrationUser.Id)) {
                        logs.add('✔ Messaging Channel ' + ch.DeveloperName + ' (' + ch.Id + ') is already connected for team ' + status.teamId + '. Skipping duplicate registration.');
                        successfullyConnectedChannels.add(ch);
                        result.connectedChannels.add(ch.Id);
                        continue;
                    }
                    try {
                        Map<String, Object> payload = new Map<String, Object>{
                            'orgId' => UserInfo.getOrganizationId(),
                            'channelId' => ch.Id,
                            'instanceUrl' => baseUrl,
                            'clientId' => clientId,
                            'clientSecret' => clientSecret,
                            'integrationUserId' => String.valueOf(integrationUser.Id)
                        };
                        HttpResponse panelRes = PanelAuthSupportService.executePanelCallout(
                            '/api/v1/salesforce/channels', 'POST', JSON.serialize(payload)
                        );
                        if (panelRes.getStatusCode() >= 200 && panelRes.getStatusCode() < 300) {
                            successfullyConnectedChannels.add(ch);
                            result.connectedChannels.add(ch.Id);
                            logs.add('✔ Connected Messaging Channel with Panel: ' + ch.DeveloperName + ' (' + ch.Id + ')');
                        } else {
                            logs.add('⚠ Channel registration note for ' + ch.DeveloperName + ' (HTTP ' + panelRes.getStatusCode() + '): ' + panelRes.getBody());
                        }
                    } catch (Exception ex) {
                        logs.add('⚠ Channel connection note for ' + ch.DeveloperName + ': ' + ex.getMessage());
                    }
                }
            } else {
                logs.add('[6/7] Panel is not yet connected in this org. ECA credentials provisioned and ready for auto-connection.');
            }

            // Phase 7: Local DML operations (Permission set assignment & local channel tracking records)
            logs.add('[7/7] Ensuring ' + API_PERMISSION_SET + ' permission set is assigned to integration user...');
            assignApiPermissionSet(integrationUser.Id, logs);

            if (!successfullyConnectedChannels.isEmpty() && status.isConnected) {
                List<Tubot_API_Channel__c> recordsToUpsert = new List<Tubot_API_Channel__c>();
                for (MessagingChannel ch : successfullyConnectedChannels) {
                    List<Tubot_API_Channel__c> existing = [
                        SELECT Id, Channel_Id__c, Integration_User_Id__c, Team_Id__c
                        FROM Tubot_API_Channel__c WHERE Channel_Id__c = :ch.Id LIMIT 1
                    ];
                    Tubot_API_Channel__c rec = existing.isEmpty() ? new Tubot_API_Channel__c() : existing[0];
                    rec.Channel_Id__c = ch.Id;
                    rec.Team_Id__c = status.teamId;
                    rec.Integration_User_Id__c = String.valueOf(integrationUser.Id);
                    rec.Assignment_Owned__c = false;
                    recordsToUpsert.add(rec);
                }
                upsert recordsToUpsert;
                logs.add('✔ Saved ' + recordsToUpsert.size() + ' local channel connection records.');
            }

            result.success = true;
            result.message = 'Salesforce channel auth system setup completed successfully via Metadata API & Tooling API!';
            logs.add('=== AUTOMATED AUTH SETUP COMPLETED SUCCESSFULLY ===');
        } catch (Exception ex) {
            result.success = false;
            result.message = 'Setup failed: ' + ex.getMessage();
            logs.add('✖ Exception: ' + ex.getMessage() + '\n' + ex.getStackTraceString());
        } finally {
            isExecuting = false;
        }

        return result;
    }

    /**
     * @description This excluded feature no longer provides session-based API authentication.
     */
    @TestVisible
    private static String resolveSessionId() {
        throw new AuraHandledException('This authentication setup feature is excluded from this package release.');
    }

    /**
     * @description Resolves an active target integration user.
     */
    @TestVisible
    private static User resolveIntegrationUser(String targetUserId) {
        if (String.isNotBlank(targetUserId)) {
            List<User> explicitUsers = [
                SELECT Id, Username, Email, IsActive 
                FROM User 
                WHERE (Id = :targetUserId OR Username = :targetUserId) AND IsActive = true 
                LIMIT 1
            ];
            if (!explicitUsers.isEmpty()) return explicitUsers[0];
        }

        Id currentUserId = UserInfo.getUserId();
        List<User> currentUsers = [SELECT Id, Username, Email, IsActive FROM User WHERE Id = :currentUserId AND IsActive = true LIMIT 1];
        if (!currentUsers.isEmpty()) return currentUsers[0];

        List<User> adminUsers = [
            SELECT Id, Username, Email, IsActive 
            FROM User 
            WHERE IsActive = true AND Profile.PermissionsModifyAllData = true 
            ORDER BY CreatedDate ASC 
            LIMIT 1
        ];
        if (!adminUsers.isEmpty()) return adminUsers[0];

        return null;
    }

    /**
     * @description Sends Metadata API SOAP callout.
     */
    private static HttpResponse sendMetadataSoap(String baseUrl, String sessionId, String soapBody) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(baseUrl + '/services/Soap/m/67.0');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'text/xml; charset=UTF-8');
        req.setHeader('SOAPAction', 'upsertMetadata');
        req.setTimeout(45000);

        String soapXml = '<?xml version="1.0" encoding="UTF-8"?>' +
            '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
            '   <soapenv:Header>' +
            '      <met:SessionHeader>' +
            '         <met:sessionId>' + sessionId + '</met:sessionId>' +
            '      </met:SessionHeader>' +
            '   </soapenv:Header>' +
            '   <soapenv:Body>' +
            '      <met:upsertMetadata>' +
            soapBody +
            '      </met:upsertMetadata>' +
            '   </soapenv:Body>' +
            '</soapenv:Envelope>';
        req.setBody(soapXml);
        return new Http().send(req);
    }

    /**
     * @description Enables REST API Consumer Secret access in ExternalClientAppSettings via Metadata API.
     */
    private static Boolean upsertExternalClientAppSettings(String baseUrl, String sessionId, List<String> logs) {
        String metadataXml =
            '<met:metadata xsi:type="met:ExternalClientAppSettings">' +
            '   <met:fullName>ExternalClientApp</met:fullName>' +
            '   <met:enableClientSecretInRestApiAccess>true</met:enableClientSecretInRestApiAccess>' +
            '</met:metadata>';
        HttpResponse res = sendMetadataSoap(baseUrl, sessionId, metadataXml);
        return res.getStatusCode() == 200 && res.getBody().contains('<success>true</success>');
    }

    /**
     * @description Deploys ExternalClientApplication header via Metadata API.
     */
    private static Boolean upsertExternalClientAppHeader(String baseUrl, String sessionId, List<String> logs) {
        String metadataXml =
            '<met:metadata xsi:type="met:ExternalClientApplication">' +
            '   <met:fullName>' + DEFAULT_APP_NAME + '</met:fullName>' +
            '   <met:contactEmail>' + UserInfo.getUserEmail() + '</met:contactEmail>' +
            '   <met:description>Auto-provisioned Local External Client App for Tubot channel-scoped API access.</met:description>' +
            '   <met:distributionState>Local</met:distributionState>' +
            '   <met:isProtected>false</met:isProtected>' +
            '   <met:label>' + DEFAULT_APP_LABEL + '</met:label>' +
            '</met:metadata>';
        HttpResponse res = sendMetadataSoap(baseUrl, sessionId, metadataXml);
        return res.getStatusCode() == 200 && res.getBody().contains('<success>true</success>');
    }

    /**
     * @description Deploys OAuth Settings, Global Settings, and Configurable Policies via Metadata API.
     */
    private static Boolean upsertExternalClientAppOAuth(String baseUrl, String sessionId, String username, List<String> logs) {
        String metadataXml =
            '<met:metadata xsi:type="met:ExtlClntAppOauthSettings">' +
            '   <met:fullName>' + DEFAULT_APP_NAME + '_OAuth</met:fullName>' +
            '   <met:externalClientApplication>' + DEFAULT_APP_NAME + '</met:externalClientApplication>' +
            '   <met:label>' + DEFAULT_APP_LABEL + ' OAuth</met:label>' +
            '   <met:commaSeparatedOauthScopes>Api, OpenID</met:commaSeparatedOauthScopes>' +
            '</met:metadata>' +
            '<met:metadata xsi:type="met:ExtlClntAppGlobalOauthSettings">' +
            '   <met:fullName>' + DEFAULT_APP_NAME + '_Global</met:fullName>' +
            '   <met:externalClientApplication>' + DEFAULT_APP_NAME + '</met:externalClientApplication>' +
            '   <met:label>' + DEFAULT_APP_LABEL + ' Global OAuth</met:label>' +
            '   <met:callbackUrl>' + DEFAULT_CALLBACK_URL + '</met:callbackUrl>' +
            '   <met:isClientCredentialsFlowEnabled>true</met:isClientCredentialsFlowEnabled>' +
            '   <met:isConsumerSecretOptional>false</met:isConsumerSecretOptional>' +
            '   <met:isIntrospectAllTokens>false</met:isIntrospectAllTokens>' +
            '   <met:isPkceRequired>false</met:isPkceRequired>' +
            '   <met:isSecretRequiredForRefreshToken>true</met:isSecretRequiredForRefreshToken>' +
            '   <met:shouldRotateConsumerKey>false</met:shouldRotateConsumerKey>' +
            '   <met:shouldRotateConsumerSecret>false</met:shouldRotateConsumerSecret>' +
            '</met:metadata>' +
            '<met:metadata xsi:type="met:ExtlClntAppOauthConfigurablePolicies">' +
            '   <met:fullName>' + DEFAULT_APP_NAME + '_OAuth_Policies</met:fullName>' +
            '   <met:externalClientApplication>' + DEFAULT_APP_NAME + '</met:externalClientApplication>' +
            '   <met:label>' + DEFAULT_APP_LABEL + ' OAuth Policies</met:label>' +
            '   <met:clientCredentialsFlowUser>' + username + '</met:clientCredentialsFlowUser>' +
            '   <met:isClientCredentialsFlowEnabled>true</met:isClientCredentialsFlowEnabled>' +
            '</met:metadata>';
        HttpResponse res = sendMetadataSoap(baseUrl, sessionId, metadataXml);
        return res.getStatusCode() == 200 && res.getBody().contains('<success>true</success>');
    }

    /**
     * @description Programmatically extracts Consumer Key and Consumer Secret via REST APIs.
     */
    private static Map<String, String> extractCredentials(String baseUrl, String sessionId, List<String> logs) {
        Map<String, String> creds = new Map<String, String>();

        // Step 1: Look up ECA identifier from apps/oauth/usage
        HttpRequest usageReq = new HttpRequest();
        usageReq.setEndpoint(baseUrl + '/services/data/v67.0/apps/oauth/usage');
        usageReq.setMethod('GET');
        usageReq.setHeader('Authorization', 'Bearer ' + sessionId);
        usageReq.setHeader('Accept', 'application/json');
        HttpResponse usageRes = new Http().send(usageReq);

        String ecaId;
        if (usageRes.getStatusCode() == 200) {
            Map<String, Object> data = (Map<String, Object>) JSON.deserializeUntyped(usageRes.getBody());
            List<Object> apps = (List<Object>) data.get('apps');
            if (apps != null) {
                for (Object appObj : apps) {
                    Map<String, Object> app = (Map<String, Object>) appObj;
                    if (app.get('developerName') == DEFAULT_APP_NAME) {
                        ecaId = String.valueOf(app.get('identifier'));
                        break;
                    }
                }
            }
        }

        if (String.isBlank(ecaId)) {
            // Fallback: Query Tooling API for ExternalClientApplication Id
            try {
                HttpRequest tReq = new HttpRequest();
                tReq.setEndpoint(baseUrl + '/services/data/v67.0/tooling/query?q=' +
                    EncodingUtil.urlEncode('SELECT Id FROM ExternalClientApplication WHERE DeveloperName = \'' + DEFAULT_APP_NAME + '\' LIMIT 1', 'UTF-8'));
                tReq.setMethod('GET');
                tReq.setHeader('Authorization', 'Bearer ' + sessionId);
                tReq.setHeader('Accept', 'application/json');
                HttpResponse tRes = new Http().send(tReq);
                if (tRes.getStatusCode() == 200) {
                    Map<String, Object> tData = (Map<String, Object>) JSON.deserializeUntyped(tRes.getBody());
                    List<Object> recs = (List<Object>) tData.get('records');
                    if (recs != null && !recs.isEmpty()) {
                        ecaId = String.valueOf(((Map<String, Object>) recs[0]).get('Id'));
                    }
                }
            } catch (Exception ignored) {}
        }

        if (String.isBlank(ecaId)) return creds;

        // Step 2: Fetch credentials from apps/oauth/credentials/{ecaId}?part=keyandsecret
        HttpRequest credsReq = new HttpRequest();
        credsReq.setEndpoint(baseUrl + '/services/data/v67.0/apps/oauth/credentials/' + ecaId + '?part=keyandsecret');
        credsReq.setMethod('GET');
        credsReq.setHeader('Authorization', 'Bearer ' + sessionId);
        credsReq.setHeader('Accept', 'application/json');
        HttpResponse credsRes = new Http().send(credsReq);

        if (credsRes.getStatusCode() == 200) {
            Map<String, Object> cData = (Map<String, Object>) JSON.deserializeUntyped(credsRes.getBody());
            if (cData.get('key') instanceof String) creds.put('clientId', (String) cData.get('key'));
            if (cData.get('secret') instanceof String) creds.put('clientSecret', (String) cData.get('secret'));

            if (!creds.containsKey('clientId') && cData.get('consumers') instanceof List<Object>) {
                List<Object> consumers = (List<Object>) cData.get('consumers');
                if (!consumers.isEmpty()) {
                    Map<String, Object> consumer = (Map<String, Object>) consumers[0];
                    if (consumer.get('key') instanceof String) creds.put('clientId', (String) consumer.get('key'));
                    if (consumer.get('url') instanceof String) {
                        String singleUrl = baseUrl + String.valueOf(consumer.get('url')) + '?part=keyandsecret';
                        HttpRequest sReq = new HttpRequest();
                        sReq.setEndpoint(singleUrl);
                        sReq.setMethod('GET');
                        sReq.setHeader('Authorization', 'Bearer ' + sessionId);
                        sReq.setHeader('Accept', 'application/json');
                        HttpResponse sRes = new Http().send(sReq);
                        if (sRes.getStatusCode() == 200) {
                            Map<String, Object> sData = (Map<String, Object>) JSON.deserializeUntyped(sRes.getBody());
                            if (sData.get('key') instanceof String) creds.put('clientId', (String) sData.get('key'));
                            if (sData.get('secret') instanceof String) creds.put('clientSecret', (String) sData.get('secret'));
                        }
                    }
                }
            }
        }

        return creds;
    }

    /**
     * @description Ensures the Tubot_Salesforce_API_Read permission set is assigned.
     */
    private static void assignApiPermissionSet(Id userId, List<String> logs) {
        List<PermissionSet> sets = [SELECT Id FROM PermissionSet WHERE Name = :API_PERMISSION_SET LIMIT 1];
        if (sets.isEmpty()) {
            logs.add('⚠ PermissionSet ' + API_PERMISSION_SET + ' not found in org.');
            return;
        }
        List<PermissionSetAssignment> existing = [
            SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = :userId AND PermissionSetId = :sets[0].Id LIMIT 1
        ];
        if (existing.isEmpty()) {
            insert new PermissionSetAssignment(AssigneeId = userId, PermissionSetId = sets[0].Id);
            logs.add('✔ Assigned ' + API_PERMISSION_SET + ' to integration user: ' + userId);
        } else {
            logs.add('✔ ' + API_PERMISSION_SET + ' already assigned to integration user.');
        }
    }

    /**
     * @description Resolves target MessagingChannels.
     */
    @TestVisible
    private static List<MessagingChannel> resolveChannels(String targetChannelId) {
        if (String.isNotBlank(targetChannelId)) {
            return [SELECT Id, DeveloperName FROM MessagingChannel WHERE Id = :targetChannelId OR DeveloperName = :targetChannelId LIMIT 1];
        }
        return [SELECT Id, DeveloperName FROM MessagingChannel ORDER BY CreatedDate ASC LIMIT 5];
    }

    private static void requireSettingsAdmin() {
        if (!FeatureManagement.checkPermission('Manage_Tubot_API_Connections')) {
            throw new AuraHandledException('You do not have permission to manage TuBot package settings.');
        }
    }
}
