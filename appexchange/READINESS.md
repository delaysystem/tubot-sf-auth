# Legacy package AppExchange readiness

Status as of 2026-10-08. This is an internal submission checklist, not a claim
that Salesforce has approved the solution.

## Completed evidence

- Promoted the legacy managed package as non-beta version `1.7.0.1` (`04tg5000000FG4TAAW`).
- Salesforce reports 76% Apex coverage and a passed coverage gate.
- Installed that version in a separate package-validation subscriber and ran
  the targeted Panel Settings permission test successfully.
- Ran Salesforce Code Analyzer with the AppExchange and Recommended Security
  selectors against the legacy package. The report contained zero violations.
- Updated the production Panel Worker configuration and deployed it. The live
  setup endpoint rejects an unauthenticated request. The existing
  user-verified subscriber org was left installed and outside release testing.
- Documented the permission model, OAuth/data flows, endpoints, retained
  inactive Axiom Remote Site Setting, and production/staging separation in
  [`SECURITY-NOTES.md`](SECURITY-NOTES.md),
  [`EXTERNAL-ENDPOINTS.md`](EXTERNAL-ENDPOINTS.md), and
  [`PRODUCTION-ACCESS.md`](PRODUCTION-ACCESS.md).

Salesforce requires a managed package to pass Security Review before it can be
listed. The review wizard also requests Code Analyzer reports; attach the
reports above to the submission. See the [Code Analyzer submission
guide](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/guide/appexchange.html)
and the [Partner Console Security Review
wizard](https://help.salesforce.com/s/articleView?id=release-notes.rn_appexchange_partners_security_review_wizard.htm&language=en_US&release=242&type=5).

## Before submitting

- [ ] In Partner Console, register the managed package and start the Security
  Review for the promoted `1.7.0.1` version. Confirm the wizard accepts that
  version and that no beta or unrelated package is attached.
- [ ] Generate the solution-specific submission checklist in Salesforce's
  wizard and complete each item for this packaged Salesforce app and its
  external Panel web service.
- [ ] Attach the user/setup guide, feature list, endpoint/data-flow document,
  Code Analyzer output, and explanations for accepted findings or
  suppressions. Keep the staging ZAP report labeled as staging; include the
  separate production post-cutover evidence without presenting them as one
  scan.
- [ ] In the ECA section, explain both packaged External Client Apps and each
  OAuth flow, requested scope, callback, and secret-handling boundary. Include
  the public client keys in the submission documentation only; never submit
  client secrets, private signing keys, or live bearer tokens. Salesforce's
  [current ECA/Connected App guidance](https://help.salesforce.com/s/articleView?id=005318040&language=en_US&type=1)
  requires this disclosure and treats the integrations used by the package as
  in-scope for review.
- [ ] Provide working reviewer access and instructions for the Salesforce
  subscriber org and Panel integration. Use a dedicated review account and
  credentials with only the access needed for the documented test paths; do
  not reuse a production administrator account.
- [ ] Resolve or explicitly document the inactive `Axiom_API` Remote Site
  Setting. The package lineage currently prevents removing it without
  Salesforce Partner metadata-removal entitlement. Include the removal
  failure evidence, the no-caller/code-search evidence, and a clear statement
  that the entry is inactive and no Axiom data is sent. Do not describe the
  legacy component as approved by Salesforce.
- [ ] Review every remaining external endpoint and packaged ECA in the final
  submission org, confirm TLS and production-safe error behavior, and ensure
  no stale third-party OAuth grants are mistaken for package dependencies.
- [ ] Finish the listing record separately: product description, supported
  Salesforce editions/features, install and admin guide, privacy policy,
  support contact, pricing/licensing, screenshots, and any required listing
  approvals.

Salesforce's September 2026 guidance says packaged ECAs are required for
ISV-controlled authorization-code callbacks and ISV-owned JWT signing keys,
calls for least-privilege OAuth scopes, and requires disclosure of ECA use and
backend secret protection. TuBot packages both its PKCE approval client and
JWT execution client; the setup flow requests only `api`. Re-check the wizard
and current Salesforce guidance immediately before submission because its
requirements can change.
