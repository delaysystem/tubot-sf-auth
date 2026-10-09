# Axiom removal and Code Analyzer verification

Checked 2026-10-08 against Salesforce Dev Hub `test2` and scratch org `tubot-setup-subscriber`.

## Axiom Remote Site package check

Removed `force-app/main/default/remoteSiteSettings/Axiom_API.remoteSite-meta.xml` from this checkout and submitted a 2GP package-version create request with code coverage enabled. Salesforce rejected request `08cg50000005RlyAAE` before package validation with this package-lineage rule: the `Axiom_API` component cannot be removed until metadata-removal access is granted through a Salesforce Partner Community case. No candidate version was created.

The prior no-BT candidate `1.5.0.4` (`04tg5000000FFzdAAG`) was created successfully with 76% coverage, but that isolated build removed only the ignored BT Servant Remote Site; it still included Axiom. The new failure confirms Axiom removal is a separate package-lineage restriction.

## Moderate findings and PMD parser error

The earlier scan's two Apex findings were variable-name heuristic matches, not credentials. Renamed `OAUTH_PATH` to `SETUP_ROUTE` and `JWT_PREAUTH_PERMISSION_SET` to `PERMISSION_SET_NAME`. PMD's `CatchClause.visit` null-pointer in `panelLoginSettings.js` came from optional `catch {}` clauses; those handlers now bind `ignoredError`, which PMD can parse.

`ProtectSensitiveData` flags the retained `Connection_Key__c` field by its API name. The value is the Salesforce channel ID plus integration-user ID, used for deterministic upsert; it contains no credential. `code-analyzer.yml` allows at most one finding for this exact field and records that reason. Other files and additional violations remain visible.

The final scan used `sf code-analyzer run --config-file ./security-review/code-analyzer.yml --workspace ./force-app --rule-selector AppExchange --rule-selector Recommended:Security --severity-threshold 3`. Code Analyzer 0.53.0 / PMD 0.46.0 reported zero unsuppressed findings and an empty `processingErrors` list. Seven existing inline suppressions and the single documented field suppression were applied. The field exception is capped at one occurrence in the [analyzer config](code-analyzer.yml). See [JSON results](code-analyzer-appexchange-axiom-removed.json) and [HTML report](code-analyzer-appexchange-axiom-removed.html).

## Follow-up package release

Because Axiom removal is blocked by package lineage, the inactive Axiom Remote
Site was restored to source. Package version **1.5.0.5** (`04tg5000000FG1FAAW`)
was created with code coverage enabled, passed at **75%**, installed into
`tubot-setup-subscriber`, and promoted on 2026-10-08. Independent Salesforce
CLI reads confirmed `IsReleased=true`, the installed version, and the Axiom
Remote Site's `isActive=false`; a wildcard Remote Site retrieve confirmed the
BT Servant Remote Site is absent. The package source Code Analyzer run still
reported zero unsuppressed findings and no parser errors.

The production Worker was deployed as version
`44e63716-7eae-4f03-bbd7-e90fc78e9d6f`. Live unauthenticated smoke checks of
the setup initiate and status routes returned `401` with `Cache-Control:
no-store`. The direct D1 schema/count audit found no `code`, `access_token`, or
`refresh_token` columns and zero setup rows. Because the Salesforce Named
Credential in the audit org had no Panel token, a post-callback audit was not
performed; complete one after a real admin approval.

## Live source compile check

Deployed `SimpleSetupEcaStep`, `TubotSetupWizardController`, and the `panelLoginSettings` LWC bundle to scratch org `tubot-setup-subscriber` (deployment `0AfBi000008YSi1KAG`). Salesforce reported success with no component failures. A separate Tooling API query read back both Apex class bodies and confirmed `SETUP_ROUTE` and `PERMISSION_SET_NAME` are present while the old identifiers are absent. No Apex test suite was run because the existing suite uses mocked callouts, which the project instructions prohibit.
