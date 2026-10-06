# Security Audit Report — Salesforce Managed Package (force-app)

**Prepared for:** Salesforce AppExchange security review (supporting evidence)
**Target:** `tubot-sf-auth/tubot-sf-package/force-app` — 110 Apex classes,
1 LWC (`panelLoginSettings`), custom objects/settings, permission sets,
Named/External Credentials, remote sites
**Assessment date:** 2026-10-06
**Method:** Salesforce Code Analyzer 5.15.0 (all 25 `Security`-tagged rules:
PMD, eslint, retire-js, regex, flow) plus targeted manual audit of sharing,
SOQL, AuraEnabled authorization, CRUD/FLS, callouts, secrets, and LWC sinks.
**Report version:** 1.0 — 2026-10-06

## 1. Executive summary

The package passed the local security-ruleset scan with **0 High findings
and 0 actionable violations**: 2 Moderate scanner hits, both verified false
positives, and 7 inline suppressions, each verified accurate with an inline
justification. Manual audit of every classic AppExchange risk area (sharing
model, SOQL injection, AuraEnabled authorization, CRUD/FLS, Named
Credentials, secret storage, LWC XSS/open redirect) found the controls
present and correctly applied; no code changes were required.

What reviewers will want to see stated plainly:

- OAuth tokens live only in External Credentials (ConnectApi,
  `encrypted=true`); the legacy plaintext token fields are deprecated,
  unreferenced by any code (verified by grep), and retained solely because
  2GP cannot delete shipped components without Partner approval.
- Every live AuraEnabled path is gated on the `Manage_Tubot_API_Connections`
  custom permission (plus Panel-connection checks on privileged operations);
  several listed endpoints are feature-gate stubs that reject unconditionally.
- No `UserInfo.getSessionId()` usage, no secret logging, no `seeAllData=true`.
- Same-org API traffic goes through a central brokered callout with an
  allowlist guard in Apex (`orgRoot + '/services/'`) and a second
  path-allowlist in the backend worker.

## 2. Scope and limitations

In scope: all Apex, LWC, custom objects/fields, permissions, credentials,
and callout endpoints in `force-app`. Out of scope: the Panel web app
(separate ZAP report) and the backend worker (separate audit report).

Scanner gaps (disclosed, not hidden): PMD threw a parser NPE on
`panelLoginSettings.js`, so PMD rules did not evaluate that file — it was
instead covered by the eslint security rules (clean) and manual sink review
(section 5.6). The Salesforce Graph Engine timed out on 4 entry points
(`MessagingBackupController` ×2, `MessagingBackupService`,
`MessagingConfigurationController`); those classes were covered by manual
review instead. Neither gap produced a known-blind finding: the files in
question were read directly.

## 3. Scanner results

Command (re-runnable):

```
sf code-analyzer run -w tubot-sf-auth/tubot-sf-package/force-app \
  -r "all:Security" -f security.csv -f security.html
```

Result: **2 Moderate violations, 0 High**. A second run with
`--no-suppressions` surfaced 9 total (the same 2 plus the 7 suppressed
items below) — i.e. nothing is hidden.

### 3.1 Scanner hit 1 — FALSE POSITIVE

`pmd:AvoidHardcodedCredentialsInFieldDecls` on
`TuBotSelfOrgConnectionController.cls:2` (`SELF_OAUTH_ROUTE`). The flagged
value is the URL path constant `'/api/v1/salesforce/self-oauth'`, matched
only on the substring "OAUTH". Not a credential; no action.

### 3.2 Scanner hit 2 — FALSE POSITIVE

`pmd:ProtectSensitiveData` on `Tubot_API_Channel__c.Connection_Key__c`.
Verified by read: the field stores `channelId + ':' + userId` (two
Salesforce record IDs, written in
`PanelSalesforceChannelPreparationService`), used as an external-ID lookup
key. Not authentication material; no action.

### 3.3 The 7 suppressions — all verified accurate

Each carries a `<!-- code-analyzer-suppress(pmd:ProtectSensitiveData) -->`
marker plus a justification comment, and each justification was verified:

| Field | Comment claim | Verification |
|---|---|---|
| `MCP_Config__c.Panel_Access_Token__c` | Deprecated, never read/written; tokens in External Credentials | Zero references in all classes/LWC (grep) |
| `MCP_Config__c.Panel_Refresh_Token__c` | Same as above | Zero references (grep) |
| `Messaging_Config__c.Api_Token__c` | Deprecated, never read/written | Zero references (grep) |
| `Messaging_Config__c.Agent_Keyword__c` | Chat trigger keyword, not a secret | Holds `'agent'`-style keywords |
| `Messaging_Config__c.Reactivation_Keyword__c` | Chat trigger keyword, not a secret | Holds `'reset'`-style keywords |
| `Tubot_API_Channel__c.Assignment_Id__c` | PermissionSetAssignment record Id | Actively used as an Id, correctly described |
| `Tubot_API_Channel__c.Assignment_Owned__c` | Boolean flag, name match only | Actively used boolean, correctly described |

## 4. Manual audit — data access and Apex entry points

### 4.1 Sharing model — PASS

Four non-test `without sharing` classes, each justified:

- `PackagePostInstallHandler` (InstallHandler performing org-default setup;
  documented in-file).
- `PackageAdminPermissionAssignmentService` (`@future` post-install grant
  of one fixed permission set to the installer; documented).
- `HeaderCustomController` (deprecated `global` REST stub returning a
  static "disabled" message; retained for 2GP compat with removal note;
  performs no data access).
- `TubotAxiomTelemetryService` (empty deprecated stub, never invoked).

All other classes are `with sharing` / `inherited sharing`. The single
`Database.upsert(..., AccessLevel.SYSTEM_MODE)` (OAuth connection record in
`PanelOAuthExchangeService.saveConnection`) writes package config inside an
admin-gated login flow — an accepted pattern, not user-data access.

### 4.2 SOQL injection — PASS

Four `Database.query` sites, all safe: two build queries from static
fragments over fixed objects with `AccessLevel.USER_MODE`; one escapes
joined field names and runs `USER_MODE`; one queries the
`Tubot_Setting__mdt` custom metadata type whose object/field names come
from a hardcoded internal schema map (escaped regardless). No user input
reaches any query string. PMD `ApexSOQLInjection` and `ApexCRUDViolation`
report nothing.

### 4.3 AuraEnabled authorization — PASS

Nine controller classes expose AuraEnabled methods. Every live path funnels
into one of three centralized gates — `requireSettingsAdmin()`,
`requireAdmin()` (settings permission + Panel connection + edit rights),
or `requireConnectionPermission()` — all rooted in the
`Manage_Tubot_API_Connections` custom permission via `FeatureManagement`.
Verified specifics: permission-set assignment assigns one fixed read-only
set with `WITH USER_MODE` + `USER_MODE` DML; channel connect/prepare/
disconnect gate in both controller and delegate service; backup
create/restore/delete/detail gate via service; destructive and credential
operations additionally verify target existence, active users, and
same-team ownership (a channel already tied to another Panel team is
rejected). Several listed AuraEnabled methods (`saveTubotSettings`,
`setChannelOmniFlow`, T2/Omni capacity setters) are feature-gate stubs that
reject unconditionally — dead surface, no risk.

### 4.4 CRUD/FLS — PASS

Sampled DML/SOQL across controllers and services consistently uses
`WITH USER_MODE` / `AccessLevel.USER_MODE` (channel preparation,
connection, assignment, backup, restore, permission checks). No FLS bypass
outside the single config write noted in 4.1.

## 5. Manual audit — integration surface

### 5.1 Callouts and Named Credentials — PASS with one documented exception

Authenticated Panel API traffic flows through
`PanelAuthSupportService.executePanelCallout`, which enforces the settings
gate, requires a `/`-rooted path, and sends via `callout:<alias>` against
the packaged `Panel_Named_Credential` (SecuredEndpoint on
`https://panel.tubot.lat`, auth from `Panel_External_Credential`).
Three callouts legitimately bypass it: the OAuth token exchange, the
pre-login code poll, and the first-login profile fetch — none can use the
credential because no credential exists yet at that point
(chicken-and-egg), documented in a detailed `//NOPMD` comment citing the
verified uncommitted-work constraint and the remote-site allowlist entry.
Same-org Tooling/REST traffic goes through `TuBotSelfOrgApiCallout`, which
re-checks the connection permission and forwards to a broker that performs
the call server-side — Apex never sees tokens or session IDs.

### 5.2 SSRF guards — PASS (defense in depth)

`TuBotSelfOrgConnectionController.sendSalesforceApiRequest` rejects any
endpoint not starting with `Url.getOrgDomainUrl() + '/services/'`; every
`baseUrl` in the package derives from `Url.getOrgDomainUrl()` (verified at
each source), never from user input; endpoint paths at dynamic-looking
call sites are hardcoded literals. The backend broker applies a second,
stricter path allowlist before executing.

### 5.3 Secret storage — PASS

Panel tokens are written only via `ConnectApi.NamedCredentials` with
`encrypted=true` (`PanelExternalCredentialTokenService`); logout writes
`'revoked'`. ECA client secrets are validated, sent once to Panel over the
authenticated callout, and never persisted locally. No secrets in debug
logs (verified: the one credential-adjacent log prints names and error
text only). The deprecated plaintext token fields are unreferenced (3.3).

### 5.4 No session-ID handling — PASS

Zero `UserInfo.getSessionId()` references and exactly one `Bearer` header
construction (the documented pre-auth profile callout in 5.1). The
`sessionTokenOverride` parameter threaded through backup/restore entry
points is accepted but never consumed — no header, query, or body sink
exists (verified by exhaustive grep), and the packaged LWC never sends it.
Dead plumbing, not a vulnerability; flagged as hygiene (section 6).

### 5.5 OAuth/PKCE correctness — PASS

The LWC generates the PKCE challenge client-side; Apex validates the
redirect URI by exact match against the configured Panel origin, requires
a non-blank verifier, exchanges codes over TLS, validates the token
response shape, and confirms the Panel profile (role/team/email) before
persisting the connection. The self-org authorization URL returned to the
browser is validated by `isSalesforceAuthorizationUrl` before use.

### 5.6 LWC (`panelLoginSettings`, 1369-line JS) — PASS

No `innerHTML`/`outerHTML`/`lwc:dom="manual"`/`eval`; no `fetch`/`XHR`
(the component talks only to AuraEnabled methods); redirects assign only
server-returned authorization URLs, a hardcoded Setup path, or the
server-constrained Panel base URL (default `https://panel.tubot.lat`,
overridable only from server status; Apex independently validates any
configured origin as https/no-credentials/no-port/root-path). The PMD
parser NPE on this file is a scanner limitation, covered here by direct
review; eslint security rules report nothing on it.

## 6. Non-blocking hygiene notes (no action required for review)

- Two remote sites (`Axiom_API`, `IGNORE_BT_Servant_WhatsApp_Gateway`) and
  one CSP trusted site (`BT_Servant_Gateway_CSP`) have no code references —
  orphaned entries from retired integrations. The telemetry class itself is
  an empty deprecated stub, so no data leaves the org through them.
- `sessionTokenOverride` (5.4) is dead client-to-server plumbing; safe to
  remove in a future cleanup (kept out of this report's scope to avoid
  churning AuraEnabled signatures).
- The deprecated `global` REST stub (4.1) stays `without sharing` only
  because 2GP forbids narrowing a released global signature; it performs
  no logic or data access.

## 7. Evidence index

- `code-analyzer-security.csv` — full ruleset run (2 Moderate FPs).
- `code-analyzer-security-nosuppressions.csv` — run with suppressions
  disabled (9 Moderate: the same 2 plus the 7 verified suppressions).
- Re-run command in section 3 (Code Analyzer 5.15.0, `sf` 2.150.6).
- Fix status: no code changes resulted — every scanner hit and every
  manual checkpoint resolved to false-positive, verified-accurate
  suppression, or confirmed control.
