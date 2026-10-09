/** Writes Panel access tokens only to the encrypted External Credential principal. */
public with sharing class PanelExternalCredentialTokenService {
    @TestVisible private static Boolean bypassCredentialWriteForTest = false;

    public static void store(String accessToken) {
        if (Test.isRunningTest() && bypassCredentialWriteForTest) { return; }
        storeCredential(PanelAuthSupportService.getExternalCredentialApiName(), accessToken);
    }

    public static void store(String accessToken, String refreshToken) {
        if (Test.isRunningTest() && bypassCredentialWriteForTest) { return; }
        if (String.isBlank(refreshToken)) throw new AuraHandledException('Panel did not return a refresh credential. Reconnect Panel.');
        storeCredential(PanelAuthSupportService.getRefreshExternalCredentialApiName(), refreshToken);
        store(accessToken);
    }

    private static void storeCredential(String baseName, String accessToken) {
        List<String> credentialNames = new List<String>();
        String qualified = PanelAuthSupportService.getNamespacePrefix() + baseName;
        credentialNames.add(qualified);
        if (qualified != baseName) {
            credentialNames.add(baseName);
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
                    System.debug('Panel credential write failed for ' + credName);
                }
            }
        }

        throw new AuraHandledException(
            'Panel authorized this login, but Salesforce could not store the token. Grant this user Read, Create, Edit, Delete, and View All access to User External Credentials, then retry. (PANEL_CREDENTIAL_ACCESS_REQUIRED)'
        );
    }

    public static void clear() {
        store('revoked', 'revoked');
    }
}
