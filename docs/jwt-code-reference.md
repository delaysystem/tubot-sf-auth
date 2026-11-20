# JWT bearer and setup authorization code reference

The symbols below are the maintained entry points; line numbers are omitted
because they drift between releases. Paths are relative to the named project.

## Salesforce app (`tubot-sf-app/`)

- `force-app/main/default/externalClientApps/Tubot_Panel_Connection.eca-meta.xml`
  is the public PKCE client used for Salesforce approval.
- `force-app/main/default/externalClientApps/Tubot_Channel_API.eca-meta.xml`
  is the JWT execution client. Its signing certificate is packaged; the
  private key remains a Panel Worker secret.
- `SimpleSetupEcaStep` creates and assigns the subscriber-side
  `Tubot_JWT_PreAuth` permission set, starts setup OAuth, and polls a safe
  result. `SimpleSetupController` exposes those operations to the wizard.
- `PanelAuthSupportService.checkManageTubotPermission` checks the current
  user's direct assignment to the package's `Panel_Settings_Admin_Access`
  permission set. `requireSettingsAdmin` is the server-side gate used by
  settings, backup/restore, channel, and setup operations.
- `PanelAuthController.hasPanelSettingsAccess` is the LWC's fail-closed
  preflight. The settings tab is granted by the permission set. Existing
  AppPage, RecordPage, and HomePage targets remain for managed-package
  compatibility; an unassigned user sees the locked state, and Apex
  authorization remains the security boundary.
- `PackagePostInstallHandler` assigns the settings permission set to the
  installer. Salesforce's own install permissions still determine who can
  install or upgrade the package.

## Production Workers

The production Panel is `tubot-new-panel`, served at
`https://panel.tubot.lat`. Its `SF_AUTH` service binding targets the
`tubot-sf-auth` Worker. The two staging Workers and staging database remain
isolated in explicit Wrangler staging environments.

### Salesforce API setup popup (`tubot-new-panel/`)

- `worker/index.ts` handles `POST /api/v1/salesforce/setup-oauth`, status
  polling, and the setup-mode Salesforce callback.
- `worker/setup-eca.ts` exchanges the code, performs Metadata SOAP discovery,
  update, and readback, and revokes the token in the callback request.
- `worker/panel-setup-d1-store.ts` stores short-lived org/state context and
  the encrypted PKCE verifier while pending, then only the safe result,
  error category, and timestamp after completion. The authorization code and
  access token are not written to storage.
- `worker/oauth.ts` limits Panel callback hosts by the configured
  environment. Production allows only production Panel endpoints; staging
  allows only the staging Panel Worker; localhost is development-only.

The browser opens Salesforce's authorize page. The Worker receives the
single-use callback code, requests only the `api` scope, checks the org
identity, changes `Tubot_Channel_API` to admin-approved pre-authorization,
and verifies the policy readback. `Tubot_JWT_PreAuth` assignment is prepared
by Apex before this call. Final JWT channel registration verifies the grant
again through Salesforce userinfo.

### JWT channel registration

- `worker/jwt.ts` creates the short-lived JWT assertion and chooses the
  login/test audience from the org type.
- `worker/jwt-signer.ts` exposes the assertion signer only as the
  `PanelJwtSigner` private Worker RPC. The auth Worker receives a short-lived
  assertion over its service binding; the signing key stays in Panel.
- `worker/d1-query.ts` and `worker/channel-secrets.ts` provide scoped Panel
  D1 access and AES-GCM protection for short-lived setup OAuth state.
- The Panel channel registration endpoint verifies Salesforce org/user
  identity before it stores a mapping. The packaged JWT execution client
  is used for registrations; the Salesforce integration user's username
  is the JWT subject.
- `tubot-sf-auth/src/jwt.ts` builds the JWT assertion, and
  `tubot-sf-auth/src/index.ts` handles the Salesforce JWT grant and error
  mapping. Salesforce channel auth has no client-secret compatibility path.

## API examples

### Panel channel registration (JWT, identity-only)

```http
POST /api/v1/salesforce/channels
Authorization: Bearer <panel-token>
Content-Type: application/json

{
  "orgId": "<salesforce-org-id>",
  "channelId": "<messaging-channel-id>",
  "instanceUrl": "https://<org-domain>.my.salesforce.com",
  "integrationUserId": "<salesforce-user-id>",
  "integrationUsername": "integration@example.com",
  "isSandbox": true
}
```

Do not include Salesforce client secrets in the request. The worker verifies
the live JWT grant and userinfo identity before it stores the mapping.

### Raw Salesforce JWT grant

```http
POST https://login.salesforce.com/services/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=<RS256-JWT>
```

Sandbox orgs use Salesforce's test audience. The resulting access token is
used by the Worker for the requested Salesforce API operation and is not
persisted as a channel credential.
