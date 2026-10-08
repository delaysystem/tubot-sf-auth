# Package security and release review

Candidate: TuBot **1.2.0.2** (`04tg5000000F489AAC`), released,
verified 2026-10-06. AppExchange approval is issued by Salesforce after its
security review.

## Static analysis

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

Full `RunLocalTests` with coverage on verification org `tubot-scratch-1773`:
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
class. Both internal orgs (`sdostainless`, `partner`) were upgraded from
1.1.0.4 with data, config, and permission assignments verified intact. See
the [blind CLI install verification](package-install-verification.json).

## External endpoints and data flow

All Panel traffic goes to `https://panel.tubot.lat`: authenticated API
callouts via the `Panel_Named_Credential` (External Credential auth), and
the OAuth login/profile exchange via raw callouts allowlisted in the
`Panel_Tubot` remote site. Subscriber orgs approve these third-party hosts
at install time:

- `panel.tubot.lat` — Panel API (active). This is the only third-party
  host in the package: the deprecated Axiom remote site and the WhatsApp
  gateway CSP trusted site were deleted from source in 1.4.0.6 (neither
  ever shipped in a released version, so no removal entitlement was
  needed) and verified absent from a live subscriber install.

Active Panel tokens live only in External Credentials. The legacy
`Panel_Access_Token__c`, `Panel_Refresh_Token__c`, and `Api_Token__c` fields
are retained empty and unwritten (see below).

## Retained deprecated components

Second-generation managed packages cannot delete components shipped in a
released version without a Salesforce Partner entitlement (1.1.0.4 and
1.0.0.16 are released). These originals were removed from the live
implementation but ship as inert stubs until the metadata-removal
entitlement is granted:

- 9 empty Apex classes (Omni setup cluster, disabled-endpoint controllers,
  Axiom telemetry service, FLS initializer) + 3 empty test classes.
- `HeaderCustomController` keeps its `global` REST surface, still returning
  HTTP 410 for every call.
- 3 legacy token fields, never read or written by packaged code.

(Removed from this list in 1.4.0.6: the `Axiom_API` remote site and the
WhatsApp gateway CSP trusted site — both deleted outright after confirming
no released version contains them.)

Each stub is documented in-source. File a Partner Community case for the
removal entitlement, then delete them in a later version. The archived
originals live in `archive/pre-appexchange-cleanup/`.

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
