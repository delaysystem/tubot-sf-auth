# JWT bearer — code reference

Where every piece of the secret-free channel auth lives, with line
numbers, entry points, and API examples. Paths under `tubot-sf-auth/`
are relative to that repo; `tubot-new-panel/` paths are relative to the
workspace root. Line numbers were captured after commit `cc63a47` and
will drift — use the symbol names to re-locate.

## Salesforce package (`tubot-sf-package/`)

### Packaged External Client Apps (secret-less metadata)

- `force-app/main/default/externalClientApps/Tubot_Panel_Connection.eca-meta.xml` — PKCE login/identification client.
- `force-app/main/default/externalClientApps/Tubot_Channel_API.eca-meta.xml` — JWT-only execution client.
- `force-app/main/default/extlClntAppOauthSettings/Tubot_Panel_Connection_OAuth.ecaOauth-meta.xml`
- `force-app/main/default/extlClntAppOauthSettings/Tubot_Channel_API_OAuth.ecaOauth-meta.xml` — `isConsumerSecretOptional=true`, inline `<certificate>`, `isNamedUserJwtEnabled=true`, client-credentials flow disabled.
- Pre-authorization is subscriber-side (cannot be packaged): `Tubot_JWT_PreAuth` permission set + `AdminApprovedPreAuthorized` policies, applied by `scripts/setup-eca-policies.mjs` (must re-run after every install/upgrade — reinstall resets policies to defaults).

### Simple Setup Apex (`force-app/main/default/classes/`)

| Class | Key members |
|---|---|
| `SimpleSetupController.cls` | `STEP_HANDLERS` dispatch map (:13), `getStatus()` (:47), `runStep(step, state)` (:73) — steps: `user`, `channel`, `eca`, `finalize`, `finalize-register` |
| `SimpleSetupStepRunner.cls` | `runUserStep` (:10), `runChannelStep` (:31), `runEcaStep` (:91), `runFinalizeStep` (:114), `runFinalizeRegisterStep` (:125) |
| `SimpleSetupInput.cls` | `asMap` (:12), `failed` (:29), `stringValue` (:33), `requireUser` (:37), `selectIntegrationUser` (:43), `resolveSelectedUser` (:66) |
| `SimpleSetupChannelStep.cls` | `ChannelSpec` (:33), `findChannelByDeveloperName` (:42), `findExistingChannel` (:64), `ensureActive` (:92), `createChannelWithQueue(spec)` (:124) — DML-only provisioning |
| `SimpleSetupEcaStep.cls` | `APP_NAME` (:11), `PREAUTH_PERMISSION_SET` (:13), `ecaExists()` (:24), `preAuthExists()` (:36), `getPoliciesGuidance()` (:51) |
| `SimpleSetupFinalizeStep.cls` | `prepareChannel(channelId, userId)` (:17, DML), `registerAndVerify(channelId, userId)` (:30, callout, identity-only payload) |
| `PanelSalesforceChannelService.cls` | `PERMISSION_SET` (:6), `listConnections` (:9), `prepareChannel` (:19), `connectChannel` (:36), `disconnectChannel` (:41) |
| `PanelSalesforceChannelConnectService.cls` | `connect(requestJson)` (:17) — secret-free connect |
| `TubotSetupWizardController.cls` | `API_READ_PERMISSION_SET` (:9), `JWT_PREAUTH_PERMISSION_SET` (:13), `getIntegrationCandidates` (:92), `assignApiPermissionSet` (:142) |

Tests: `SimpleSetupControllerTest.cls`, `SimpleSetupStepsTest.cls`, `PanelSalesforceChannelServiceTest.cls`, `TubotSetupWizardControllerTest.cls`, `TuBotSelfOrgConnectionControllerTest.cls` (46/46 green in packaging org `test2`).

LWC: `force-app/main/default/lwc/panelLoginSettings/panelLoginSettings.{js,html}` — no secret inputs; ECA step renders the policies CLI command.

### Operator scripts (`scripts/`)

- `setup-eca-policies.mjs` — `APP_NAME`/`PREAUTH_SET_NAME` (:14–15), `buildPermissionSetXml` (:58), `buildPoliciesXml` (:62), `findPoliciesName` (:68), `main` (:135). Usage: `bun scripts/setup-eca-policies.mjs --target-org <alias> [--check-only]`. Tests: `setup-eca-policies.test.mjs` (6 pass).
- `tubot_postinstall.py` v1.1.0 (:42) — `resolve_org` (:290, detects `is_sandbox`), `ensure_permission_set` (:949), `ensure_packaged_execution_client` (:995), `assign_jwt_preauth_set` (:1034), `register_channel_with_panel` (:1083, expects 201 + `verified.username`), `verify_setup` (:1198, blind checks).
- `tubot_auto_setup.py` v1.1.0 (:39) — headless driver calling the same functions.

## Auth worker (`tubot-sf-auth/src/`)

- `jwt.ts` — `TUBOT_CHANNEL_API_CLIENT_ID` (:7), `JWT_BEARER_GRANT_TYPE` (:9), `jwtAudience(isSandbox)` (:12), `buildJwtAssertion(privateKeyPem, subjectUsername, isSandbox)` (:33, RS256, 3-minute `exp`). Tests: `jwt.test.ts` (3 pass).
- `index.ts` — `AuthEnv.TUBOT_JWT_PRIVATE_KEY` (:112); `jwtRow(row)` type guard (:309); `token()` cache incl. JWT keying (:817); `fetchToken()` JWT mint branch (:839–866) and error mapping (`jwt_private_key_misconfigured` 500 at :846/:852, `salesforce_preauth_required` 422 at :884, `salesforce_identity_mismatch` 422 at :920); `POST /internal/channels/register` (:2347, JWT-vs-legacy branch, verify-before-store, 201).
- `agent-script.ts` — `Credential` (:4): nullable `client_secret_cipher/iv`, optional `integration_username`/`is_sandbox`.
- `tenant-bridge.ts` — `BridgeCredentialPayload` (:95, `clientSecret: string | null` + JWT pair), `fetchBridgeCredential` (:241), validator (:293–320, null secret requires username+sandbox or `bridge_invalid_response`).
- `migrations/0004_jwt_credential_rows.sql` — adds `integration_username` / `is_sandbox` to `salesforce_auth_credential` (applied local + staging; legacy rows preserved).

## New Panel (`tubot-new-panel/`)

- `worker/jwt.ts` — client ID constants (:7–9), `jwtAudience` (:14), `buildJwtAssertion` (:35), `mintJwtAccessToken(privateKeyPem, instanceUrl, username, isSandbox)` (:79, posts the assertion, returns `{ accessToken, instanceUrl }`). Tests: `src/jwt.test.ts` (3 pass).
- `worker/index.ts` — `Env.TUBOT_JWT_PRIVATE_KEY` (:69); `salesforce_channels` table + JWT column migration (:166–186); `save-channel` (:508, NULL secret + username/sandbox); `raw-credential` (:752, returns the JWT pair); `POST /internal/bridge/credential` (:1169, decrypts server-side, passes the pair through); `GET /api/v1/salesforce/channels` (:2175); **`POST /api/v1/salesforce/channels`** (:2199, mint → userinfo match → store, 201); `DELETE …/channels/:id` (:2322).
- `worker/bridge.ts` — bridge path constants shared with the auth worker.
- `worker/postinstall-script.ts` — auto-generated embedded copy of `tubot_postinstall.py` v1.1.0 (regenerate with `bun run sync:postinstall`).

## API examples

### Panel channel registration (JWT, identity-only)

```http
POST /api/v1/salesforce/channels
Authorization: Bearer <panel-token>
Content-Type: application/json

{
  "orgId": "00DBi000005Byl7MAC",
  "channelId": "0MXBi0000001a2BAA",
  "instanceUrl": "https://inspiration-java-6132-dev-ed.scratch.my.salesforce.com",
  "integrationUserId": "005Bi000006t7v3IAA",
  "integrationUsername": "test-rc9gteb1wvn6@example.com",
  "isSandbox": true
}
```

```http
HTTP/1.1 201 Created

{ "orgId": "…", "channelId": "…", "connected": true,
  "verified": { "username": "test-rc9gteb1wvn6@example.com" }, "requestId": "…" }
```

Errors: `401 unauthorized` (no/bad bearer) · `400 invalid_request` (any `clientSecret`/`client_secret`/`clientId` present, or bad IDs/URL) · `422 preauth_required` (`invalid_app_access`/`invalid_grant`: assign `Tubot_JWT_PreAuth`) · `422 identity_mismatch` (grant resolved elsewhere) · `500 jwt_misconfigured` (worker secret missing).

### Auth worker registration (internal, dual-flow)

```http
POST /internal/channels/register
Content-Type: application/json

{
  "teamId": "…", "orgId": "…", "channelId": "…",
  "instanceUrl": "https://….my.salesforce.com",
  "integrationUserId": "005…",
  "integrationUsername": "integration@example.com",
  "isSandbox": false,
  "channelSecret": "<32+ char channel key>"
}
```

Omit `clientSecret` for JWT (shown); send `clientId`+`clientSecret` for a legacy secret row. Both verify the live grant + userinfo match before storing; `201 { "ok": true }`.

### Tenant bridge credential (internal)

```http
POST /internal/bridge/credential
x-bridge-secret: <bridge secret>
Content-Type: application/json

{ "teamId": "…", "orgId": "…", "channelId": "…" }
```

```json
{ "teamId": "…", "orgId": "…", "channelId": "…",
  "instanceUrl": "https://…", "clientId": "3MVG…",
  "clientSecret": null,
  "integrationUserId": "005…",
  "integrationUsername": "integration@example.com",
  "isSandbox": false }
```

JWT rows return `clientSecret: null` with the pair set; legacy rows return the decrypted secret with the pair null.

### Raw Salesforce JWT grant (what Panel posts per mint)

```http
POST https://login.salesforce.com/services/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=<RS256 JWT>
```

JWT claims: `iss` = packaged execution client ID, `sub` = integration username, `aud` = `https://login.salesforce.com` (prod) or `https://test.salesforce.com` (sandbox), `exp` = now + 180s. Followed by `GET /services/oauth2/userinfo` with the access token; `organization_id` + `user_id` must equal the registered org/user.

## Live references

- Packaging org: `test2` (Apex tests 46/46; analyzer 0 sev1–3).
- Subscriber scratch: `tubot-verify-120` (TuBot 1.4.0.5, `04tg5000000FCldAAG`); pre-auth'd user `test-rc9gteb1wvn6@example.com / 005Bi000006t7v3IAA`.
- Staging: `tubot-sf-auth-staging` + `tubot-new-panel-staging` (both carry `TUBOT_JWT_PRIVATE_KEY`).
- Signing key (dev): `/tmp/eca2-jwt-private.pem` (local only; never committed). Prod key rotation: register new cert on the ECA via package upgrade, then replace the worker secret on all four workers.
