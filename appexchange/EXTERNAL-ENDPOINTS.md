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
| Simple Setup policy authorization | `POST /api/v1/salesforce/setup-oauth`, Salesforce callback, and status polling | Org identity, short-lived OAuth state, and a safe completion result; the authorization code and Salesforce access token are handled only by the Panel callback request |

### Data stored by Panel

Team/org/channel mapping, instance URL, integration user ID + username, and
the sandbox bit. There is no per-channel secret: server-to-server calls use
JWT bearer tokens minted on demand with the packaged execution client; the
RSA private key lives only as a Panel worker secret and is never returned
by any Panel API, never logged, and never sent to Salesforce. The setup
authorization table temporarily stores org/state context and an encrypted
PKCE verifier; after completion it keeps only the safe outcome, error
category, and timestamp. It never stores the authorization code or Salesforce
access token. The Panel web app's DAST evidence is in
`tubot-new-panel/security-review/OWASP-ZAP-REPORT.md`: the report records a
production post-cutover confirmation with 0 failed checks, 64 passed, and 2
accepted Medium findings. Its limitations section describes the unauthenticated
coverage and exclusions.

### Retained legacy endpoint metadata

The managed package still contains an inactive `Axiom_API` Remote Site
Setting at `https://api.axiom.co`. The Axiom Apex class is an empty deprecated
stub with no callers. Salesforce blocks removal of the released Remote Site
component without a Partner metadata-removal entitlement. No data is sent to
Axiom. The BT Servant Remote Site file is excluded from package versions by
`.forceignore`; an inactive BT Servant CSP Trusted Site remains for upgrade
compatibility, and current package code has no callout to that host.

OAuth approval records already stored in a subscriber org are Salesforce
org-level grants, separate from these Remote Site and CSP metadata entries.
They are not deleted by a package upgrade. If a legacy connected app is no
longer used, an org administrator can revoke its grant in Salesforce Setup's
Connected Apps OAuth Usage page after confirming it has no other consumers.

## 2. Salesforce APIs used during setup

Simple Setup makes the ECA policy change through the Panel Worker, not from
Apex. After an administrator approves the Salesforce popup, the callback
exchanges the single-use code at Salesforce's OAuth token endpoint, then uses
the temporary access token for Metadata API policy discovery,
`updateMetadata`, and readback at the subscriber org's instance URL. The
callback revokes and discards the token before it returns. It requests only
the `api` scope and treats an unexpected refresh token or revocation failure
as failed setup. Authorization codes and access tokens are not written to
Panel storage or logs; only a non-sensitive outcome is retained for polling.

The final channel-registration JWT grant is a separate check. Panel sends a
short-lived signed assertion to the org's Salesforce token endpoint and
verifies the resulting user through `/services/oauth2/userinfo` before it
stores the channel mapping.

## 3. Salesforce APIs used by Apex in the subscriber org

Simple Setup provisions subscriber records with Apex DML/SOQL in the same
org. Apex also calls the first-party Panel service through Salesforce's Named
Credential to start and poll the policy authorization. It does not call the
Salesforce Metadata API:

- `MessagingChannel`, `Group` (Omni queue), `QueueSobject`, and
  `PermissionSetAssignment` rows for the channel/user setup, plus
  `Tubot_API_Channel__c` for the local link record.
- Read-only SOQL against `ExternalClientApplication`, `PermissionSet`, and
  `PermissionSetAssignment` to confirm the packaged execution client and
  integration-user membership.

The browser popup and metadata policy change are handled by the Panel Worker.
No Salesforce session ID is created, read, or transmitted by the package;
the former Visualforce session bootstrap was removed.

No Salesforce data is sent anywhere except the Panel and Salesforce endpoints
listed above. No analytics, tracking, or third-party SDKs are embedded in the
package.
