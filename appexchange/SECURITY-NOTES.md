# TuBot — Static-Analysis Notes for Reviewers (Checkmarx)

Coding rules enforced across the package; known scanner patterns and why
each is safe. All paths below are under
`tubot-sf-package/force-app/main/default/`.

## Enforced rules

- **Sharing:** every controller/service is `with sharing`.
- **CRUD/FLS:** all SOQL uses `WITH USER_MODE`; all DML is `as user`
  (see `SimpleSetupChannelStep.ensureActive`, `activateAndVerify`,
  `PanelSalesforceChannelPreparationService.savePreparation`).
- **No hardcoded tenants:** no org IDs, instance URLs, usernames, or brand
  strings in logic; everything resolves from `UserInfo`, session context,
  the `tubot-sf-auth` tenant profile, or live metadata. The single fixed
  host is the first-party Panel base URL (disclosed in
  `EXTERNAL-ENDPOINTS.md`).
- **Secrets:** there are none on the Salesforce side. Channel registration
  sends identity only; client credentials in the registration payload are
  rejected by Panel with 400. The JWT signing key lives only in Panel
  infrastructure; the org holds only the public certificate inside the
  packaged ECA. Panel OAuth tokens live only in the platform External
  Credential.
- **No session handling:** the package never reads, renders, stores, or
  transmits a Salesforce session ID. No Visualforce page, no
  `UserInfo.getSessionId()` on any setup path, no named-credential
  loopback. Same-org provisioning uses DML/SOQL only.
- **No mock fallbacks:** production paths fail closed with the upstream
  error surfaced verbatim; there are no dummy success payloads.

## Known scanner patterns (false positives with justification)

1. **`@SuppressWarnings` (documented, single-method).** Used only where
   the scanner's suggested pattern cannot apply; each carries a comment
   citing the rule and the reason. No blanket `//NOPMD` remains.
2. **Dynamic endpoint construction.** Panel callout paths are fixed string
   literals appended to the Named Credential (`callout:alias + path`);
   no user input reaches endpoint hosts. Only IDs flow through (bound,
   never concatenated into SOQL — all queries use bind variables).
3. **DML in setup flows.** All setup mutations (permission assignment,
   channel activation, queue membership, local channel record) run
   `as user` / `USER_MODE` after an explicit settings-admin permission
   check (`PanelAuthSupportService.requireSettingsAdmin` /
   `checkManageTubotPermission`), and only after the admin's explicit
   in-app consent (Simple Setup checkbox) or button click.

## Verification gates already run

- `sf code-analyzer run` on all touched files: 0 severity 1–3
  violations (remaining findings are ApexDoc style notes plus one
  pre-existing low-severity query note on an untouched line).
- Apex tests run live in the packaging org on every change: 46/46
  across the five touched test classes (Simple Setup controller/steps,
  channel service, setup wizard, self-org connection).
- Package install verified in a scratch subscriber org, with the JWT
  grant proven live (grant + userinfo match for the pre-authorized
  user; non-members rejected) and blind CLI checks on every mutation.
- Package version build runs the full packaged suite with code coverage
  (`--code-coverage`, required before promote).
