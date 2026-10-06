/** Writes Panel access tokens only to the encrypted External Credential principal. */
public with sharing class PanelExternalCredentialTokenService {
    @TestVisible private static Boolean bypassCredentialWriteForTest = false;

    public static void store(String accessToken) {
        if (Test.isRunningTest() && bypassCredentialWriteForTest) { return; }
        List<String> credentialNames = new List<String>();
        String qualified = PanelAuthSupportService.getExternalCredentialName();
        credentialNames.add(qualified);
        if (qualified != PanelAuthSupportService.EXTERNAL_AUTH_NAME) {
            credentialNames.add(PanelAuthSupportService.EXTERNAL_AUTH_NAME);
        }

        for (String credName : credentialNames) {
            ConnectApi.CredentialInput input = new ConnectApi.CredentialInput();
            input.externalCredential = credName;
            input.principalName = PanelAuthSupportService.PRINCIPAL_NAME;
            input.principalType = ConnectApi.CredentialPrincipalType.NamedPrincipal;
            ConnectApi.CredentialValueInput token = new ConnectApi.CredentialValueInput();
            token.value = String.isNotBlank(accessToken) ? accessToken : 'revoked';
            token.encrypted = true;
            input.credentials = new Map<String, ConnectApi.CredentialValueInput>{ 'token' => token };
            try {
                ConnectApi.NamedCredentials.patchCredential(input);
                return;
            } catch (Exception patchError) {
                try {
                    ConnectApi.NamedCredentials.createCredential(input);
                    return;
                } catch (Exception createError) {
                    // Try next candidate credential name; log without secrets for diagnostics.
                    System.debug('>>> [PanelExternalCredentialTokenService] Credential write failed for ' + credName + ': ' + createError.getMessage());
                }
            }
        }

        throw new AuraHandledException(
            'Panel authorized this login, but Salesforce could not store the token. Grant this user Read, Create, Edit, Delete, and View All access to User External Credentials, then retry. (PANEL_CREDENTIAL_ACCESS_REQUIRED)'
        );
    }

    public static void clear() {
        store('revoked');
    }
}
