# TuBot — External Endpoints & Data Disclosure

For the AppExchange security review questionnaire ("does the app transmit
data outside Salesforce?").

## 1. Panel service (first-party SaaS backend)

- **Base URL:** `https://panel.tubot.lat` (fixed in the
  `Panel_Named_Credential` endpoint and `DEFAULT_PANEL_URL`; same value in
  org config `MCP_Config__c.Panel_Base_Url__c`).
- **Transport:** HTTPS only. Salesforce-side calls use the platform
  External Credential + Named Credential framework (Bearer [REDACTED] stored by
  the platform, never in custom settings or logs).
- **Authentication:** OAuth 2.0 authorization code + PKCE S256 against
  Panel (`/oauth/authorize`, `/api/oauth/poll`, `/api/oauth/token`,
  `/api/oauth/userinfo`, `/api/oauth/revoke`). Panel accounts are backed
  by Kinde (OIDC) on the Panel side.

### Data sent to Panel

| When | Endpoint | Payload |
|---|---|---|
| Panel login | `/api/oauth/*` | OAuth code exchange; Panel profile (email, role, team) read back for the connection card |
| Channel registration (Simple Setup finalize, wizard, or manual connect) | `POST /api/v1/salesforce/channels` | orgId, channelId (MessagingChannel ID), instanceUrl, integration user ID + username, isSandbox. Identity only — client credentials are rejected with 400 |
| Registration verification | `GET /api/v1/salesforce/channels?orgId=` | Bearer-authed listing check (channel ID must be present) |
| Channel removal | `DELETE /api/v1/salesforce/channels/:id` | Revocation |
| Connection card (optional) | `/api/v1/subscription`, `/api/v1/team/members`, `/api/v1/user`, `/api/v1/team/role` | Read-only quota/role display |

### Data stored by Panel

Team/org/channel mapping, instance URL, integration user ID + username, and
the sandbox bit. There is no per-channel secret: server-to-server calls use
JWT bearer tokens minted on demand with the packaged execution client; the
RSA private key lives only as a Panel worker secret and is never returned
by any Panel API, never logged, and never sent to Salesforce. Panel
security posture: see `tubot-new-panel/security-review/OWASP-ZAP-REPORT.md`
(0 failed checks; authenticated journeys covered by code review + Vitest
suite).

## 2. Same-org Salesforce APIs (no third party)

Simple Setup provisions with plain Apex DML/SOQL in the **same org** (no
callouts, no sessions, no Metadata API from Apex):

- `MessagingChannel`, `Group` (Omni queue), `QueueSobject`, and
  `PermissionSetAssignment` rows for the channel/user setup, plus
  `Tubot_API_Channel__c` for the local link record.
- Read-only SOQL against `ExternalClientApplication`,
  `ExtlClntAppOauthConfigurablePolicies`, and `PermissionSetAssignment` to
  confirm the packaged execution client and its pre-authorization.

Token issuance happens Panel-side: Panel posts a signed JWT assertion to
the org's `/services/oauth2/token` (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`)
and verifies the grant against `/services/oauth2/userinfo` before storing
any registration. No Salesforce session ID is ever created, read, or
transmitted by the package; the former Visualforce session bootstrap was
removed.

No Salesforce data is sent anywhere except the endpoints above. No
analytics, tracking, or third-party SDKs are embedded in the package.
