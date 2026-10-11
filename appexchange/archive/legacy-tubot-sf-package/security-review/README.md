# Package security and release review

Candidate: TuBot **1.2.0.2** (`04tg5000000F489AAC`), released,
verified 2026-10-06. AppExchange approval is issued by Salesforce after its
security review.

## Latest package release

TuBot **1.5.0.5** (`04tg5000000FG1FAAW`) was promoted on 2026-10-08 with
**75% packaged Apex coverage** and `HasPassedCodeCoverageCheck=true`. The
package installed successfully in the `tubot-setup-subscriber` scratch org;
blind readback confirmed the installed version, the inactive Axiom Remote
Site, and the absence of the BT Servant Remote Site. This release is not yet
approved for an AppExchange listing; Salesforce Security Review remains
pending.

The OAuth storage schema audit found no `code`, `access_token`, or
`refresh_token` columns. The setup table had zero rows at audit time, so this
does not constitute a post-callback storage audit. The real Panel-authenticated
audit still needs a completed OAuth callback in a connected test org.

The current 1.5.0 source check, including the Axiom removal attempt and the
latest Code Analyzer report, is documented in
[Axiom removal and Code Analyzer verification](axiom-removal-code-analyzer-check.md).

## Static analysis for released 1.2.0.2

Salesforce Code Analyzer (Recommended rules, documented suppressions
honored) against `./force-app`, matching the package bundle via
`.forceignore`:

| Severity | Findings |
| --- | ---: |
| Critical | 0 |
| High (sev2) | 0 |
| Moderate (sev3) | 2 |
| Low | 298 |
| Info | 8 |

[Complete analyzer report](code-analyzer.json). Finding paths are repository
paths. The two findings above Low, with justifications:

1. `@lwc/lwc/no-async-operation` (Moderate) in
   `panelLoginSettings.js:432` — a `setInterval` status poll with cleanup on
   disconnect; standard LWC pattern, no security impact.
2. `CyclomaticComplexity` (Moderate) in
   `PanelAuthSupportService.cls:50` — `executePanelCallout` complexity 14
   from the namespaced/unnamespaced credential fallback; code-smell only.

One documented `//NOPMD ApexSuggestUsingNamedCred` suppression covers the
Panel login profile callout in `PanelOAuthExchangeService.cls`: the runtime
bearer is minted in that same flow, and storing it in External Credentials
first performs DML that blocks the subsequent callouts (verified live on a
scratch org), while endpoint-only named credentials cannot deploy
(`SecuredEndpoint` requires an `Authentication` parameter). The host is
allowlisted in the `Panel_Tubot` remote site, and
`PanelOAuthBearerSecurityTest` locks the intended auth behavior.

No SOQL injection, no hardcoded org IDs or secrets, no CRUD/FLS violations.
Dynamic queries use `AccessLevel.USER_MODE` with `escapeSingleQuotes`; the
only two `without sharing` classes are the install handler and its permission
assignment service.

## Release coverage

Full `RunLocalTests` with coverage on a verification scratch org:
**98/98 tests passed**, cumulative coverage **79.5%** (2361/2971 lines),
above the 75% 2GP promotion threshold. No packaged triggers exist, so the
100% trigger rule does not apply. Individual classes below 75% remain; the
cumulative metric is the Salesforce gate.

The 2GP packaging build for 1.2.0.2 reports **76%** with
`HasPassedCodeCoverageCheck=true`.

[Apex coverage results](apex-tests.json) include per-class line coverage and
the packaged test-class list.

## Install verification

1.2.0.2 installed cleanly in a fresh namespaceless scratch org. Independent
CLI queries confirmed the installed version, post-install permission
assignment, org defaults, the `https://panel.tubot.lat` endpoint cutover
(field default, remote site, named credential), null deprecated token
fields, the inactive Axiom remote site, and the new bearer-security test
class. Org identifiers, aliases, usernames, and record IDs were redacted from
the archived CLI verification artifact. See the
[blind CLI install verification](package-install-verification.json).

## External endpoints and data flow

All Panel traffic goes to `https://panel.tubot.lat`: authenticated API
callouts via the `Panel_Named_Credential` (External Credential auth), and
the OAuth login/profile exchange via raw callouts allowlisted in the
`Panel_Tubot` remote site. The active Panel endpoint is `panel.tubot.lat`.
The released package also contains the inactive `Axiom_API` Remote Site.
Salesforce rejected removal during 2GP version creation because it is in the
package lineage, so 1.5.0.5 retains it inactive. A Partner Community case is
required to request metadata-removal entitlement before removing it in a later
version. The BT Servant Remote Site source file is prefixed `IGNORE_` and
excluded by `.forceignore`. An inactive BT Servant CSP trusted-site component
remains in source for upgrade compatibility; packaged code has no callout to
that host.

Active Panel tokens live only in External Credentials. The legacy
`Panel_Access_Token__c`, `Panel_Refresh_Token__c`, and `Api_Token__c` fields
are retained empty and unwritten (see below).

## Retained legacy metadata

The unused Apex stubs, disabled feature endpoints, old setup screens, and
retired REST controller have been removed from the current source. A managed
package upgrade may still require Salesforce Partner approval to delete
components already present in released versions. The archived pre-cleanup
implementations remain in `archive/pre-appexchange-cleanup/`.

The current source still retains metadata that has not been removed from a
released package:

- `Axiom_API` Remote Site, inactive in the released package.
- Inactive BT Servant CSP trusted site retained for upgrade compatibility.
- 3 legacy token fields, never read or written by packaged code.

## Repeatable checks

Full suite with coverage against an org containing the candidate source:

```sh
sf apex run test --test-level RunLocalTests --code-coverage --target-org <verification-org>
```

Static analysis:

```sh
sf code-analyzer run --workspace ./force-app --rule-selector Recommended
```

Documented suppressions are honored: the single `//NOPMD` carries its
justification in-source (see above). Use `--no-suppressions` to audit the
raw findings.
